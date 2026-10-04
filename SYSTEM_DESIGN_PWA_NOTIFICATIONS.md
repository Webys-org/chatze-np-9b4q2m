# SYSTEM DESIGN: Zero-Polling Web Push & Background Notifications for PWA

**Author:** Chatze Engineering  
**Target Environment:** Cloudflare Workers + D1 Database + PWA (Vite/React)  
**Status:** Architecture Proposal & Blueprint  
**Goal:** Deliver instantaneous, battery-efficient native push notifications on Android, Windows, macOS, and iOS PWA when new messages arrive, with zero polling and zero impact on current application behavior.

---

## 1. Architectural Principles & Non-Interference Guarantee

The Web Push notification system is designed as an **additive, strictly decoupled subsystem**. It operates alongside—not inside—the core real-time messaging pipeline.

### Core Guarantees:
1. **Zero Impact on Real-Time SSE (0ms):**
   * When an app tab is open in the foreground, the active Server-Sent Events (SSE) stream delivers incoming messages in 0ms.
   * Push notification dispatch is executed asynchronously in the Cloudflare Worker using `c.executionCtx.waitUntil(...)`. Message delivery and HTTP `201 Created` responses are never delayed or blocked by push gateway calls.
2. **Zero Polling & Zero Idle Cost:**
   * No background fetch loops or polling timers run on the user's mobile device or PC.
   * Devices rely entirely on the operating system's native push daemon (Google Play Services / FCM on Android/Chrome; Apple Push Notification service on iOS/Safari).
3. **100% Free Tier Compliant:**
   * Uses standard W3C Web Push Protocols (RFC 8030, RFC 8291, RFC 8292).
   * Directly contacts Google FCM and Apple APNs. No paid third-party brokers (e.g., OneSignal, Pusher) are required.

---

## 2. End-to-End Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                                 FOREGROUND (Active Tab)                           |
|                         Realtime SSE Stream (0ms Delivery)                        |
+-----------------------------------------------------------------------------------+
                                          ^
                                          | Active SSE Stream
                                          |
+------------------------+      POST /api/messaging      +--------------------------+
|  Sender (PC or Mobile) | ----------------------------> | Cloudflare Worker        |
+------------------------+                               | (Edge API Endpoint)      |
                                                         +--------------------------+
                                                          |              |
                                          Save to D1 Table|              | c.executionCtx.waitUntil()
                                                          v              v
                                             +----------------+   +-------------------+
                                             | D1 Database    |   | Web Push Engine   |
                                             | (messages)     |   | (Pure WebCrypto)  |
                                             +----------------+   +-------------------+
                                                                           |
                                                      +--------------------+--------------------+
                                                      |                                         |
                                                      v                                         v
                                         +--------------------------+              +--------------------------+
                                         | Google FCM Gateway       |              | Apple APNs Gateway       |
                                         | (Android / Windows / PC) |              | (iOS PWA / macOS Safari) |
                                         +--------------------------+              +--------------------------+
                                                      |                                         |
                                                      v                                         v
                                         +--------------------------+              +--------------------------+
                                         | Android System Banner    |              | iOS Lockscreen Alert     |
                                         | (App closed / locked)    |              | (Home Screen PWA)        |
                                         +--------------------------+              +--------------------------+
```

---

## 3. Database Schema Extension (Additive Table)

To track push subscriptions for each registered user device without altering existing tables (`users`, `conversations`, `messages`), a new isolated table is created in Cloudflare D1:

```sql
-- D1 Additive Table: push_subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,               -- Unique identifier (e.g., 'sub_x9k2p1')
  user_handle TEXT NOT NULL,         -- Handle of the target recipient (e.g., 'admin')
  endpoint TEXT NOT NULL UNIQUE,     -- Push gateway URL provided by Google/Apple
  p256dh TEXT NOT NULL,              -- Client public key for message encryption
  auth TEXT NOT NULL,                -- Client authentication secret
  user_agent TEXT,                   -- Device descriptor ('Android Chrome', 'iOS PWA')
  created_at INTEGER NOT NULL        -- Epoch timestamp
);

