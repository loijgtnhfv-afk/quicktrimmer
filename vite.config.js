import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const coopCoep = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Serve the ONNX Runtime wasm/mjs (public/ort/) raw in dev. The Whisper backend
// dynamically imports `/ort/...mjs`, which Vite otherwise routes through its
// module transform (the `?import` request 500s on a publicDir file). This
// middleware short-circuits /ort/* to the raw file before that transform.
// Production (static Vercel) already serves public/ files verbatim, so this is
// dev-only.
function serveOrtRaw() {
  return {
    name: 'serve-ort-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/ort/')) return next();
        const clean = decodeURIComponent(req.url.split('?')[0]);
        const fp = path.join(process.cwd(), 'public', clean);
        if (!fp.startsWith(path.join(process.cwd(), 'public', 'ort'))) return next();
        if (!fs.existsSync(fp)) return next();
        res.setHeader(
          'Content-Type',
          clean.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
        );
        // COEP is same-origin here, but keep parity with the app headers.
        for (const [k, v] of Object.entries(coopCoep)) res.setHeader(k, v);
        fs.createReadStream(fp).pipe(res);
      });
    },
  };
}

// Drop the ORT wasm that Vite eagerly bundles into dist/assets/. Transformers'
// bundled ONNX Runtime references the wasm via `new URL(...)`, so the build
// emits a hashed ~23MB copy — but at runtime we point wasmPaths at our own
// same-origin /ort/ copy (public/ort/), so the bundled asset is never fetched.
// Removing it trims the deploy by ~23MB. (The dangling reference lives in a code
// path wasmPaths overrides, so it's never taken — verified the runtime fetches
// /ort/*.wasm, not the hashed asset.)
function dropBundledOrtWasm() {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

// The multi-thread ffmpeg core (@ffmpeg/core-mt, ~33 MB) comes from the npm package instead
// of being committed under public/: `vercel --prod` uploads the source tree and Hobby caps
// that upload at 100 MB (public/ is already ~81 MB), while node_modules are installed on the
// build machine. Served at /ffmpeg/core-mt-<version>/ — same origin (fine under COEP
// require-corp), covered by vercel.json's /ffmpeg/(.*) immutable rule and sw.js's cache-first
// /ffmpeg/ branch. The version is part of the path, and the build fails if the installed
// package is not that version (the URL must never point at different bytes).
const MT_CORE_VERSION = '0.12.10';
const MT_CORE_DIR = `ffmpeg/core-mt-${MT_CORE_VERSION}/`;
const MT_CORE_FILES = {
  'ffmpeg-core.js': 'text/javascript',
  'ffmpeg-core.wasm': 'application/wasm',
  'ffmpeg-core.worker.js': 'text/javascript',
};
function mtCoreSrcDir() {
  const pkgDir = path.join(process.cwd(), 'node_modules', '@ffmpeg', 'core-mt');
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  if (version !== MT_CORE_VERSION) {
    throw new Error(`@ffmpeg/core-mt ${version} is installed but ${MT_CORE_VERSION} is expected (vite.config.js MT_CORE_VERSION)`);
  }
  return path.join(pkgDir, 'dist', 'esm');
}
function ffmpegMtCore() {
  return {
    name: 'ffmpeg-mt-core',
    configureServer(server) {
      const srcDir = mtCoreSrcDir();
      server.middlewares.use((req, res, next) => {
        const prefix = '/' + MT_CORE_DIR;
        if (!req.url || !req.url.startsWith(prefix)) return next();
        const name = decodeURIComponent(req.url.split('?')[0].slice(prefix.length));
        if (!Object.prototype.hasOwnProperty.call(MT_CORE_FILES, name)) return next();
        res.setHeader('Content-Type', MT_CORE_FILES[name]);
        for (const [k, v] of Object.entries(coopCoep)) res.setHeader(k, v);
        fs.createReadStream(path.join(srcDir, name)).pipe(res);
      });
    },
    generateBundle() {
      const srcDir = mtCoreSrcDir();
      for (const name of Object.keys(MT_CORE_FILES)) {
        this.emitFile({ type: 'asset', fileName: MT_CORE_DIR + name, source: fs.readFileSync(path.join(srcDir, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [serveOrtRaw(), dropBundledOrtWasm(), ffmpegMtCore()],
  define: {
    __QT_MT_CORE_DIR__: JSON.stringify(MT_CORE_DIR),
  },
  server: {
    headers: coopCoep,
  },
  preview: {
    headers: coopCoep,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
