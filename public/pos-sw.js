/* NALVEN PDV offline shell. API responses and mutations are never cached. */
const CACHE = "nalven-pos-shell-v1";
const SAFE_SHELL = "/erp/pdv-offline";

self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith("nalven-pos-shell-") && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("authorization")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cacheControl = response.headers.get("cache-control") || "";
        if (url.pathname === SAFE_SHELL && response.ok && !response.redirected && !/no-store|private/i.test(cacheControl)) {
          const cache = await caches.open(CACHE);
          await cache.put(SAFE_SHELL, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(SAFE_SHELL);
        return cached || new Response("PDV offline indisponível até a primeira abertura online.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      }
    })());
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/favicon.svg" || url.pathname === "/manifest.webmanifest") {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && !/no-store|private/i.test(response.headers.get("cache-control") || "")) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    })());
  }
});

self.addEventListener("message", event => {
  if (event.data?.type === "PURGE_POS_SHELL") event.waitUntil(caches.delete(CACHE));
});
