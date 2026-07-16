const CACHE_NAME = 'food-diary-v13';
const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './manifest.json',
  './js/app.js',
  './js/db.js',
  './js/checkdigit.js',
  './js/lookup.js',
  './js/export.js',
  './js/timing.js',
  './js/scan.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/nutritics-food-diary-v2-template.xlsx',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Cache-first for the app shell; anything else (e.g. the Open Food Facts
// lookup, or the CDN-hosted SheetJS/zxing-wasm scripts) falls through to the
// network and simply fails offline. Scanning + IndexedDB storage work
// offline, but SheetJS (Export) and zxing-wasm (barcode scanning on browsers
// without native BarcodeDetector, e.g. iOS Safari) are NOT in SHELL_FILES —
// they load from CDN and need network at least once per session before those
// features work offline.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
