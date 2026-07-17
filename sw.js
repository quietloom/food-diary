const CACHE_NAME = 'food-diary-v14';
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
  './vendor/xlsx.full.min.js',
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
// lookup, or the CDN-hosted zxing-wasm script) falls through to the network
// and simply fails offline. SheetJS (Export) is now vendored into SHELL_FILES,
// so Export works offline. zxing-wasm (barcode scanning on browsers without
// native BarcodeDetector, e.g. iOS Safari) is still CDN-loaded and NOT in
// SHELL_FILES — it needs network at least once per session before offline
// scanning works there.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
