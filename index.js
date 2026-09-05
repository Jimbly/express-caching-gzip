/* eslint no-restricted-syntax:off */
const assert = require('assert');
const fs = require('fs');
const { dirname, resolve } = require('path');
const parseUrl = require('parseurl')
const { pipeline } = require('stream');
const { createBrotliCompress, createGzip, constants: zlibConstants } = require('zlib');
const resolvePath = require('resolve-path')
const serveStatic = require('serve-static');
const mime = require('mime-types');
const { sanitizeOptions, defaultExts } = require('./util/options');
const { findEncodingOrder } = require('./util/encoding-selection');

const { abs } = Math;

function sendBadRequest(res, message) {
  if (typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(400).send(message);
    return;
  }

  res.statusCode = 400;

  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }

  res.end(message);
}

const ext_regex = /(\.[a-zA-Z0-9_-]+)$/;

function forwardSlashes(pathname) {
  return pathname.replace(/\\/g, '/');
}

function callEach(arr, ...args) {
  for (let ii = 0; ii < arr.length; ++ii) {
    arr[ii](...args);
  }
}

/**
 * TODO: add desc
 * @param { string } root: directory to statically serve files from
 * @param { string | null } cacheDir: directory to cache compressed versions of files in
 * @param { expressCachingGzip.ExpressCachingGzipOptions } options: options to change module behaviour
 * @returns express middleware function
 */
