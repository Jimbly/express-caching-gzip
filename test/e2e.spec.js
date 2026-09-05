/* globals it,describe,afterEach */
/* eslint dot-notation:off,no-unused-expressions:off */
const expect = require('chai').expect;

const express = require('express');
const fs = require('fs');
const { gunzipSync } = require('zlib');
const request = require('request').defaults({ followRedirect: false });
const expressCachingGzip = require('../index');

function gunzip(buf) {
    try {
        return gunzipSync(buf).toString('utf8');
    } catch (err) {
        return `gunzipSync error: "${err.message}"`;
    }
}

describe('End to end', function () {
    let server;
    let cacheDir = __dirname + '/compress-cache';

    let binaryMode = false;
    let middleware;
    /**
     *
     * @param {expressStaticGzip.ExpressStaticGzipOptions} options
     */
    function setupServer(options, dir, mount) {
        dir = dir || 'wwwroot';
        mount = mount || '/';
        const app = express();
        binaryMode = options?.compressBeforeResponse;
        middleware = expressCachingGzip(__dirname + '/' + dir, cacheDir, {
            ...(options || {})
        });
        app.use(mount, middleware);
        server = app.listen(8181);
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true });
        }
    }

    /**
     *
     * @param {string} fileName
     * @param {request.Headers} headers
     * @returns {Promise<request.Response>}
     */
    function requestFile(fileName, headers) {
        return new Promise((resolve, reject) => {
            let opts = headers ? { headers } : null;
            opts = binaryMode ? {...(opts) || {}, encoding: null } : opts;
            request('http://localhost:8181' + fileName, opts,
                function (err, resp, body) {
                    if (err) {
                        reject(err);
                    } else {
                        resp.body = body;
                        resolve(resp);
                    }
                });
        });
    }

    afterEach(function () {
        server.close();
        return new Promise((resolve, reject) => {
            middleware.waitForCachingToFinish(resolve);
        });
    });

    it('should contain right headers', function () {
        setupServer();

        return requestFile('/', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['vary']).to.equal('Accept-Encoding');
            expect(resp.headers['content-encoding']).to.equal('gzip');
            expect(resp.headers['content-type']).to.equal('text/html; charset=UTF-8');
        });
    });

    it('should return file not found', function () {
        setupServer();

        return requestFile('/notFound.html').then(resp => {
            expect(resp.statusCode).to.equal(404);
        });
    });

    it('should handle index option false', function () {
        setupServer({ index: false });

        return requestFile('/').then(resp => {
            expect(resp.statusCode).to.equal(404);
        });
    });

    it('should handle index option false, serveStatic.index overwritten', function () {
        setupServer({ index: false, serveStatic: { index: "index.html" } });

        return requestFile('/').then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal("index.html")
        });
    });

    it('should handle index option default', function () {
        setupServer();

        return requestFile('/', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should handle index option default with queryargs', function () {
        setupServer();

        return requestFile('/?foo=bar', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should handle index option set', function () {
        setupServer({ index: 'main.js', enableBrotli: true });

        return requestFile('/', { 'accept-encoding': 'br' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js.br');
        });
    });

    it('should redirect to a directory with trailing slash with non-root mount', function() {
        setupServer(null, null, '/custom');
        return requestFile('/custom', { 'accept-encoding': 'br' }).then(resp => {
            expect(resp.statusCode).to.equal(301);
            expect(resp.headers['location']).to.equal('/custom/');
        });
    });

    it('should serve compressed index with non-root mount', function() {
        setupServer(null, null, '/custom');
        return requestFile('/custom/', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should serve compressed file with non-root mount', function() {
        setupServer({ enableBrotli: true }, null, '/custom');
        return requestFile('/custom/main.js', { 'accept-encoding': 'br ' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js.br');
        });
    });

    it('should not serve brotli if not enabled', function () {
        setupServer();

        return requestFile('/', { 'accept-encoding': 'br' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html');
        });
    });

    it('should not serve brotli, but gzip', function () {
        setupServer();

        return requestFile('/', { 'accept-encoding': 'br,gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should serve gzip even if uncompressed does not exist', function () {
        setupServer();

        return requestFile('/gzonly', { 'accept-encoding': 'br,gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('gzonly.gz');
        });
    });

    it('should serve brotli even if uncompressed does not exist', function () {
        setupServer({ enableBrotli: true });

        return requestFile('/gzbronly', { 'accept-encoding': 'br,gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('gzbronly.br');
        });
    });

    it('should handle queryargs on precompressed', function () {
        setupServer({ enableBrotli: true });

        return requestFile('/gzbronly?foo=bar', { 'accept-encoding': 'br,gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('gzbronly.br');
        });
    });

    const runtimeFile = __dirname + '/wwwroot/runtime.txt';
    function cleanupRuntime() {
        if (fs.existsSync(runtimeFile)) {
            fs.unlinkSync(runtimeFile);
        }
        if (fs.existsSync(runtimeFile + '.gz')) {
            fs.unlinkSync(runtimeFile + '.gz');
        }
    }
    it('should handle file additions', function () {
        cleanupRuntime();
        setupServer();
        fs.writeFileSync(runtimeFile, 'runtime.txt');
        fs.writeFileSync(runtimeFile + '.gz', 'runtime.txt.gz');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('runtime.txt.gz');
        });
    });

    it('should handle file changes', function () {
        cleanupRuntime();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt');
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt.gz', 'runtime.txt.gz');
        setupServer();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt-2');
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt.gz', 'runtime.txt.gz-2');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('runtime.txt.gz-2');
        });
    });

    it('should handle removing compressed files', function () {
        cleanupRuntime();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt');
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt.gz', 'runtime.txt.gz');
        setupServer();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt-2');
        fs.unlinkSync(__dirname + '/wwwroot/runtime.txt.gz');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('runtime.txt-2');
        });
    });

    it('should handle adding compressed files', function () {
        cleanupRuntime();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt');
        setupServer();
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt-2');
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt.gz', 'runtime.txt.gz-2');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('runtime.txt.gz-2');
        });
    });

    it('should dynamically compress', function () {
        setupServer({ compressBeforeResponse: true });

        return requestFile('/dynamic.js', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.equal('gzip');
            expect(gunzip(resp.body)).to.equal('dynamic.js');
        });
    });

    it('should dynamically compress eventually', function () {
        setupServer();

        return requestFile('/dynamic.js', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.be.undefined;
            expect(resp.body).to.equal('dynamic.js');
            return new Promise((resolve, reject) => {
                binaryMode = true;
                middleware.waitForCachingToFinish(function () {
                    requestFile('/dynamic.js', { 'accept-encoding': 'gzip' }).then(resp2 => {
                        expect(resp2.statusCode).to.equal(200);
                        expect(resp2.headers['content-encoding']).to.equal('gzip');
                        expect(gunzip(resp2.body)).to.equal('dynamic.js');
                        resolve();
                    });
                });
            });
        });
    });

    it('should dynamically compress with queryargs', function () {
        setupServer({ compressBeforeResponse: true });

        return requestFile('/dynamic.js?foo=bar', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.equal('gzip');
            expect(gunzip(resp.body)).to.equal('dynamic.js');
        });
    });

    it('should not dynamically compress PNGs by default', function () {
        setupServer({ compressBeforeResponse: true });

        return requestFile('/png.png', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.be.undefined;
        });
    });

    it('should not dynamically compress according to exts', function () {
        setupServer({ compressBeforeResponse: true, nocompressExts: ['.js'] });

        return requestFile('/dynamic.js', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.be.undefined;
        });
    });

    it('should handle changes to dynamically compressed files', function () {
        cleanupRuntime();
        setupServer({ compressBeforeResponse: true, timeEpsilon: 1 });
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.equal('gzip');
            expect(gunzip(resp.body)).to.equal('runtime.txt');

            return new Promise((resolve, reject) => {
                setTimeout(function () {
                    fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt-2');
                    requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp2 => {
                        expect(resp2.statusCode).to.equal(200);
                        expect(resp.headers['content-encoding']).to.equal('gzip');
                        expect(gunzip(resp2.body)).to.equal('runtime.txt-2');
                        resolve();
                    });
                }, 2); // longer than above epsilon
            });
        });
    });

    it('should handle adding a precompressed file', function () {
        cleanupRuntime();
        setupServer({ compressBeforeResponse: true });
        fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['content-encoding']).to.equal('gzip');
            expect(gunzip(resp.body)).to.equal('runtime.txt');

            fs.writeFileSync(__dirname + '/wwwroot/runtime.txt', 'runtime.txt-2');
            fs.writeFileSync(__dirname + '/wwwroot/runtime.txt.gz', 'runtime.txt.gz-2');
            binaryMode = false;
            return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp2 => {
                expect(resp2.statusCode).to.equal(200);
                expect(resp2.body).to.equal('runtime.txt.gz-2');
            });
        });
    });

    it('should serve brotli', function () {
        setupServer({ enableBrotli: true });

        return requestFile('/', { 'accept-encoding': 'br' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.br');
        });
    });

    it('should serve custom compression', function () {
        setupServer({ customCompressions: [{ encodingName: 'test', fileExtension: 'tst' }] });

        return requestFile('/main.js', { 'accept-encoding': 'test' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js.tst');
        });
    });

    it('should fallback to no compression', function () {
        setupServer({ customCompressions: [{ encodingName: 'test', fileExtension: 'tst' }] });

        return requestFile('/main.js', { 'accept-encoding': 'gzip,br' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js');
        });
    });

    it('should use first match from accept-encoding', function () {
        setupServer({
            customCompressions: [
                // defining these as "custom" without a compressor so we don't lazy-compress them
                { encodingName: 'brotli', fileExtension: 'br' },
                { encodingName: 'gzip', fileExtension: 'gz' },
                { encodingName: 'test', fileExtension: 'tst' },
            ],
            enableBrotli: true,
        });

        return requestFile('/main.js', { 'accept-encoding': 'gzip,br,test' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js.br');
        }).then(() => {
            return requestFile('/main.js', { 'accept-encoding': 'gzip,test,br' }).then(resp => {
                expect(resp.statusCode).to.equal(200);
                expect(resp.body).to.equal('main.js.tst');
            });
        });
    });

    it('should select based on quality', function () {
        setupServer({ customCompressions: [{ encodingName: 'test', fileExtension: 'tst' }], enableBrotli: true });

        return requestFile('/main.js', { 'accept-encoding': 'gzip;q=1.0,br;q=0.4,test;q=0.5' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('main.js.tst');
        });
    });

    it('should serve in alphabetical order on wildcard', function () {
        setupServer({ customCompressions: [{ encodingName: 'test', fileExtension: 'tst' }], enableBrotli: true });

        return requestFile('/index.html', { 'accept-encoding': '*' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.br');
        });
    });

    it('should use server\'s prefered encoding', function () {
        setupServer({
            customCompressions: [{ encodingName: 'deflate', fileExtension: 'zz' }],
            enableBrotli: true,
            orderPreference: ['br']
        });

        return requestFile('/index.html', { 'accept-encoding': 'gzip, deflate, br' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.br');
        });
    });

    it('should use client\'s prefered encoding, when server\'s not available', function () {
        setupServer({
            customCompressions: [{ encodingName: 'deflate', fileExtension: 'zz' }],
            enableBrotli: true,
            orderPreference: ['br']
        });

        return requestFile('/index.html', { 'accept-encoding': 'gzip, deflate' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should handle foldername with dot', function () {
        setupServer(null, 'wwwroot.gzipped');

        return requestFile("/index.html", { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html.gz');
        });
    });

    it('should handle subfolders', function () {
        setupServer(null, 'wwwroot.gzipped');

        return requestFile("/css/style.css", { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('style.css.gz');
        });
    });

    it('should handle url encoded path', function () {
        setupServer();

        return requestFile("/filename with spaces.txt", { 'accept-encoding': 'gzip' }).then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('"filename with spaces.txt.gz"');
        });
    });

    it('should use serveStatic options', function () {
        setupServer({ serveStatic: { setHeaders: (res) => { res.setHeader('Test-X', 'Value-Y') } } });

        return requestFile('/index.html').then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['test-x']).to.equal('Value-Y');
            expect(resp.headers['test-y']).to.be.undefined;
        });
    });

    it('should use serveStatic options set in root options', function () {
        setupServer({ setHeaders: (res) => { res.setHeader('Test-X', 'Value-Y') } });

        return requestFile('/index.html').then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.headers['test-x']).to.equal('Value-Y');
            expect(resp.headers['test-y']).to.be.undefined;
        });
    });

    it('should handle malformed uri', function () {
      setupServer({ index: 'main.js', enableBrotli: true });
  
      return requestFile('/%c0').then((resp) => {
        expect(resp.statusCode).to.equal(400);
        expect(resp.body).to.equal("URI malformed");
      });
    });

    it('should handle malformed uri with plain node response object', function () {
        binaryMode = false;
        const middleware = expressCachingGzip(__dirname + '/wwwroot', __dirname + '/compress-cache');
        const req = {headers: {}, path: '/%c0', url: '/%c0'};
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(name, value) {
                this.headers[name] = value;
            },
            end(body) {
                this.body = body;
                this.ended = true;
            }
        };

        middleware(req, res, () => {
            throw new Error('next should not be called');
        });

        expect(res.statusCode).to.equal(400);
        expect(res.headers['Content-Type']).to.equal('text/plain; charset=utf-8');
        expect(res.body).to.equal('URI malformed');
        expect(res.ended).to.equal(true);
    });

    it('should not corrupt req.url', function () {
        const app = express();
        binaryMode = false;
        app.use(expressCachingGzip(__dirname + '/wwwroot', __dirname + '/compress-cache', { index: 'notfound.html' }));
        app.use(expressCachingGzip(__dirname + '/wwwroot', __dirname + '/compress-cache'));
        server = app.listen(8181);

        return requestFile('/').then((resp) => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html');
        });
    });

    it('should clean up the cache', function () {
        cleanupRuntime();
        setupServer({ compressBeforeResponse: true });
        fs.writeFileSync(runtimeFile, 'runtime.txt');

        return requestFile('/runtime.txt', { 'accept-encoding': 'gzip' }).then(resp => {
            return new Promise((resolve, reject) => {
                expect(fs.existsSync(cacheDir + '/runtime.txt.gz')).to.equal(true);
                expressCachingGzip.cleanupCache(__dirname + '/wwwroot', cacheDir, 1, function () {
                    expect(fs.existsSync(cacheDir + '/runtime.txt.gz')).to.equal(true);
                    fs.writeFileSync(runtimeFile, 'runtime.txt-2');
                    expressCachingGzip.cleanupCache(__dirname + '/wwwroot', cacheDir, 1, function () {
                        expect(fs.existsSync(cacheDir + '/runtime.txt.gz')).to.equal(false);
                        resolve();
                    });
                });
            });
        });
    });

    it('should handle null cache', function () {
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true });
        }
        const app = express();
        binaryMode = false;
        app.use(expressCachingGzip(__dirname + '/wwwroot', null));
        server = app.listen(8181);

        return requestFile('/').then((resp) => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html');

            return new Promise((resolve, reject) => {
                setTimeout(function () {
                    expect(fs.existsSync(cacheDir)).to.equal(false);
                    resolve();
                }, 5);
            });
        });
    });

    it('should handle relative root', function () {
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true });
        }
        const app = express();
        binaryMode = false;
        app.use(expressCachingGzip('test/wwwroot', null));
        server = app.listen(8181);

        return requestFile('/').then((resp) => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html');
        });
    });

    it('should handle slightly malformed URLs', function () {
        setupServer();

        return requestFile('//index.html').then(resp => {
            expect(resp.statusCode).to.equal(200);
            expect(resp.body).to.equal('index.html');
        });
    });

});
