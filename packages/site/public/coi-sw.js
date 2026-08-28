/*! coi-serviceworker - MIT licensed pattern by Guido Zuidhof.
 * Injects COOP/COEP headers so SharedArrayBuffer (required by the SQLite
 * WASM OPFS VFS) is available on hosts that cannot set response headers,
 * such as GitHub Pages. Also runtime-caches same-origin GET requests so the
 * app (including worker chunks and sqlite3.wasm) works offline after the
 * first load. */

const CACHE_NAME = 'session-analyzer-v1';

async function addCoiHeaders(response) {
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCacheable(request) {
  return (
    request.method === 'GET' &&
    request.url.startsWith(self.location.origin) &&
    !request.url.endsWith('/coi-sw.js')
  );
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'deregister') {
    self.registration
      .unregister()
      .then(() => self.clients.matchAll())
      .then((clients) =>
        clients.forEach((client) => {
          client.navigate(client.url);
        }),
      );
  }
});

self.addEventListener('fetch', (event) => {
  if (!isCacheable(event.request)) return;

  event.respondWith(
    fetch(event.request)
      .then(async (networkResponse) => {
        const response = await addCoiHeaders(networkResponse);
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        return new Response('Network and cache miss', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      }),
  );
});
