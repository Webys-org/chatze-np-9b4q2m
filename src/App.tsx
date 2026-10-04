import React, { useState, useEffect } from 'react'
import { SetupWizard } from './components/SetupWizard'
import { AuthScreens } from './components/AuthScreens'
import { MessagingApp } from './components/MessagingApp'

export function App() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null)
  const [displayName, setDisplayName] = useState('Chatze User')
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function checkState() {
      try {
        const setupRes = await fetch('/api/setup/status')
        if (setupRes.ok) {
          const setupData = await setupRes.json()
          if (setupData.setupRequired) {
            setSetupRequired(true)
            setLoading(false)
            return
          }
          setSetupRequired(false)
          if (setupData.displayName) setDisplayName(setupData.displayName)
        } else {
          setSetupRequired(true)
          setLoading(false)
          return
        }

        // Check device token in localStorage
        const storedToken = localStorage.getItem('chatze_auth_token')
        if (!storedToken) {
          // Device has not logged in -> must enter password
          setCurrentUser(null)
          setLoading(false)
          return
        }

        const sessionRes = await fetch('/api/auth/session', {
          headers: {
            Authorization: `Bearer ${storedToken}`,
          },
        })
        if (sessionRes.ok) {
          const sessionData = await sessionRes.json()
          if (sessionData.user) {
            setCurrentUser(sessionData.user)
          } else {
            localStorage.removeItem('chatze_auth_token')
            setCurrentUser(null)
          }
        } else {
          localStorage.removeItem('chatze_auth_token')
          setCurrentUser(null)
        }
      } catch (err) {
        console.warn('App init status check error', err)
      } finally {
        setLoading(false)
      }
    }
    checkState()
  }, [])

  const handleLogout = async () => {
    const token = localStorage.getItem('chatze_auth_token')
    if (token) {
      fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
      localStorage.removeItem('chatze_auth_token')
    }
    setCurrentUser(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0b141a] flex flex-col items-center justify-center text-[#8696a0] gap-3 font-sans">
        <div className="w-8 h-8 border-2 border-[#00a884] border-t-transparent rounded-full animate-spin"></div>
        <p className="text-xs font-medium tracking-wide">Connecting to Edge Cloud...</p>
      </div>
    )
  }

  if (setupRequired) {
    return (
      <SetupWizard
        onComplete={(name, handle, token) => {
          if (token) localStorage.setItem('chatze_auth_token', token)
          setDisplayName(name)
          setSetupRequired(false)
          setCurrentUser({
            id: 'usr_admin',
            handle: handle || 'admin',
            display_name: name,
            role: 'admin',
          })
        }}
      />
    )
  }

  if (!currentUser) {
    return (
      <AuthScreens
        onLoginSuccess={(user, token) => {
          if (token) localStorage.setItem('chatze_auth_token', token)
          setCurrentUser(user)
        }}
      />
    )
  }

  return (
    <MessagingApp
      currentUser={currentUser}
      businessName={displayName}
      onLogout={handleLogout}
    />
  )
}

export default App
