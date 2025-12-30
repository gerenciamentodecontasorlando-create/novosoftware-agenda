/* Service Worker - Offline-first
   Caches app shell + CDN jsPDF after first load. */
const CACHE = "oa-agenda-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only GET
  if (req.method !== "GET") return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Network-first for CDN (so it gets cached once and works offline later)
    if (url.hostname.includes("cdn.jsdelivr.net")) {
      try{
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      }catch(e){
        const cached = await cache.match(req);
        if (cached) return cached;
        throw e;
      }
    }

    // Cache-first for app shell
    const cached = await cache.match(req);
    if (cached) return cached;

    try{
      const fresh = await fetch(req);
      // Cache same-origin assets
      if (url.origin === location.origin) cache.put(req, fresh.clone());
      return fresh;
    }catch(e){
      // Fallback to index for navigation
      if (req.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
