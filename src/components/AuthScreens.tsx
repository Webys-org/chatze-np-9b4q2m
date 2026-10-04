import React, { useState } from 'react'
import { MessageSquare, Lock, ArrowRight } from 'lucide-react'

export function AuthScreens({ onLoginSuccess }: { onLoginSuccess: (user: any, token?: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (res.ok && data.user) {
        onLoginSuccess(data.user, data.token)
      } else {
        setError(data.error || 'Incorrect username or password')
      }
    } catch (err: any) {
      setError(err?.message || 'Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0b141a] flex items-center justify-center p-4 font-sans select-none">
      <div className="max-w-md w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-6 sm:p-8 shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884] mb-1">
            <MessageSquare className="w-8 h-8 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-[#e9edef] tracking-tight">
            Chatze WhatsApp
          </h1>
          <p className="text-xs text-[#8696a0]">
            Sign in to unlock your personal edge messages
          </p>
        </div>

        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
            {error}
          </div>
        )}

        <form onSubmit={handleSignIn} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8696a0]">Admin Username</label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-[#8696a0] text-sm">@</span>
              <input
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your_handle"
                className="w-full pl-8 pr-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[#8696a0]">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="w-full py-3 px-4 bg-[#00a884] hover:bg-[#02906f] disabled:opacity-50 text-[#111b21] font-bold rounded-xl text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#00a884]/20 cursor-pointer"
          >
            {loading ? 'Unlocking...' : 'Unlock My Messages'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="text-[11px] text-center text-[#8696a0] leading-relaxed">
          This is an independent deployable instance. Contacts connect from their own instances via Friend Requests.
        </p>
      </div>
    </div>
  )
}
