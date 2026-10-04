import React, { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'

export const OfflineIndicator: React.FC = () => {
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  if (isOnline) return null

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl bg-amber-500/95 text-slate-950 font-medium px-3 py-2 text-xs shadow-lg backdrop-blur-sm animate-in fade-in">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Offline Mode — Cached local data active</span>
    </div>
  )
}