CREATE INDEX IF NOT EXISTS idx_push_user_handle ON push_subscriptions(user_handle);
```

---

## 4. Edge-Native VAPID & WebCrypto Engine (`src/server/webpush.ts`)

Standard Node.js packages (such as `web-push`) fail inside Cloudflare Workers because they depend on Node.js core modules (`crypto`, `https`, `stream`). 

### The Solution:
A zero-dependency TypeScript implementation utilizing standard Web APIs (`crypto.subtle` and `fetch`):
1. **RFC 8292 (VAPID JWT Signatures):**
   * Creates ECDSA P-256 JWT tokens signed with ES256 using `crypto.subtle.sign`.
   * Includes standard claims: `aud` (push gateway origin), `exp` (12-hour validity), and `sub` (`mailto:admin@domain`).
2. **RFC 8291 (Message Encryption):**
   * Derives shared secret via ECDH (`crypto.subtle.deriveKey`) between the ephemeral server key and the client's `p256dh` public key.
   * Encrypts the JSON notification payload using `AES-128-GCM` with a 16-byte authentication tag.
3. **Dead Endpoint Auto-Pruning (HTTP 410):**
   * If Google or Apple returns `410 Gone` or `404 Not Found` (indicating the user uninstalled the app or revoked permission), the Worker immediately deletes the dead record from `push_subscriptions` in D1 to conserve resources.

---

## 5. Service Worker Background Handler (`public/sw.js`)

The PWA Service Worker handles two distinct lifecycle events:

### Event A: `push` (Background Wake-Up)
Triggered by the OS when a push packet arrives:
```javascript
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || 'New message received',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: data.conversationId || 'chatze_chat',
    renotify: true,
    data: {
      url: data.url || '/',
      conversationId: data.conversationId,
    },
    actions: [
      { action: 'open', title: 'Open Chat' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Chatze', options)
  );
});
```

### Event B: `notificationclick` (User Interaction)
Focuses the existing open window or opens the designated conversation:
```javascript
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
```

---

## 6. Client-Side Subscription & Opt-In UX

Push notifications cannot be triggered without explicit user consent. The UX incorporates an opt-in controller:

1. **Permission State Detection:**
   * Evaluates `Notification.permission`: `'default'` (not asked), `'granted'` (active), or `'denied'` (blocked).
2. **Platform-Specific Considerations:**
   * **Android / PC:** Single-click permission prompt natively supported in browser tabs.
   * **iOS (iPhones/iPads):** Apple requires the web app to be added to the Home Screen ("Add to Home Screen" PWA) and running iOS 16.4+. If visited in standard mobile Safari, the UI displays a gentle instruction card guiding the user to install the PWA first.
3. **Registration Flow:**
   * User toggles "Enable Notifications".
   * Browser generates PushSubscription via `registration.pushManager.subscribe()`.
   * Sends the public keys (`endpoint`, `p256dh`, `auth`) to `POST /api/push/subscribe`.

---

## 7. Execution Path in `POST /api/messaging`

```typescript
// Inside POST /api/messaging:

// Step 1: Deliver instant 0ms SSE to active tabs (Unchanged)
await broadcastAllStreams('new_message', messageRecord, c.env);

// Step 2: Background push notification (Non-blocking)
if (c.executionCtx && recipientHandle) {
  c.executionCtx.waitUntil(
    sendPushNotification(c.env, recipientHandle, {
      title: `@${cleanSenderHandle}`,
      body: messageRecord.body,
      conversationId: messageRecord.conversationId,
      url: `/?conv=${messageRecord.conversationId}`,
    })
  );
}
```

---

## 8. Failure Isolation & Security Boundaries

| Potential Failure Point | System Response & Mitigation |
| :--- | :--- |
| **Worker Push Error / Network Timeout** | Wrapped in `c.executionCtx.waitUntil(promise.catch(...))`. The main HTTP request and real-time SSE stream never fail. |
| **User Revoked Notification Permission** | Gateway responds with `410 Gone`. System automatically purges the subscription from D1. |
| **User Inactive or Offline** | Gateway queues the notification and delivers it the moment the device reconnects to Wi-Fi/cellular. |
| **Database Unavailable** | Soft warning logged; chat messaging operates normally. |

---

## 9. Implementation Checklist

1. **Additive Schema:** Add `push_subscriptions` table creation to D1 setup helper.
2. **VAPID Keys:** Generate permanent P-256 VAPID keypair in environment variables.
3. **Server WebPush Engine:** Add lightweight `src/server/webpush.ts` with pure WebCrypto.
4. **API Endpoints:**
   * `GET /api/push/vapid-public-key`: Returns public key for client registration.
   * `POST /api/push/subscribe`: Stores subscription in D1.
   * `POST /api/push/unsubscribe`: Removes subscription from D1.
5. **Service Worker:** Update `public/sw.js` with `push` and `notificationclick` listeners.
6. **Frontend UI:** Add a clean Notification bell / toggle in the sidebar settings.
