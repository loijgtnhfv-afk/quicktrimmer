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

export default defineConfig({
  plugins: [serveOrtRaw(), dropBundledOrtWasm()],
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