function expressCachingGzipMiddleware(root, cacheDir, options) {
  assert(typeof root === 'string', 'root is required');
  assert(typeof cacheDir === 'string' || cacheDir === null, 'cacheDir is required (may be null)');
  root = forwardSlashes(resolve(root));
  cacheDir = cacheDir ? forwardSlashes(resolve(cacheDir)) : null;
  let opts = sanitizeOptions(options);
  let serveStaticRoot = serveStatic(root, opts.serveStatic || null);
  let serveStaticCache = cacheDir ? serveStatic(cacheDir, opts.serveStatic || null) : null;
  let compressions = [];

  function findCompressionByName(encodingName) {
    for (let compression of compressions) {
      if (compression.encodingName === encodingName) {
        return compression;
      }
    }

    return null;
  }

  let timeEpsilon = opts.timeEpsilon || 250;
  function sameTime(ms1, ms2) {
    return abs(ms1 - ms2) <= timeEpsilon;
  }

  function compressorGzip(pathin, pathout, done) {
    pipeline(
      fs.createReadStream(pathin),
      createGzip(),
      fs.createWriteStream(pathout),
      (err) => done(err)
    );
  }

  function compressorBrotli(pathin, pathout, done) {
    pipeline(
      fs.createReadStream(pathin),
      createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_DEFAULT_QUALITY,
        },
      }),
      fs.createWriteStream(pathout),
      (err) => done(err)
    );
  }

  function Compression(encodingName, fileExtension, compressor) {
    this.encodingName = encodingName;
    this.fileExtension = '.' + fileExtension;
    this.compressor = compressor;
  }

  function registerCompression(encodingName, fileExtension, compressor) {
    if (!findCompressionByName(encodingName)) {
      compressions.push(new Compression(encodingName, fileExtension, compressor));
    }
  }

  function registerCompressionsFromOptions() {
    if (opts.customCompressions && opts.customCompressions.length > 0) {
      for (let customCompression of opts.customCompressions) {
        registerCompression(
          customCompression.encodingName,
          customCompression.fileExtension,
          customCompression.compressor,
        );
      }
    }

    if (opts.enableBrotli) {
      registerCompression('br', 'br', compressorBrotli);
    }

    registerCompression('gzip', 'gz', compressorGzip);
  }

  function convertToCompressedRequest(req, res, compression) {
    let type = mime.lookup(req.path);
    let charset = mime.charsets.lookup(type);
    let search = req.url.split('?').splice(1).join('?');

    if (search !== '') {
      search = '?' + search;
    }

    req.url = req.path + compression.fileExtension + search;
    res.setHeader('Content-Encoding', compression.encodingName);
    res.setHeader(
      'Content-Type',
      type + (charset ? '; charset=' + charset : '')
    );
  }

  function changeUrlFromDirectoryToIndexFile(req) {
    const parts = req.url.split('?');
    if (opts.index && parts[0].endsWith('/') && parseUrl.original(req).pathname.endsWith('/')) {
      parts[0] += opts.index;
      req.url = parts.length > 1 ? parts.join('?') : parts[0];
    }
  }



  registerCompressionsFromOptions();
  let supportedEncodings = Object.values(compressions).map((a) => a.encodingName);

  let cacheRequests = Object.create(null);

  function expressCachingGzip(req, res, next) {
    let savedURL = req.url;
    changeUrlFromDirectoryToIndexFile(req);

    let clientsAcceptedEncodings = req.headers['accept-encoding'];

    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (e) {
      return void sendBadRequest(res, e.message);
    }
    if (!pathname) {
      pathname = '/';
    }
    try {
      pathname = resolvePath(root, pathname.slice(1));
    } catch (e) {
      return void sendBadRequest(res, e.message);
    }

    pathname = forwardSlashes(pathname);
    assert(pathname.startsWith(root));

    let extm = pathname.match(ext_regex);
    let ext = extm ? extm[1] : null;
    let allowCompress = true;
    if (ext) {
      allowCompress = !opts.nocompressExts[ext.toLowerCase()];
    }

    function fallThrough() {
      serveStaticRoot(req, res, function (err) {
        req.url = savedURL;
        next(err);
      });
    }

    if (allowCompress) {
      // The Vary Header is required for caching proxies to work properly
      // Needs to be set if this request could _ever_ serve a compressed version,
      // even if there is none currently.
      res.setHeader('Vary', 'Accept-Encoding');
    } else {
      return void fallThrough();
    }

    fs.stat(pathname, function (err, uncompressedStat) {
      let uncompressedExists = !err;

      // check for pre-compressed files of the appropriate type, in order, dynamically compress if needed
      let encodings = findEncodingOrder(clientsAcceptedEncodings, opts.orderPreference, supportedEncodings);
      let encodingIndex = 0;
      function checkNextEncoding() {
        if (encodingIndex >= encodings.length) {
          return void fallThrough();
        }
        let encoding = encodings[encodingIndex++];
        let compression = findCompressionByName(encoding);
        assert(compression);
        let precompressedName = pathname + compression.fileExtension;
        let cachedName = cacheDir ? precompressedName.replace(root, cacheDir) : null;
        assert(cachedName !== precompressedName);

        function serveFromCache(err) {
          if (err) {
            // there was an error generating the cache
            return void checkNextEncoding();
          }
          convertToCompressedRequest(req, res, compression);
          serveStaticCache(req, res, function (err) {
            req.url = savedURL;
            next(err);
          });
        }

        function updateCache() {
          let cacheReq = cacheRequests[pathname] = {
            cbs: [],
          };

          function done(err) {
            delete cacheRequests[pathname];
            callEach(cacheReq.cbs, err);
          }

          assert(cacheDir);
          fs.mkdir(dirname(cachedName), { recursive: true }, function (err) {
            if (err) {
              console.error(`Creating dir for "${cachedName}" failed: ${err}`);
              return void done(err);
            }
            compression.compressor(pathname, cachedName, function (err) {
              if (err) {
                console.error(`Compressing ${pathname} to ${cachedName} failed: ${err}`);
                return void done(err);
              }
              fs.utimes(cachedName, uncompressedStat.atime, uncompressedStat.mtime, function (err) {
                if (err) {
                  console.error(`Updating timestamps on ${cachedName} failed: ${err}`);
                  return void done(err);
                }
                done();
              });
            });
          });
          return cacheReq;
        }

        fs.access(precompressedName, fs.constants.R_OK, function (err) {
          if (!err) {
            // pre-compressed exists, use it!
            convertToCompressedRequest(req, res, compression);
            return void fallThrough();
          }
          // does not exist
          if (!uncompressedExists || !compression.compressor || !cacheDir) {
            // uncompressed also doesn't exist, or, no compressor, cannot dynamically compress
            return void checkNextEncoding();
          }
          // use and/or update cache
          let cacheReq = cacheRequests[pathname];
          function maybeServeCacheLater() {
            if (opts.compressBeforeResponse) {
              cacheReq.cbs.push(serveFromCache);
            } else {
              // send what we've got for now
              checkNextEncoding();
            }
          }
          if (cacheReq) {
            // someone is currently writing to the cache
            return void maybeServeCacheLater();
          }
          // check if cache exists
          assert(cachedName);
          fs.stat(cachedName, function (err, cachedStat) {
            let cacheExists = !err;
            if (cacheRequests[pathname]) {
              // someone else started compressing it while we checked
              return void maybeServeCacheLater();
            }
            if (cacheExists && sameTime(cachedStat.mtimeMs, uncompressedStat.mtimeMs)) {
              return void serveFromCache();
            }
            // cache needs to be created
            cacheReq = updateCache();
            maybeServeCacheLater();
          });
        });
      }
      checkNextEncoding();
    });
  }

  function waitForCachingToFinish(done) {
    let count = 1;
    function next() {
      --count;
      if (!count) {
        done();
      }
    }
    for (let key in cacheRequests) {
      ++count;
      cacheRequests[key].cbs.push(next);
    }
    next();
  }
  expressCachingGzip.waitForCachingToFinish = waitForCachingToFinish;
  return expressCachingGzip;
}

