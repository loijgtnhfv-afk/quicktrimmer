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

export default defineConfig({
  plugins: [serveOrtRaw()],
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
