// Offline-cache service worker for QuickTrimmer.
//
// Strategy (important — the previous version stranded returning users on a
// stale build after every deploy):
//   - HTML / navigations  -> NETWORK-FIRST. The shell always reflects the
//     latest deploy, so its hashed <script>/<link> references are current.
//     Falls back to cache when offline.
//   - Hashed build assets (/assets/*), ffmpeg core (/ffmpeg/*, ~32MB), icons,
//     manifest -> CACHE-FIRST. These are content-hashed / immutable / large,
//     so serving them from cache is safe and fast.
//   - Bumping CACHE drops the poisoned old cache on activate, healing users
//     who still carry the broken qt-v1.
const CACHE = 'qt-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/ffmpeg/ffmpeg-core.js',
  '/ffmpeg/ffmpeg-core.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(req) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  // Network-first for the app shell so new deploys are picked up immediately.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for immutable / large static assets.
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/ffmpeg/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Default: network, fall back to whatever we have cached.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
