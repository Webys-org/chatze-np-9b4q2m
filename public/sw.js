const CACHE_NAME = 'chatze-v2-cache'
const STATIC_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
  '/apple-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
]

// Install: Pre-cache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_PRECACHE)
    }).catch((err) => {
      console.warn('[SW Install Cache Warning]', err)
    })
  )
  self.skipWaiting()
})

// Activate: Clean up older cache generations
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  )
})

// Fetch strategy:
// 1. /api/* => Strictly Network Only (NEVER cache dynamic API)
// 2. /assets/* => Cache-First (Hashed Vite bundles never change)
// 3. Navigation / HTML => Stale-While-Revalidate with offline shell fallback
// 4. Other static images/fonts => Cache-First with network fallback
self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // 1. Skip non-GET and /api/* requests completely
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return
  }

  // 2. Hashed static assets (/assets/*): Cache-First
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached
        return fetch(req).then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
      })
    )
    return
  }

  // 3. Navigation requests (HTML document): Stale-While-Revalidate with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.status === 200) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
          }
          return res
        })
        .catch(() => {
          return caches.match(req).then((cached) => {
            return cached || caches.match('/') || caches.match('/index.html')
          })
        })
    )
    return
  }

  // 4. Other static files (images, icons, manifest): Cache-First, then network fallback
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached

      return fetch(req).then((res) => {
        if (res.ok && res.status === 200) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone))
        }
        return res
      }).catch(() => cached)
    })
  )
})

// Push Notifications handler
self.addEventListener('push', (event) => {
  let title = 'Chatze'
  let body = 'You received a new message.'
  let url = '/'
  let conversationId = undefined

  try {
    if (event.data) {
      const data = event.data.json()
      if (data.title) title = data.title
      if (data.body) body = data.body
      if (data.url) url = data.url
      if (data.conversationId) conversationId = data.conversationId
    }
  } catch (err) {
    try {
      if (event.data) {
        body = event.data.text() || body
      }
    } catch {}
  }

  // Multi-platform notification options (Android Chrome & iOS Safari WebKit)
  const notificationOptions = {
    body,
    icon: '/pwa-192x192.png',
    badge: '/icon-light-32x32.png',
    vibrate: [200, 100, 200],
    tag: conversationId ? `conv_${conversationId}` : `alert_${Date.now()}`,
    renotify: true,
    data: {
      url: url || '/',
      conversationId,
    },
  }

  event.waitUntil(
    self.registration
      .showNotification(title, notificationOptions)
      .catch((err) => {
        console.warn('[SW showNotification error]', err)
        // Fallback with bare minimum for strict iOS Safari
        return self.registration.showNotification(title, { body })
      })
      .then(() => {
        return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
          clients.forEach((client) => {
            client.postMessage({
              type: 'relay:message',
              conversationId,
              title,
              body,
            })
          })
        })
      })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({
            type: 'relay:message',
            conversationId: event.notification.data?.conversationId,
          })
          return
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })
  )
})