function cleanupCache(root, cacheDir, timeEpsilon, done) {
  assert(typeof root === 'string', 'root is required');
  assert(typeof cacheDir === 'string', 'cacheDir is required');
  let now = Date.now();
  if (typeof timeEpsilon === 'function') {
    done = timeEpsilon;
    timeEpsilon = undefined;
  }
  timeEpsilon = timeEpsilon || 250;

  function sameTime(ms1, ms2) {
    return abs(ms1 - ms2) <= timeEpsilon;
  }

  let pruned = 0;
  function walk(dir, next) {
    let cachePath = cacheDir + '/' + dir;
    let rootPath = root + '/' + dir;
    if (cachePath.endsWith('/')) {
      cachePath = cachePath.slice(0, -1);
      rootPath = rootPath.slice(0, -1);
    }
    fs.readdir(cachePath, function (err, files) {
      if (err) {
        if (dir) { // don't warn if root does not yet exist
          console.warn(`Error walking ${cachePath}: ${err}`);
        }
        return void next();
      }
      let idx = 0;
      function checkNext() {
        if (idx === files.length) {
          return void next();
        }
        let filename = files[idx++];
        let cacheFullPath = cachePath + '/' + filename;
        fs.stat(cacheFullPath, function (err, stat) {
          if (err) {
            console.warn(`Error statting ${cacheFullPath}: ${err}`);
            return void checkNext();
          }
          if (stat.isDirectory()) {
            return void walk(dir + '/' + filename, checkNext);
          }
          if (stat.mtimeMs > now) {
            // written after this process started, ignore
            return void checkNext();
          }
          let extIdx = filename.lastIndexOf('.');
          assert(extIdx !== -1);
          let rootname = filename.slice(0, extIdx);
          fs.stat(rootPath + '/' + rootname, function (err, rootstat) {
            if (err || !sameTime(rootstat.mtimeMs, stat.mtimeMs)) {
              // source doesn't exist, or not the same time, prune the compressed file
              ++pruned;
              return void fs.unlink(cacheFullPath, function (err) {
                if (err) {
                  console.warn(`Error deleting ${cacheFullPath}: ${err}`);
                }
                checkNext();
              });
            }
            checkNext();
          });
        });
      }
      checkNext();
    });
  }
  walk('', function () {
    let msg = '';
    if (pruned) {
      msg = `Cleaned ${pruned} invalidated cache entries`;
      console.log(msg);
    }
    if (done) {
      done(null, msg);
    }
  });
}

module.exports = expressCachingGzipMiddleware;
module.exports.defaultExts = defaultExts;
module.exports.cleanupCache = cleanupCache;
