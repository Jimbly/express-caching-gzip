// Type definitions for express-caching-gzip 1.0.0
/* =================== USAGE ===================

    import * as expressCachingGzip from "express-caching-gzip";
    app.use(expressCachingGzip("wwwroot", {enableBrotli: true, index: 'index.htm'}))

 =============================================== */

import * as serverStatic from "serve-static";

/**
 * Generates a middleware function to serve static files. It is build on top of serveStatic.
 * It extends serveStatic with the capability to serve (previously) gziped files. For this
 * it asumes, the gziped files are next to the original files.
 * @param root folder to statically serve files from
 * @param cacheDir folder to store and serve dynamically compressed files in
 * @param options options to configure expressCachingGzip
 */
declare function expressCachingGzip(root: string, cacheDir: string, options?: expressCachingGzip.expressCachingGzipOptions): (req: any, res: any, next: any) => any;

declare namespace expressCachingGzip {
    /**
     * Default extensions used for nocompressExts option
     */
    const defaultExts: string[];

    /**
     * Options to configure an `expressCachingGzip` instance.
     */
    interface expressCachingGzipOptions {

        /**
         * Add any other compressions not supported by default. 
         * `encodingName` will be checked against the request's Accept-Header. 
         * `fileExtension` is used to find files using this compression.
         * `fileExtension` does not require a dot (e.g. 'gz' not '.gz').
         * @default null
         */
        customCompressions?: Compression[];

        /**
         * Enables support for the brotli compression, using file extension 'br' (e.g. 'index.html.br'). 
         * @default false
         */
        enableBrotli?: boolean;

        /**
         * By default this module will send "index.html" files in response to a request on a directory. 
         * To disable this set false or to supply a new index pass a string.
         * @default 'index.html'
         */
        index?: boolean | string;

        /**
         * Allows overwriting the client's requested encoding preference 
         * (see [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Accept-Encoding)) 
         * with a server side preference. Any encoding listed in orderPreference will be 
         * used first (if supported by the client) before falling back to the client's supported encodings. 
         * The order of entries in orderPreference is taken into account.
         * @default null
         */
        orderPreference?: string[];

        /**
         * This will be forwarded to the underlying `serveStatic` instance used by `expressCachingGzip`.
         * @default null
         */
        serveStatic?: serverStatic.ServeStaticOptions

        /**
         * A list of extensions which should _not_ be compressed (e.g. ['.png', '.jpg']) if the defaults
         * are not desired.
         * @default expressCachingGzip.defaultExts
         */
        nocompressExts?: string[];

        /**
         * If enabled, all eligible responses will be compressed before responding.  If not,
         * only pre-compressed or existing cached compressed responses will be served until
         * the dynamic compression finishes (takes a while with Brotli)
         * @default false
         */
        compressBeforeResponseu?: boolean;

        /**
         * How many milliseconds difference is required between timestamps to be considered the same,
         * when checking cache validity.  By default this is 2500, to deal with low-precision timestamps
         * on some filesystems, but if your source data changes more often than this, you may need
         * to lower this.
         * @default 2500
         */
        timeEpsilon?: number;
    }

    interface Compression {
        /**
         * Will be checked against the request's Accept-Header. 
         */
        encodingName: string;

        /**
         * Is used to find files using this compression.
         */
        fileExtension: string;

        /**
         * Optional function to perform dynamic compression
         */
        compressor?: (pathin: string, pathout: string, done: (err?: Error | string) => void) => void;
    }
}

export = expressCachingGzip;