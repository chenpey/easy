const cacheName = "easydrop-static-v1";
const staticPaths = new Set([
  "/assets/app.js",
  "/assets/style.css",
  "/apple-touch-icon.png",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-maskable-512x512.png",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...staticPaths])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith("easydrop-static-") && name !== cacheName)
        .map((name) => caches.delete(name)),
    )),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !staticPaths.has(url.pathname)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});
