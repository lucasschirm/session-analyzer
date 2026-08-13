/*! coi-serviceworker - MIT licensed pattern by Guido Zuidhof.
 * Injects COOP/COEP headers so SharedArrayBuffer (required by the SQLite
 * WASM OPFS VFS) is available on hosts that cannot set response headers,
 * such as GitHub Pages. Does not cache anything. */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim())
);

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'deregister') {
    self.registration
      .unregister()
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((client) => client.navigate(client.url)));
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 0) return response;

        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch((error) => console.error('coi-sw fetch failed:', error))
  );
});
