import React, { useState, useEffect } from 'react'
import { Bell, BellRing, Smartphone, X, Check, AlertCircle, Loader2, Sparkles, Volume2 } from 'lucide-react'
import {
  isPushSupported,
  isIosWithoutPwa,
  getExistingPushSubscription,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
  sendTestNotification,
} from '../lib/pushNotifications'

interface NotificationToggleButtonProps {
  userHandle: string
  className?: string
}

export const NotificationToggleButton: React.FC<NotificationToggleButtonProps> = ({
  userHandle,
  className = '',
}) => {
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [testSent, setTestSent] = useState(false)
  const [testDetails, setTestDetails] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')

  useEffect(() => {
    if (!isPushSupported()) {
      setPermission('unsupported')
      return
    }

    setPermission(Notification.permission)

    getExistingPushSubscription().then(async (sub) => {
      if (sub) {
        setIsSubscribed(true)
        // Background sync: ensure this device's token is saved in server D1 database
        try {
          const subJson = sub.toJSON()
          if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
            await fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: subJson.endpoint,
                keys: subJson.keys,
                userHandle: (userHandle || 'admin').replace(/^@/, '').trim().toLowerCase(),
                userAgent: navigator.userAgent.slice(0, 100),
              }),
            })
          }
        } catch (e) {
          console.warn('[Push Auto-sync Warning]', e)
        }
      } else {
        setIsSubscribed(false)
      }
    })
  }, [userHandle])

  const handleToggle = async () => {
    setErrorMsg(null)
    setTestDetails(null)

    if (isIosWithoutPwa()) {
      setShowModal(true)
      return
    }

    if (isSubscribed) {
      // If already subscribed, clicking opens the status & test modal
      setShowModal(true)
      return
    }

    setLoading(true)
    const result = await subscribeToPushNotifications(userHandle)
    setLoading(false)

    if (result.success) {
      setIsSubscribed(true)
      setPermission('granted')
      setShowModal(true)
    } else {
      setErrorMsg(result.error || 'Could not enable notifications')
      setShowModal(true)
    }
  }

  const handleUnsubscribe = async () => {
    setLoading(true)
    const success = await unsubscribeFromPushNotifications()
    if (success) {
      setIsSubscribed(false)
      setShowModal(false)
    }
    setLoading(false)
  }

  const handleTestAlert = async () => {
    setLoading(true)
    setErrorMsg(null)
    setTestDetails(null)

    // First attempt: send test notification
    let res = await sendTestNotification(userHandle)

    // If server has no device registered (e.g. database migration or isolate reboot),
    // automatically re-register this device immediately and retry!
    if (!res.success && (res.dispatched === 0 || res.error?.includes('No active device') || res.error?.includes('not found'))) {
      const regRes = await subscribeToPushNotifications(userHandle)
      if (regRes.success) {
        setIsSubscribed(true)
        res = await sendTestNotification(userHandle)
      } else {
        setErrorMsg(regRes.error || 'Failed to re-register this device with server.')
        setLoading(false)
        return
      }
    }

    setLoading(false)
    if (res.success) {
      setTestSent(true)
      setTestDetails(res.details || 'Dispatched to 1 device')
      setTimeout(() => setTestSent(false), 8000)
    } else {
      setErrorMsg(res.error || 'Could not send test notification')
    }
  }

  const renderModal = () => {
    if (!showModal) return null

    const isIos = isIosWithoutPwa()

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in">
        <div className="w-full max-w-sm rounded-2xl bg-[#111b21] border border-[#222d34] p-5 shadow-2xl text-slate-200">
          <div className="flex items-center justify-between pb-3 border-b border-[#222d34]">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[#00a884]/20 flex items-center justify-center text-[#00a884]">
                <BellRing className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-semibold text-white">
                {isIos ? 'iPhone Push Setup' : 'Push Notifications'}
              </h3>
            </div>
            <button
              onClick={() => setShowModal(false)}
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-[#202c33] transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-4 space-y-3 text-xs text-[#8696a0] leading-relaxed">
            {isIos ? (
              <>
                <p className="text-white font-medium">
                  Apple requires iOS apps to be launched from your Home Screen before enabling notifications:
                </p>
                <div className="space-y-2 pt-1">
                  <div className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">1</span>
                    <p>Tap <strong className="text-white">Share</strong> in Safari (box with arrow pointing up).</p>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">2</span>
                    <p>Tap <strong className="text-white">Add to Home Screen</strong>.</p>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">3</span>
                    <p>Launch Chatze from your Home Screen and tap this bell to activate alerts.</p>
                  </div>
                </div>
              </>
            ) : isSubscribed ? (
              <div className="space-y-3">
                <div className="p-3 rounded-lg bg-[#00a884]/10 border border-[#00a884]/30 text-[#00a884] space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold text-white">
                    <Check className="w-4 h-4 text-[#00a884]" />
                    <span>Notifications Active</span>
                  </div>
                  <p className="text-[11px] text-[#8696a0]">
                    This device is registered to receive lock-screen alerts for @{userHandle}.
                  </p>
                </div>

                <div className="pt-1 space-y-2">
                  <button
                    onClick={handleTestAlert}
                    disabled={loading}
                    className="w-full py-2.5 px-3 rounded-lg bg-[#00a884] hover:bg-[#008f6f] text-slate-950 font-semibold text-xs flex items-center justify-center gap-2 transition"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    <span>{testSent ? 'Alert Dispatched to Phone!' : 'Send Test Notification to This Phone'}</span>
                  </button>

                  {testSent && (
                    <div className="p-2.5 rounded-lg bg-[#00a884]/20 border border-[#00a884]/40 text-[#00a884] text-center animate-in fade-in space-y-1">
                      <p className="font-semibold text-white">🎉 Test Notification Sent!</p>
                      <p className="text-[11px] text-emerald-200">
                        {testDetails || 'Delivered to gateway.'} Lock your phone screen or swipe away to see the banner!
                      </p>
                    </div>
                  )}

                  {errorMsg && (
                    <div className="p-2.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 text-center animate-in fade-in space-y-1.5">
                      <p className="font-semibold text-white flex items-center justify-center gap-1">
                        <AlertCircle className="w-4 h-4 text-rose-400" />
                        <span>Push Notification Issue</span>
                      </p>
                      <p className="text-[11px] text-rose-200">{errorMsg}</p>
                      <button
                        onClick={async () => {
                          setLoading(true)
                          setErrorMsg(null)
                          const res = await subscribeToPushNotifications(userHandle)
                          setLoading(false)
                          if (res.success) {
                            setIsSubscribed(true)
                            handleTestAlert()
                          } else {
                            setErrorMsg(res.error || 'Re-registration failed')
                          }
                        }}
                        className="text-[10px] text-white underline hover:no-underline font-medium block mx-auto pt-1"
                      >
                        Tap here to re-register this device
                      </button>
                    </div>
                  )}

                  <p className="text-[10px] text-center text-[#8696a0]">
                    Tip: Tap this button, then quickly lock your phone to see the notification banner on your lock screen!
                  </p>
                </div>
              </div>
            ) : errorMsg ? (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="w-4 h-4" />
                  <span>Notification Setup</span>
                </div>
                <p className="text-[11px] text-rose-200/80">{errorMsg}</p>
                {permission === 'denied' && (
                  <p className="text-[11px] text-[#8696a0] pt-1">
                    Notifications are blocked in your browser settings. Check Android Settings &gt; Apps &gt; Chrome &gt; Notifications or Site Settings.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p>
                  Receive native lock-screen alerts on your phone or PC when new messages arrive—even when Chatze is closed.
                </p>
                <div className="flex items-center gap-2 p-2 rounded-lg bg-[#202c33] text-white text-[11px]">
                  <Check className="w-4 h-4 text-[#00a884] shrink-0" />
                  <span>Zero battery drain (uses native Apple APNs / Google FCM)</span>
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 flex gap-2">
            <button
              onClick={() => setShowModal(false)}
              className="flex-1 rounded-lg bg-[#202c33] hover:bg-[#2a3942] py-2 text-xs font-medium text-slate-300 transition"
            >
              Close
            </button>
            {isSubscribed && (
              <button
                onClick={handleUnsubscribe}
                disabled={loading}
                className="py-2 px-3 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-medium transition"
              >
                Turn Off
              </button>
            )}
            {!isIos && !isSubscribed && (
              <button
                onClick={() => {
                  setShowModal(false)
                  handleToggle()
                }}
                className="flex-1 rounded-lg bg-[#00a884] hover:bg-[#008f6f] py-2 text-xs font-semibold text-slate-950 transition"
              >
                Allow & Enable
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <button
        onClick={handleToggle}
        disabled={loading}
        title={
          isSubscribed
            ? 'Background notifications active (click to test or configure)'
            : 'Enable background notifications for this device'
        }
        className={`relative p-2 rounded-full transition-colors ${
          isSubscribed
            ? 'text-[#00a884] bg-[#00a884]/15 hover:bg-[#00a884]/25'
            : 'text-[#8696a0] hover:text-[#00a884] hover:bg-[#202c33]'
        } ${className}`}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-[#00a884]" />
        ) : isSubscribed ? (
          <>
            <Bell className="w-4 h-4 fill-current" />
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#00a884]" />
          </>
        ) : (
          <Bell className="w-4 h-4" />
        )}
      </button>
      {renderModal()}
    </>
  )
}
