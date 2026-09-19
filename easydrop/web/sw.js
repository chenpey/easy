const cacheName = "__EASYDROP_CACHE_NAME__";
const staticPaths = new Set(/* __EASYDROP_STATIC_ASSETS__ */ []);

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
  event.respondWith(caches.match(event.request).then(async (cached) => {
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  }).catch(() => Response.error()));
});
