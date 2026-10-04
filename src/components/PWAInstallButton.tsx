import React, { useState } from 'react'
import { Download, Smartphone, X } from 'lucide-react'
import { usePWAInstall } from '../hooks/usePWAInstall'

export const PWAInstallButton: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall()
  const [showGuide, setShowGuide] = useState(false)

  // If already running as an installed standalone PWA, hide the button
  if (isInstalled) {
    return null
  }

  const renderInstallGuideModal = () => {
    if (!showGuide) return null

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
        <div className="w-full max-w-sm rounded-2xl bg-[#111b21] border border-[#222d34] p-5 shadow-2xl text-slate-200">
          <div className="flex items-center justify-between pb-3 border-b border-[#222d34]">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-[#00a884]/20 flex items-center justify-center text-[#00a884]">
                <Smartphone className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-semibold text-white">
                {isIOS ? 'Install on iPhone / iPad' : 'Install Chatze App'}
              </h3>
            </div>
            <button
              onClick={() => setShowGuide(false)}
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-[#202c33] transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-4 space-y-3 text-xs text-[#8696a0]">
            {isIOS ? (
              <>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-white flex items-center justify-center shrink-0 font-bold">1</span>
                  <p>Tap the <strong className="text-white">Share</strong> button (box with upward arrow) in the Safari toolbar at the bottom.</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-white flex items-center justify-center shrink-0 font-bold">2</span>
                  <p>Scroll down and select <strong className="text-white">Add to Home Screen</strong>.</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-white flex items-center justify-center shrink-0 font-bold">3</span>
                  <p>Launch Chatze from your home screen for 0ms offline loads and full-screen experience.</p>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-[#00a884] flex items-center justify-center shrink-0 font-bold">PC</span>
                  <p>On Chrome/Edge/Brave, look for the <strong className="text-white">Install App</strong> icon in the address bar (right side).</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-[#00a884] flex items-center justify-center shrink-0 font-bold">📱</span>
                  <p>On Android, tap the <strong className="text-white">three dots menu</strong> (⋮) and tap <strong className="text-white">Install app</strong> or <strong className="text-white">Add to Home screen</strong>.</p>
                </div>
                <div className="flex items-start gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-[#202c33] text-white flex items-center justify-center shrink-0 font-bold">⚡</span>
                  <p>Opens as a standalone desktop/mobile app with instant local IndexedDB loading and zero server resource overhead.</p>
                </div>
              </>
            )}
          </div>

          <button
            onClick={() => setShowGuide(false)}
            className="mt-5 w-full rounded-lg bg-[#00a884] py-2 text-xs font-semibold text-slate-950 hover:bg-[#008f6f] transition"
          >
            Got It
          </button>
        </div>
      </div>
    )
  }

  // Chromium / Android / Desktop direct prompt flow
  if (isInstallable) {
    return (
      <>
        <button
          onClick={install}
          className={`flex items-center gap-1.5 rounded-lg bg-[#00a884] hover:bg-[#008f6f] text-slate-950 font-semibold px-3 py-1.5 text-xs transition shadow-sm ${className}`}
          title="Install Chatze on your device"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Install App</span>
        </button>
        {renderInstallGuideModal()}
      </>
    )
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowGuide(true)}
          className={`flex items-center gap-1.5 rounded-lg bg-[#202c33] hover:bg-[#2a3942] text-[#00a884] border border-[#00a884]/40 font-medium px-2.5 py-1 text-xs transition ${className}`}
          title="Install on iPhone / iPad"
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span>Install iOS</span>
        </button>
        {renderInstallGuideModal()}
      </>
    )
  }

  // Desktop general fallback when beforeinstallprompt is pending or on supported desktop browsers
  return (
    <>
      <button
        onClick={() => {
          if (isInstallable) {
            install()
          } else {
            setShowGuide(true)
          }
        }}
        className={`flex items-center gap-1.5 rounded-lg bg-[#202c33] hover:bg-[#2a3942] text-[#8696a0] hover:text-[#00a884] font-medium px-2.5 py-1 text-xs transition border border-[#222e35] ${className}`}
        title="Install Chatze on PC, Mac, or Phone"
      >
        <Download className="w-3.5 h-3.5 text-[#00a884]" />
        <span>Install App</span>
      </button>
      {renderInstallGuideModal()}
    </>
  )
}
