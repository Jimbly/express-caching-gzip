# express-caching-gzip

Variant of [express-static-gzip](https://github.com/tkoenig89/express-static-gzip) that dynamically creates and caches static data, and does not serve stale results if files have changed.

# Use cases
For pre-compressed files, have a folder with only .gz files, or you have a folder with the .gz files next to the original files. Same goes for other compressions.

For dynamic compression, any request for a file without a pre-compressed file next to it will cause compression for that file to start in the background, and future requests will be served the compressed version.

The cache of compressed files can be deleted at any time (even while a server is running as long as no active requests are accessing the files).  A cached file is tagged with the timestamp of the source file, and only served if the timestamps are still equal.

# Install

```bash
    $ npm install express-caching-gzip
```

# Usage
In case you just want to serve compressed brotli or gzipped files upon demand, this simple example would do:

```javascript
var express = require('express');
var expressCachingGzip = require('express-caching-gzip');
var app = express();

app.use('/', expressCachingGzip('/my/rootFolder/', '/my/cacheFolder/', {
  enableBrotli: true,
  orderPreference: ['br'],
}));
```

Gzip compression is always enabled, and it is recommended to enable *brotli* using the **options.enableBrotli** flag.

All other compressions need to be added by passing an array to **options.customCompressions**.

The *options.serveStatic* section is passed to the underlying `serve-static` middleware, in case you want to configure this one as well.

Compressions are selected in the following order if a file is requested from the middleware:
* any encoding listed in `option.orderPreference` and supported by the client
* in order of the requests 'accept-encoding' header content (if no quality if provided)
* in order of their respective quality (if provided)
* in case of a wildcard '*', the compression is selected in alphabetical order (for now)
* plain file (in case no compression exists or none is matching the browsers accept-encoding header)

For more details see [here](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding), but not all of it is implemented at the moment.

# Available options

* **`enableBrotli`**: boolean (default: **false**)

    Enables support for the brotli compression, using file extension 'br' (e.g. 'index.html.br').

* **`index`**: boolean | string (default: 'index.html')

    By default this module will send "index.html" files in response to a request on a directory (url ending with '/'). To disable this set false or to supply a new index file pass a string (like 'index.htm').

* **`customCompressions`**: [{encodingName: string, fileExtension: string, compressor: function}]

    Using this option, you can add any other compressions you would like. `encodingName` will be checked against the `Accept`-Header. `fileExtension` is used to find files using this compression. `fileExtension` does not require a dot (not ~~'.gz'~~, but `'gz'`). An optional `compressor(inpath, outpath, cb)` will be called
    to dynamically compress the files.

* **`orderPreference`**: string[]

    This options allows overwriting the client's requested encoding preference (see [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding)) with a server side preference. Any encoding listed in `orderPreference` will be used first (if supported by the client) before falling back to the client's supported encodings. The order of entries in `orderPreference` is taken into account.

* **`serveStatic`**: [ServeStaticOptions](https://github.com/expressjs/serve-static#options)

    This will be forwarded to the underlying `serveStatic` instance used by `expressStaticGzip`

* **`nocompressExts`**: string[] (default: `expressCachingGzip.defaultExts`)

    A list of extensions which should _not_ be compressed (e.g. ['.png', '.jpg']) if the defaults are not desired.  Default include most common media and archive file types.

* **`compressBeforeResponseu`**: boolean (default: false)

    If enabled, all eligible responses will be compressed before responding.  If not,
    only pre-compressed or existing cached compressed responses will be served until
    the dynamic compression finishes (takes a while with Brotli).

* **`timeEpsilon`**: number (default: 250)

    How many milliseconds difference is required between timestamps to be considered the same,
    when checking cache validity.  By default this is 250, however if you're on a filesystem
    with lower-resolution timestamps (e.g. FAT is around 2 seconds), you may need
    to increase this.

# Example
In case you have the following basic file structure

* rootFolder
    * index.html
    * index.html.gz
    * index.html.br
    * test.html.gz
    * main.js

and you use set the *enableBrotli* flag to true, express-static-gzip will answer GET requests like this:

> GET / >>> /my/rootFolder/index.html.br

> GET /index.html >>> /my/rootFolder/index.html.br

> GET /test.html >>> /my/rootFolder/test.html.gz

... wait a moment, request again

> GET /test.html >>> /my/cacheFolder/test.html.br

> GET /main.js >>> /my/rootFolder/main.js

... wait a moment, request again

> GET /main.js >>> /my/cacheFolder/main.js.br

* In the end, `cacheFolder` now contains:
    * text.html.br
    * main.js.br

# Other exported APIs
* **`expressCachingGzip.defaultExts`**: string[]
  The default list of extensions which will not be compressed

* **`expressCachingGzip.cleanupCache(root: string, cacheDir: string, timeEpsiolon?: number, done?: () => void)`**
  Starts an asynchronous cleanup of the cache directory, removing any file which does not have a corresponding (same name, same timestamp) file in the root directory, ignoring files dated after the process started (e.g. due to dynamic compression while serving going on at the same time).
