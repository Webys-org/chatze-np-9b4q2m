import React, { useState } from 'react'
import { MessageSquare, ShieldCheck, Sparkles, ArrowRight, User } from 'lucide-react'

export function SetupWizard({ onComplete }: { onComplete: (displayName: string, handle: string, token?: string) => void }) {
  const [displayName, setDisplayName] = useState('')
  const [adminUsername, setAdminUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!displayName.trim() || !adminUsername.trim() || !password) {
      setError('Please fill in your name, username, and password')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, adminUsername, password }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        onComplete(displayName, data.user?.handle || adminUsername, data.token)
      } else {
        setError(data.error || 'Failed to complete setup')
      }
    } catch (err: any) {
      setError(err?.message || 'Network error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0b141a] flex items-center justify-center p-4 font-sans select-none">
      <div className="max-w-md w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884] mb-1">
            <MessageSquare className="w-8 h-8 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-[#e9edef] tracking-tight">Chatze (WhatsApp at Edge)</h1>
          <p className="text-xs text-[#8696a0]">
            Independent Personal Messaging • Deployed on your Cloudflare Subdomain
          </p>
        </div>

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8696a0]">Your Full Name / Display Name</label>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Yogesh Singh"
              className="w-full px-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8696a0]">Your Username / Handle</label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-[#8696a0] text-sm">@</span>
              <input
                type="text"
                required
                value={adminUsername}
                onChange={(e) => setAdminUsername(e.target.value)}
                placeholder="e.g. yogesh"
                className="w-full pl-8 pr-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
              />
            </div>
            <p className="text-[10px] text-[#8696a0] pl-1">
              Friends will connect to you using @{adminUsername || 'username'} and your instance URL.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8696a0]">Admin Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create your admin password"
              className="w-full px-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
            />
          </div>

          <div className="p-3 bg-[#0b141a]/60 border border-[#202c33] rounded-xl space-y-1.5 text-xs text-[#8696a0]">
            <div className="flex items-center gap-2 text-[#00a884] font-medium">
              <ShieldCheck className="w-4 h-4" /> Zero-Setup Independent Instance:
            </div>
            <ul className="list-disc list-inside space-y-0.5 pl-1 text-[11px]">
              <li>You own this instance — only you can log in as admin</li>
              <li>Other users connect from their own instances via Friend Requests</li>
              <li>End-to-End WebCrypto ECDSA verification and 0ms streaming</li>
            </ul>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 px-4 bg-[#00a884] hover:bg-[#02906f] disabled:opacity-50 text-[#111b21] font-bold rounded-xl text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#00a884]/20 cursor-pointer"
          >
            {submitting ? 'Initializing...' : 'Launch My Chatze WhatsApp'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  )
}
