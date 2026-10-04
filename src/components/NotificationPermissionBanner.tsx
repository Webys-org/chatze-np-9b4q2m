import React, { useState, useEffect } from 'react'
import { Bell, BellRing, Smartphone, X, Check, Loader2, Sparkles } from 'lucide-react'
import {
  isPushSupported,
  isIosWithoutPwa,
  getExistingPushSubscription,
  subscribeToPushNotifications,
  sendTestNotification,
} from '../lib/pushNotifications'

interface NotificationPermissionBannerProps {
  userHandle: string
}

export const NotificationPermissionBanner: React.FC<NotificationPermissionBannerProps> = ({ userHandle }) => {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [showIosModal, setShowIosModal] = useState(false)
  const [testSent, setTestSent] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    // Check if dismissed previously in this session
    if (sessionStorage.getItem('chatze_notif_banner_dismissed') === 'true') {
      setDismissed(true)
    }

    if (!isPushSupported()) {
      setPermission('unsupported')
      return
    }

    setPermission(Notification.permission)

    getExistingPushSubscription().then((sub) => {
      setIsSubscribed(!!sub)
    })
  }, [])

  const handleEnable = async () => {
    setErrorMsg(null)

    if (isIosWithoutPwa()) {
      setShowIosModal(true)
      return
    }

    setLoading(true)
    const res = await subscribeToPushNotifications(userHandle)
    setLoading(false)

    if (res.success) {
      setIsSubscribed(true)
      setPermission('granted')
    } else {
      setErrorMsg(res.error || 'Failed to activate notifications.')
    }
  }

  const handleSendTest = async () => {
    setLoading(true)
    setErrorMsg(null)
    let res = await sendTestNotification(userHandle)
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
      setTimeout(() => setTestSent(false), 8000)
    } else {
      setErrorMsg(res.error || 'Test notification failed.')
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('chatze_notif_banner_dismissed', 'true')
  }

  // If dismissed or already granted & subscribed (and not in test mode), hide banner
  if (dismissed || (permission === 'granted' && isSubscribed && !testSent && !errorMsg)) {
    return null
  }

  // iOS Safari in browser tab (needs Add to Home Screen first)
  const isIosBrowser = isIosWithoutPwa()

  return (
    <>
      <div className="relative bg-gradient-to-r from-[#00a884]/20 via-[#00a884]/10 to-[#111b21] border-b border-[#00a884]/30 px-3 py-2.5 sm:px-4 text-xs text-[#e9edef] animate-in fade-in slide-in-from-top-2">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#00a884]/20 border border-[#00a884]/40 flex items-center justify-center text-[#00a884] shrink-0">
              {isIosBrowser ? <Smartphone className="w-4 h-4" /> : <BellRing className="w-4 h-4 animate-bounce" />}
            </div>
            <div>
              {isIosBrowser ? (
                <p className="font-semibold text-white">
                  Add to iPhone Home Screen for Lock-Screen Alerts
                  <span className="block text-[11px] font-normal text-[#8696a0]">
                    Apple requires installing Chatze via Safari Share &gt; Add to Home Screen to unlock push notifications.
                  </span>
                </p>
              ) : isSubscribed ? (
                <p className="font-semibold text-[#00a884] flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5" /> Notifications Active!
                  <span className="text-[11px] font-normal text-[#8696a0]">
                    Lock your phone or switch apps to test incoming alerts.
                  </span>
                </p>
              ) : (
                <p className="font-semibold text-white">
                  Enable Lock-Screen Notifications
                  <span className="block text-[11px] font-normal text-[#8696a0]">
                    Receive instant vibration and sound alerts on your phone when new messages arrive.
                  </span>
                </p>
              )}
              {errorMsg && <p className="text-[11px] text-rose-400 mt-0.5">{errorMsg}</p>}
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
            {isIosBrowser ? (
              <button
                onClick={() => setShowIosModal(true)}
                className="px-3 py-1.5 rounded-lg bg-[#00a884] hover:bg-[#008f6f] text-slate-950 font-semibold text-xs transition"
              >
                View iOS Setup
              </button>
            ) : isSubscribed ? (
              <button
                onClick={handleSendTest}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-[#202c33] hover:bg-[#2a3942] border border-[#00a884]/40 text-[#00a884] font-semibold text-xs flex items-center gap-1.5 transition"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {testSent ? 'Alert Dispatched!' : 'Send Test Alert'}
              </button>
            ) : (
              <button
                onClick={handleEnable}
                disabled={loading}
                className="px-3 py-1.5 rounded-lg bg-[#00a884] hover:bg-[#008f6f] text-slate-950 font-semibold text-xs flex items-center gap-1.5 transition shadow-sm"
              >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                Enable Notifications
              </button>
            )}

            <button
              onClick={handleDismiss}
              title="Dismiss"
              className="p-1 rounded-md text-[#8696a0] hover:text-white hover:bg-[#202c33] transition"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* iOS Instructions Modal */}
      {showIosModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#111b21] border border-[#222d34] p-5 shadow-2xl text-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-[#222d34]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#00a884]/20 flex items-center justify-center text-[#00a884]">
                  <Smartphone className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-semibold text-white">iPhone Notifications Setup</h3>
              </div>
              <button
                onClick={() => setShowIosModal(false)}
                className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-[#202c33] transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs text-[#8696a0] leading-relaxed">
              <p className="text-white font-medium">
                Apple restricts Web Push to installed Home Screen apps on iOS 16.4+:
              </p>
              <div className="space-y-2.5 pt-1">
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">1</span>
                  <p>In Safari, tap the <strong className="text-white">Share</strong> button (the box with an arrow pointing up at the bottom).</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">2</span>
                  <p>Scroll down the menu and tap <strong className="text-white">Add to Home Screen</strong>.</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">3</span>
                  <p>Open the new <strong className="text-white">Chatze</strong> icon from your Home Screen.</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#00a884] text-slate-950 flex items-center justify-center shrink-0 font-bold">4</span>
                  <p>Tap <strong className="text-[#00a884]">Enable Notifications</strong> when prompted to allow lock-screen alerts.</p>
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowIosModal(false)}
              className="mt-5 w-full rounded-lg bg-[#00a884] py-2 text-xs font-semibold text-slate-950 hover:bg-[#008f6f] transition"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </>
  )
}
