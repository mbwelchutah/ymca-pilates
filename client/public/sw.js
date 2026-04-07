// YMCA Booker — Service Worker
// Network-first for API calls; cache-first for all static app assets.
// Offline fallback: serve the cached app shell so the UI loads even with no connection.

const CACHE = 'ymca-booker-v2'

// Paths that are never cached — always go straight to the network.
const BYPASS = ['/api/', '/screenshots/', '/manifest.json']

function shouldBypass(url) {
  return BYPASS.some(prefix => url.pathname.startsWith(prefix))
}

// ── Install: pre-cache the bare minimum to load the app shell offline ─────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(['/', '/index.html']))
  )
  self.skipWaiting()
})

// ── Activate: delete old cache versions ───────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// ── Fetch: network-first with cache fallback ──────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // Non-same-origin requests (CDN fonts, etc.) — don't intercept.
  if (url.origin !== self.location.origin) return

  // API & dynamic routes — always hit the network, never cache.
  if (shouldBypass(url)) return

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE).then(cache => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() =>
        caches.match(event.request).then(cached => cached || caches.match('/'))
      )
  )
})
