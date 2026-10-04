// Pure client-side Web Push helper for PWA (Android, iOS PWA, macOS, Windows)

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isIosWithoutPwa(): boolean {
  if (typeof window === 'undefined') return false
  const userAgent = window.navigator.userAgent.toLowerCase()
  const isIos = /iphone|ipad|ipod/.test(userAgent)
  const isStandalone = ('standalone' in window.navigator && (window.navigator as any).standalone) ||
    window.matchMedia('(display-mode: standalone)').matches
  return isIos && !isStandalone
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.ready
    return await reg.pushManager.getSubscription()
  } catch {
    return null
  }
}

export async function subscribeToPushNotifications(userHandle: string): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { success: false, error: 'Push notifications are not supported on this browser.' }
  }

  try {
    // 1. Request OS permission
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return { success: false, error: 'Notification permission was denied.' }
    }

    // 2. Fetch server's VAPID public key
    const res = await fetch('/api/push/vapid-public-key')
    if (!res.ok) {
      throw new Error('Failed to retrieve push encryption key from server')
    }
    const { publicKey } = await res.json()
    if (!publicKey) {
      throw new Error('Server returned empty public key')
    }

    // 3. Register with browser push service (Google FCM / Apple APNs)
    const reg = await navigator.serviceWorker.ready
    let subscription = await reg.pushManager.getSubscription()

    // Clean refresh: unsubscribe any previous or stale token so we get a fresh token matching the current VAPID key
    if (subscription) {
      try {
        await subscription.unsubscribe()
      } catch (unsubErr) {
        console.warn('[SW Push Unsubscribe previous]', unsubErr)
      }
    }

    const appServerKey = urlBase64ToUint8Array(publicKey)
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey as any,
    })

    // 4. Send subscription to backend
    const subJson = subscription.toJSON()
    if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
      throw new Error('Incomplete browser subscription object')
    }

    const saveRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
        userHandle: (userHandle || 'admin').replace(/^@/, '').trim().toLowerCase(),
        userAgent: navigator.userAgent.slice(0, 100),
      }),
    })

    if (!saveRes.ok) {
      throw new Error('Failed to register subscription with server')
    }

    return { success: true }
  } catch (err: any) {
    console.warn('[Web Push Subscribe Error]', err)
    return { success: false, error: err.message || 'Failed to activate notifications' }
  }
}

export async function unsubscribeFromPushNotifications(): Promise<boolean> {
  if (!isPushSupported()) return false
  try {
    const reg = await navigator.serviceWorker.ready
    const subscription = await reg.pushManager.getSubscription()
    if (subscription) {
      const endpoint = subscription.endpoint
      await subscription.unsubscribe()
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {})
    }
    return true
  } catch (err) {
    console.warn('[Web Push Unsubscribe Error]', err)
    return false
  }
}

export async function sendTestNotification(userHandle: string): Promise<{
  success: boolean
  dispatched?: number
  successful?: number
  details?: string
  error?: string
}> {
  try {
    const res = await fetch('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userHandle: (userHandle || 'admin').replace(/^@/, '').trim().toLowerCase(),
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { success: false, error: data.error || 'Server error triggering test' }
    }
    if (data.dispatched === 0) {
      return {
        success: false,
        error: 'No active device registered in database yet. Tap "Enable Notifications" on this device first.',
      }
    }
    if (data.successful > 0) {
      return {
        success: true,
        dispatched: data.dispatched,
        successful: data.successful,
        details: `Successfully sent to ${data.successful} device(s)`,
      }
    }
    const firstErr = data.results?.[0]?.error || 'Push gateway rejected notification'
    return { success: false, error: firstErr }
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error triggering test' }
  }
}

