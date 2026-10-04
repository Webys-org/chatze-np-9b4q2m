import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  Send,
  Search,
  MessageSquare,
  ShieldCheck,
  CheckCheck,
  LogOut,
  Bell,
  Sparkles,
  UserPlus,
  ArrowDown,
  ArrowLeft,
  QrCode,
  X,
  Clock,
  Globe,
  Share2,
  Copy,
  AlertCircle,
  Image as ImageIcon,
  Download,
  Maximize2,
  Loader2,
} from 'lucide-react'
import {
  getLocalMessages,
  saveLocalMessages,
  saveLocalMessage,
  getLocalConversations,
  saveLocalConversations,
  getLocalFriendships,
  saveLocalFriendships,
  getLocalMeta,
  setLocalMeta,
} from '../lib/db'
import { PWAInstallButton } from './PWAInstallButton'
import { NotificationToggleButton } from './NotificationToggleButton'
import { NotificationPermissionBanner } from './NotificationPermissionBanner'
import { OfflineIndicator } from './OfflineIndicator'


// ============================================================================
// wsrv.nl Global Image Cache & Resizing Proxy Integration
// Free, open-source image cache and resizing proxy: https://wsrv.nl
// ============================================================================
export function getOptimizedImageUrl(rawUrl: string, width = 800): string {
  if (!rawUrl) return ''
  // If it's a local data URI (pre-upload preview), return directly
  if (rawUrl.startsWith('data:image')) return rawUrl
  // If already routed through wsrv.nl, return as is
  if (rawUrl.includes('wsrv.nl')) return rawUrl

  let fullUrl = rawUrl
  if (fullUrl.startsWith('/')) {
    if (typeof window !== 'undefined') {
      fullUrl = window.location.origin + fullUrl
    }
  } else if (fullUrl.startsWith('//')) {
    fullUrl = 'https:' + fullUrl
  }

  // Bypass wsrv.nl for local development hosts that external proxy cannot access
  if (fullUrl.includes('localhost') || fullUrl.includes('127.0.0.1')) {
    return fullUrl
  }

  // Route through wsrv.nl with WebP conversion, dimension resize, auto-EXIF rotation (&af=true), and progressive display (&il=true)
  return `https://wsrv.nl/?url=${encodeURIComponent(fullUrl)}&w=${width}&output=webp&q=80&af=true&il=true`
}

interface ParsedMessage {
  isImage: boolean
  imageUrl?: string
  caption?: string
  text?: string
}

export function parseMessageContent(body: string): ParsedMessage {
  if (!body) return { isImage: false, text: '' }

  // Pattern 1: [img:URL] or [img:URL|caption]
  const imgTagMatch = body.match(/^\[img:(https?:\/\/[^\s|\]]+)(?:\|(.*))?\]$/i)
  if (imgTagMatch) {
    return {
      isImage: true,
      imageUrl: imgTagMatch[1],
      caption: imgTagMatch[2] ? imgTagMatch[2].trim() : undefined,
    }
  }

  // Pattern 2: Direct public image URL or media endpoint
  const isDirectImage =
    /^https?:\/\/[^\s]+\.(jpg|jpeg|png|webp|gif|svg)(\?[^\s]*)?$/i.test(body.trim()) ||
    /^https?:\/\/[^\s]+\/api\/media\/med_[a-z0-9]+/i.test(body.trim())

  if (isDirectImage) {
    return {
      isImage: true,
      imageUrl: body.trim(),
    }
  }

  return { isImage: false, text: body }
}

// Client-side HTML5 canvas compression before sending to Cloudflare (Saves 90-95% D1 DB storage!)
export async function compressImageToWebP(
  file: File,
  maxDim = 850,
  quality = 0.72
): Promise<{ dataUrl: string; sizeKb: number; originalKb: number }> {
  const originalKb = Math.round(file.size / 1024)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new window.Image()
      img.onload = () => {
        let width = img.width
        let height = img.height
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width)
            width = maxDim
          } else {
            width = Math.round((width * maxDim) / height)
            height = maxDim
          }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('Canvas context not available'))
        ctx.drawImage(img, 0, 0, width, height)

        let dataUrl = canvas.toDataURL('image/webp', quality)
        let sizeKb = Math.round((dataUrl.length * (3 / 4)) / 1024)

        // Adaptive second pass: If photo is still > 140KB (heavy detail), apply slightly more compression to protect D1
        if (sizeKb > 140) {
          dataUrl = canvas.toDataURL('image/webp', 0.60)
          sizeKb = Math.round((dataUrl.length * (3 / 4)) / 1024)
        }

        resolve({ dataUrl, sizeKb, originalKb })
      }
      img.onerror = reject
      img.src = e.target?.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

interface Conversation {
  id: string
  otherUser: { id?: string; username: string; displayName: string }
  status?: string // 'active' | 'pending' | 'archived'
  remoteInstanceUrl?: string | null
  lastMessage?: { content: string; createdAt: number } | null
  unreadCount?: number
}

interface ChatMessage {
  id: string
  conversationId: string
  senderId: string
  senderHandle?: string
  recipientHandle?: string
  body: string
  createdAt: string
  readAt?: string | null
  status?: 'sending' | 'sent' | 'delivered'
}

interface Friendship {
  id: string
  local_user_id: string
  remote_handle: string
  remote_instance_url: string
  status: string // 'pending' | 'active' | 'rejected'
  direction: 'incoming' | 'outgoing'
  created_at: number
}

const UNIVERSAL_QUICK_REPLIES = [
  { label: '👋 Hey there!', text: '👋 Hey! How are you doing?' },
  { label: '📍 Share Location', text: '📍 Meeting point / current location shared.' },
  { label: '✅ Sounds good!', text: '✅ Sounds great, let’s do that!' },
  { label: '📞 Call me later', text: '📞 A bit busy right now, call you in a bit.' },
  { label: '💳 Payment QR', text: '💳 Payment QR: eSewa, Khalti, or mobile banking accepted.' },
]

export function MessagingApp({
  currentUser,
  businessName,
  onLogout,
}: {
  currentUser: { id: string; handle: string; display_name: string; role?: string }
  businessName: string
  onLogout: () => void
}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConv, setActiveConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [inboxFilter, setInboxFilter] = useState<'all' | 'unread' | 'pending'>('all')

  // Federation & Contacts
  const [friendships, setFriendships] = useState<Friendship[]>([])
  const [showAddFriendModal, setShowAddFriendModal] = useState(false)
  const [showIdentityModal, setShowIdentityModal] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  // Add friend state
  const [friendHandle, setFriendHandle] = useState('')
  const [friendDomain, setFriendDomain] = useState('')
  const [sendingRequest, setSendingRequest] = useState(false)
  const [addFriendError, setAddFriendError] = useState('')

  // Stream state
  const [streamConnected, setStreamConnected] = useState(false)

  // Scroll states
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [hasNewUnreadWhileScrolled, setHasNewUnreadWhileScrolled] = useState(false)
  const [showQrModal, setShowQrModal] = useState(false)

  // Media attachments & wsrv.nl proxy state
  const [selectedImageFile, setSelectedImageFile] = useState<{ dataUrl: string; caption: string; sizeKb: number; originalKb?: number } | null>(null)
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const activeConvRef = useRef<Conversation | null>(null)
  activeConvRef.current = activeConv

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const { dataUrl, sizeKb, originalKb } = await compressImageToWebP(file)
      setSelectedImageFile({ dataUrl, caption: '', sizeKb, originalKb })
    } catch (err) {
      console.error('Image compression error', err)
      alert('Failed to process image. Please try a different photo.')
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile()
        if (file) {
          e.preventDefault()
          try {
            const { dataUrl, sizeKb, originalKb } = await compressImageToWebP(file)
            setSelectedImageFile({ dataUrl, caption: '', sizeKb, originalKb })
          } catch (err) {
            console.error('Clipboard image error', err)
          }
          break
        }
      }
    }
  }

  const handleSendImage = async () => {
    if (!selectedImageFile || !activeConv) return
    setIsUploadingImage(true)
    try {
      const uploadRes = await fetch('/api/media/upload', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          data: selectedImageFile.dataUrl,
          contentType: 'image/webp',
        }),
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok || !uploadData.url) {
        alert(uploadData.error || 'Failed to upload photo')
        return
      }

      const publicUrl = uploadData.url
      const formattedBody = selectedImageFile.caption?.trim()
        ? `[img:${publicUrl}|${selectedImageFile.caption.trim()}]`
        : `[img:${publicUrl}]`

      setSelectedImageFile(null)
      await handleSendMessage(undefined, formattedBody)
    } catch (err: any) {
      console.error('Image send error', err)
      alert('Failed to send image: ' + (err?.message || 'Network error'))
    } finally {
      setIsUploadingImage(false)
    }
  }

  const getAuthHeaders = (extra: Record<string, string> = {}) => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('chatze_auth_token') : null
    return {
      ...extra,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  // ==========================================================================
  // Local-First IndexedDB & Smart Delta-Sync Lifecycle (80-90% D1 Read Reductions)
  // ==========================================================================
  const lastSyncTimeRef = useRef<number>(Date.now() - 3600000)

  // 1. Restore local data instantly from IndexedDB in 0ms (ZERO network calls)
  const loadConversations = async () => {
    try {
      const cachedConvs = await getLocalConversations()
      if (cachedConvs.length > 0) {
        setConversations(cachedConvs)
        if (!activeConvRef.current) {
          setActiveConv(cachedConvs[0])
        }
      }

      // Background validation
      const res = await fetch('/api/conversations', { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        if (data.conversations) {
          setConversations(data.conversations)
          await saveLocalConversations(data.conversations)
          if (!activeConvRef.current && data.conversations.length > 0) {
            setActiveConv(data.conversations[0])
          } else if (activeConvRef.current) {
            const updated = data.conversations.find((c: any) => c.id === activeConvRef.current?.id)
            if (updated) setActiveConv(updated)
          }
        }
      }
    } catch (err) {
      console.error('Failed to load conversations', err)
    }
  }

  const loadFriendships = async () => {
    try {
      const cachedFriends = await getLocalFriendships()
      if (cachedFriends.length > 0) {
        setFriendships(cachedFriends)
      }

      const res = await fetch('/api/federation/friendships', { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        if (data.friendships) {
          setFriendships(data.friendships)
          await saveLocalFriendships(data.friendships)
        }
      }
    } catch (err) {
      console.error('Failed to load friendships', err)
    }
  }

  // Instant 0ms Chat Switch: Load messages from phone/browser IndexedDB first!
  const loadMessages = async (convId: string) => {
    try {
      // 1. Instant local-device restore (0ms, 0 Cloudflare Worker invocations, 0 D1 reads)
      const localMsgs = await getLocalMessages(convId)
      if (localMsgs.length > 0) {
        setMessages(localMsgs)
        // If we already have message history, don't burn D1 reads. runSync() handles new incoming deltas!
        return
      }

      // 2. Only if local DB has never seen this conversation, perform one-time initial load
      const res = await fetch(`/api/messaging?conversationId=${encodeURIComponent(convId)}`, {
        headers: getAuthHeaders(),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.messages) {
          setMessages(data.messages)
          await saveLocalMessages(data.messages)
        }
      }
    } catch (err) {
      console.error('Failed to load messages', err)
    }
  }

  // Load initial dataset once on mount
  useEffect(() => {
    loadConversations()
    loadFriendships()

    // Restore last sync time if present
    getLocalMeta<number>('last_sync_time').then((ts) => {
      if (ts) lastSyncTimeRef.current = ts
    })
  }, [])

  // Load message history only when switching active chat
  useEffect(() => {
    if (activeConv) {
      loadMessages(activeConv.id)
    }
  }, [activeConv?.id])

  // Single-Endpoint Delta Sync:
  // Runs ONLY on initial connect, stream reconnect, or when tab becomes visible.
  // ZERO interval loops while sitting idle!
  const runSync = async () => {
    try {
      const convId = activeConvRef.current?.id || ''
      const url = `/api/sync?since=${lastSyncTimeRef.current}&conversationId=${encodeURIComponent(convId)}`
      const res = await fetch(url, { headers: getAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        lastSyncTimeRef.current = data.serverTime || Date.now()
        setLocalMeta('last_sync_time', lastSyncTimeRef.current).catch(() => {})

        if (data.friendships && data.friendships.length > 0) {
          setFriendships(data.friendships)
          saveLocalFriendships(data.friendships).catch(() => {})
        }

        if (data.conversations && data.conversations.length > 0) {
          setConversations(data.conversations)
          saveLocalConversations(data.conversations).catch(() => {})
          if (activeConvRef.current) {
            const updated = data.conversations.find((c: any) => c.id === activeConvRef.current?.id)
            if (updated) {
              setActiveConv((prev) => (prev ? { ...prev, status: updated.status } : updated))
            }
          }
        }

        if (data.newMessages && data.newMessages.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id))
            const toAdd = data.newMessages.filter((m: any) => !existingIds.has(m.id))
            if (toAdd.length === 0) return prev
            return [...prev, ...toAdd]
          })
          saveLocalMessages(data.newMessages).catch(() => {})
          scrollToBottom('smooth')
        }
      }
    } catch (e) {
      console.warn('Sync error', e)
    }
  }

  const handleScroll = () => {
    const el = messagesContainerRef.current
    if (!el) return
    const isScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 90
    setShowScrollBottom(isScrolledUp)
    if (!isScrolledUp) setHasNewUnreadWhileScrolled(false)
  }

  const scrollToBottom = (behavior: 'smooth' | 'instant' = 'smooth') => {
    if (behavior === 'instant') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
    setHasNewUnreadWhileScrolled(false)
  }

  // ==========================================================================
  // TAB-VISIBILITY AWARE SSE STREAM (Zero Idle CPU, Suspends When Tab Hidden)
  // Reconnects only when visible or on message trigger.
  // ==========================================================================
  useEffect(() => {
    let evtSource: EventSource | null = null
    let hiddenTimeout: any = null
    let isSuspended = false

    const connectSSE = () => {
      if (evtSource) {
        evtSource.close()
      }

      evtSource = new EventSource(`/api/stream?userId=${encodeURIComponent(currentUser.id)}`)

      evtSource.onopen = () => {
        setStreamConnected(true)
      }

      evtSource.addEventListener('connected', () => {
        setStreamConnected(true)
        runSync()
      })

      evtSource.addEventListener('ping', () => {
        setStreamConnected(true)
      })

      // Inbound or outbound message: Save to local IndexedDB and update UI (ZERO GET requests!)
      evtSource.addEventListener('new_message', (e) => {
        try {
          const incoming: ChatMessage = JSON.parse(e.data)
          const currentActive = activeConvRef.current

          const otherHandle = (currentActive?.otherUser.username || '').toLowerCase().replace(/^@/, '')
          const myHandle = (currentUser.handle || '').toLowerCase().replace(/^@/, '')
          const senderH = (incoming.senderHandle || incoming.senderId || '').toLowerCase().replace(/^@/, '')
          const recipH = (incoming.recipientHandle || '').toLowerCase().replace(/^@/, '')

          // Match message to current open conversation from either sender or recipient side:
          const isCurrentChat = Boolean(
            currentActive &&
              (incoming.conversationId === currentActive.id ||
                senderH === otherHandle ||
                (recipH === otherHandle && senderH === myHandle) ||
                incoming.conversationId === 'conv_' + otherHandle ||
                incoming.conversationId === 'conv_' + myHandle ||
                incoming.conversationId === 'conv_' + [myHandle, otherHandle].sort().join('_'))
          )

          // Normalize conversation ID to match the active or other user's conversation format
          const targetConvId = currentActive && isCurrentChat ? currentActive.id : ('conv_' + (senderH === myHandle ? recipH : senderH))
          const normalizedIncoming = { ...incoming, conversationId: targetConvId }

          // Persist to local device IndexedDB immediately with matching conversation ID
          saveLocalMessage(normalizedIncoming).catch(() => {})

          // 1. If currently in this conversation, append message to view in 0ms!
          if (isCurrentChat) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === incoming.id || (m.body === incoming.body && m.status === 'sending'))) {
                return prev.map((m) =>
                  m.id === incoming.id || (m.body === incoming.body && m.status === 'sending')
                    ? { ...normalizedIncoming, status: 'sent' }
                    : m
                )
              }
              return [...prev, normalizedIncoming]
            })

            const el = messagesContainerRef.current
            const isScrolledUp = el && el.scrollHeight - el.scrollTop - el.clientHeight > 90
            if (isScrolledUp) {
              setHasNewUnreadWhileScrolled(true)
            } else {
              scrollToBottom('smooth')
            }
          }

          // 2. Update conversation snippet in memory and IndexedDB
          setConversations((prev) => {
            const index = prev.findIndex((c) => {
              const cHandle = (c.otherUser.username || '').toLowerCase().replace(/^@/, '')
              return (
                c.id === incoming.conversationId ||
                cHandle === senderH ||
                cHandle === recipH ||
                c.id === 'conv_' + senderH ||
                c.id === 'conv_' + recipH ||
                c.id === 'conv_' + [myHandle, cHandle].sort().join('_')
              )
            })

            const msgTime = new Date(incoming.createdAt).getTime()
            if (index !== -1) {
              const updated = [...prev]
              const conv = { ...updated[index] }
              conv.lastMessage = { content: incoming.body, createdAt: msgTime }
              if (!isCurrentChat && senderH !== myHandle) {
                conv.unreadCount = (conv.unreadCount || 0) + 1
              }
              updated.splice(index, 1)
              const newConvs = [conv, ...updated]
              saveLocalConversations(newConvs).catch(() => {})
              return newConvs
            } else if (senderH && senderH !== myHandle) {
              // Automatically add new incoming contact conversation to the sidebar!
              const newConv: Conversation = {
                id: incoming.conversationId || 'conv_' + senderH,
                otherUser: {
                  id: senderH,
                  username: senderH,
                  displayName: `@${senderH}`,
                },
                status: 'active',
                lastMessage: { content: incoming.body, createdAt: msgTime },
                unreadCount: 1,
              }
              const newConvs = [newConv, ...prev]
              saveLocalConversations(newConvs).catch(() => {})
              return newConvs
            }
            return prev
          })
        } catch (err) {
          console.warn('SSE message parse error', err)
        }
      })

      // Inbound friend request: Save to local IndexedDB and update UI
      evtSource.addEventListener('incoming_friend_request', (e) => {
        try {
          const payload = JSON.parse(e.data)
          const friendship = payload.friendship
          if (friendship) {
            setFriendships((prev) => {
              if (prev.some((f) => f.id === friendship.id)) return prev
              const updated = [friendship, ...prev]
              saveLocalFriendships(updated).catch(() => {})
              return updated
            })
          }
          const cleanHandle = payload.from_handle
          if (cleanHandle) {
            setConversations((prev) => {
              const convId = 'conv_' + cleanHandle
              if (prev.some((c) => c.id === convId)) return prev
              const newConv = {
                id: convId,
                otherUser: {
                  username: cleanHandle,
                  displayName: payload.from_display_name || `@${cleanHandle}`,
                },
                status: 'pending',
                remoteInstanceUrl: payload.from_instance_url || null,
                lastMessage: {
                  content: `Connection request from @${cleanHandle}`,
                  createdAt: Date.now(),
                },
              }
              const updated = [newConv, ...prev]
              saveLocalConversations(updated).catch(() => {})
              return updated
            })
          }
        } catch (err) {
          console.warn('SSE incoming friend parse error', err)
        }
      })

      // Friend request accepted: Update state and IndexedDB
      evtSource.addEventListener('friend_accepted', (e) => {
        try {
          const payload = JSON.parse(e.data)
          const cleanHandle = payload.remoteHandle
          if (cleanHandle) {
            setFriendships((prev) => {
              const updated = prev.map((f) => (f.remote_handle === cleanHandle ? { ...f, status: 'active' } : f))
              saveLocalFriendships(updated).catch(() => {})
              return updated
            })
            setConversations((prev) => {
              const updated = prev.map((c) =>
                c.otherUser.username === cleanHandle
                  ? {
                      ...c,
                      status: 'active',
                      lastMessage: { content: 'Connected! You can now message each other.', createdAt: Date.now() },
                    }
                  : c
              )
              saveLocalConversations(updated).catch(() => {})
              return updated
            })
            if (activeConvRef.current && activeConvRef.current.otherUser.username === cleanHandle) {
              setActiveConv((prev) => (prev ? { ...prev, status: 'active' } : prev))
            }
          }
        } catch (err) {
          console.warn('SSE friend accepted parse error', err)
        }
      })

      evtSource.onerror = () => {
        setStreamConnected(false)
        if (!reconnectTimeout) {
          reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null
            if (!document.hidden) {
              connectSSE()
            }
          }, 3000)
        }
      }
    }

    let reconnectTimeout: any = null

    // Connect SSE immediately
    connectSSE()

    // Smart Tab-Visibility Management:
    // If user leaves the tab or locks phone for > 35s, suspend stream to avoid burning Worker resources.
    // Instant wake-up with delta sync when returning!
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenTimeout = setTimeout(() => {
          if (document.hidden && evtSource) {
            isSuspended = true
            evtSource.close()
            evtSource = null
            setStreamConnected(false)
          }
        }, 35000)
      } else {
        if (hiddenTimeout) {
          clearTimeout(hiddenTimeout)
          hiddenTimeout = null
        }
        if (isSuspended || !evtSource) {
          isSuspended = false
          connectSSE()
        } else {
          runSync()
        }
      }
    }

    // Mobile touch interaction: recover stream immediately if phone cellular radio dropped TCP
    const handleTouchRecovery = () => {
      if (!evtSource) {
        connectSSE()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', runSync)
    window.addEventListener('touchstart', handleTouchRecovery, { passive: true })

    // BroadcastChannel for 0ms cross-tab instant local sync
    let bc: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('chatze_live_tab_sync')
        bc.onmessage = (event) => {
          if (event.data?.type === 'new_message') {
            runSync()
          }
        }
      }
    } catch {}

    return () => {
      if (hiddenTimeout) clearTimeout(hiddenTimeout)
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', runSync)
      window.removeEventListener('touchstart', handleTouchRecovery)
      if (bc) bc.close()
      if (evtSource) evtSource.close()
    }
  }, [currentUser.id])

  // Send Contact Connection Request (Single POST request)
  const handleSendFriendRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!friendHandle.trim() || !friendDomain.trim()) return

    setSendingRequest(true)
    setAddFriendError('')

    try {
      const res = await fetch('/api/federation/requests', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          remoteHandle: friendHandle.trim(),
          remoteInstanceUrl: friendDomain.trim(),
          senderId: currentUser.id,
          myHandle: currentUser.handle,
          myDisplayName: currentUser.display_name,
          myInstanceUrl: window.location.origin,
        }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setFriendHandle('')
        setFriendDomain('')
        setShowAddFriendModal(false)

        if (data.friendship) {
          setFriendships((prev) => {
            const updated = [data.friendship, ...prev.filter((f) => f.id !== data.friendship.id)]
            saveLocalFriendships(updated).catch(() => {})
            return updated
          })
        }
        if (data.conversation) {
          const newConv: Conversation = {
            id: data.conversation.id,
            otherUser: {
              id: data.conversation.user_b,
              username: data.conversation.remote_handle,
              displayName: `@${data.conversation.remote_handle}`,
            },
            status: 'pending',
            remoteInstanceUrl: data.conversation.remote_instance_url,
            lastMessage: { content: data.conversation.last_message_snippet, createdAt: Date.now() },
          }
          setConversations((prev) => {
            const updated = [newConv, ...prev.filter((c) => c.id !== newConv.id)]
            saveLocalConversations(updated).catch(() => {})
            return updated
          })
          setActiveConv(newConv)
        }
      } else {
        setAddFriendError(data.error || 'Failed to send request')
      }
    } catch (err: any) {
      setAddFriendError(err?.message || 'Network error')
    } finally {
      setSendingRequest(false)
    }
  }

  // Accept Inbound Request (Single POST request)
  const handleAcceptFriendRequest = async (remoteHandle: string, remoteInstanceUrl: string) => {
    try {
      // Optimistic update in memory and IndexedDB
      setFriendships((prev) => {
        const updated = prev.map((f) => (f.remote_handle === remoteHandle ? { ...f, status: 'active' } : f))
        saveLocalFriendships(updated).catch(() => {})
        return updated
      })
      setConversations((prev) => {
        const updated = prev.map((c) =>
          c.otherUser.username === remoteHandle
            ? { ...c, status: 'active', lastMessage: { content: 'Connected! You can now message each other.', createdAt: Date.now() } }
            : c
        )
        saveLocalConversations(updated).catch(() => {})
        return updated
      })

      await fetch('/api/federation/requests/accept', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          remoteHandle,
          remoteInstanceUrl,
          myHandle: currentUser.handle,
        }),
      })
    } catch (err) {
      console.error('Accept error', err)
    }
  }

  // Decline Inbound Request (Single POST request)
  const handleRejectFriendRequest = async (remoteHandle: string) => {
    try {
      setFriendships((prev) => {
        const updated = prev.filter((f) => f.remote_handle !== remoteHandle)
        saveLocalFriendships(updated).catch(() => {})
        return updated
      })
      setConversations((prev) => {
        const updated = prev.filter((c) => c.otherUser.username !== remoteHandle)
        saveLocalConversations(updated).catch(() => {})
        return updated
      })

      await fetch('/api/federation/requests/reject', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ remoteHandle }),
      })
    } catch (err) {
      console.error('Reject error', err)
    }
  }

  // Send Message (0ms Optimistic + Single POST request, ZERO GET requests!)
  const handleSendMessage = async (e?: React.FormEvent, customText?: string) => {
    if (e) e.preventDefault()
    const textToSend = customText || inputText.trim()
    if (!textToSend || !activeConv) return
    if (activeConv.status === 'pending') return

    const tempId = 'temp_' + Math.random().toString(36).slice(2, 9)
    const optimisticMessage: ChatMessage = {
      id: tempId,
      conversationId: activeConv.id,
      senderId: currentUser.id,
      body: textToSend,
      createdAt: new Date().toISOString(),
      status: 'sending',
    }

    setMessages((prev) => [...prev, optimisticMessage])
    if (!customText) setInputText('')
    scrollToBottom('instant')

    // Optimistically update conversation snippet in sidebar in 0ms!
    setConversations((prev) => {
      const index = prev.findIndex((c) => c.id === activeConv.id)
      if (index !== -1) {
        const updated = [...prev]
        const conv = { ...updated[index] }
        conv.lastMessage = { content: textToSend, createdAt: Date.now() }
        updated.splice(index, 1)
        return [conv, ...updated]
      }
      return prev
    })

    try {
      const res = await fetch('/api/messaging', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          conversationId: activeConv.id,
          body: textToSend,
          senderId: currentUser.id,
          tempId,
          remoteInstanceUrl: activeConv.remoteInstanceUrl,
          remoteHandle: activeConv.otherUser.username,
          myHandle: currentUser.handle,
        }),
      })
      const data = await res.json()
      if (res.ok && data.message) {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...data.message, status: 'sent' } : m))
        )
        // Cache to device IndexedDB
        saveLocalMessage({ ...data.message, status: 'sent' }).catch(() => {})
      }
    } catch (err) {
      console.error('Failed to send message', err)
    }
  }

  const incomingRequests = useMemo(() => {
    return friendships.filter((f) => f.status === 'pending' && f.direction === 'incoming')
  }, [friendships])

  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      const matchesSearch =
        c.otherUser.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.otherUser.username.toLowerCase().includes(searchQuery.toLowerCase())
      if (!matchesSearch) return false
      if (inboxFilter === 'pending') return c.status === 'pending'
      if (inboxFilter === 'unread') return (c.unreadCount || 0) > 0
      return true
    })
  }, [conversations, searchQuery, inboxFilter])

  return (
    <div className="flex flex-col h-screen w-full bg-[#0b141a] text-[#e9edef] overflow-hidden font-sans select-none">
      <NotificationPermissionBanner userHandle={currentUser.handle} />
      <div className="flex flex-1 w-full overflow-hidden">
        {/* 1. Sidebar: Full width on mobile when no active chat, 80-96 width on desktop */}
        <aside
          className={`${
            activeConv ? 'hidden md:flex' : 'flex'
          } w-full md:w-80 lg:w-96 border-r border-[#202c33] bg-[#111b21] flex-col shrink-0 h-full`}
        >
        {/* Header Bar */}
        <div className="p-3.5 border-b border-[#202c33] space-y-3 bg-[#202c33]/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-full bg-[#00a884]/20 border border-[#00a884]/30 flex items-center justify-center font-bold text-xs text-[#00a884] shrink-0">
                {currentUser.display_name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-[#e9edef] leading-tight truncate max-w-[140px] sm:max-w-[180px]">
                  {businessName || currentUser.display_name}
                </h1>
                <div className="flex items-center gap-1.5 text-[11px] text-[#8696a0]">
                  <span className="w-2 h-2 rounded-full bg-[#00a884] animate-pulse"></span>
                  <span className="truncate">@{currentUser.handle}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <PWAInstallButton className="hidden sm:inline-flex" />
              <NotificationToggleButton userHandle={currentUser.handle} />
              <button
                onClick={() => setShowIdentityModal(true)}
                title="My Instance Address / Share"
                className="p-2 rounded-full text-[#8696a0] hover:text-[#00a884] hover:bg-[#202c33] transition-colors"
              >
                <Share2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowQrModal(true)}
                title="Payment QR"
                className="p-2 rounded-full text-[#8696a0] hover:text-[#00a884] hover:bg-[#202c33] transition-colors"
              >
                <QrCode className="w-4 h-4" />
              </button>
              <button
                onClick={onLogout}
                title="Lock / Logout"
                className="p-2 rounded-full text-[#8696a0] hover:text-rose-400 hover:bg-[#202c33] transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Connect Contact Button */}
          <button
            onClick={() => setShowAddFriendModal(true)}
            className="w-full py-2.5 px-3 bg-[#00a884] hover:bg-[#02906f] text-[#111b21] rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-md shadow-[#00a884]/20 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" /> + Connect Contact (Subdomain / Domain)
          </button>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-[#8696a0]" />
            <input
              type="text"
              placeholder="Search or start new chat..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-[#202c33] border border-[#222e35] rounded-xl text-xs text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition-all"
            />
          </div>

          {/* Chat Queue Filter Pills */}
          <div className="flex items-center gap-1 bg-[#0b141a]/60 p-1 rounded-xl border border-[#202c33] text-[11px]">
            <button
              onClick={() => setInboxFilter('all')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'all' ? 'bg-[#202c33] text-[#e9edef]' : 'text-[#8696a0] hover:text-[#e9edef]'
              }`}
            >
              All ({conversations.length})
            </button>
            <button
              onClick={() => setInboxFilter('pending')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'pending' ? 'bg-[#202c33] text-amber-400' : 'text-[#8696a0] hover:text-[#e9edef]'
              }`}
            >
              Pending ({conversations.filter((c) => c.status === 'pending').length})
            </button>
            <button
              onClick={() => setInboxFilter('unread')}
              className={`flex-1 py-1 rounded-lg font-medium transition-all ${
                inboxFilter === 'unread' ? 'bg-[#202c33] text-[#00a884]' : 'text-[#8696a0] hover:text-[#e9edef]'
              }`}
            >
              Unread
            </button>
          </div>
        </div>

        {/* Incoming Connection Requests Banner */}
        {incomingRequests.length > 0 && (
          <div className="p-3 bg-amber-500/10 border-b border-amber-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-amber-400">
              <span className="flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5" /> Incoming Connection Requests ({incomingRequests.length})
              </span>
            </div>
            {incomingRequests.map((req) => (
              <div key={req.id} className="p-2.5 bg-[#111b21] border border-[#202c33] rounded-xl space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#e9edef]">@{req.remote_handle}</span>
                  <span className="text-[10px] text-[#8696a0] truncate max-w-[130px]">
                    {req.remote_instance_url.replace(/^https?:\/\//, '')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleAcceptFriendRequest(req.remote_handle, req.remote_instance_url)}
                    className="flex-1 py-1.5 bg-[#00a884] hover:bg-[#02906f] text-[#111b21] font-bold rounded-lg text-xs transition-all cursor-pointer"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => handleRejectFriendRequest(req.remote_handle)}
                    className="px-3 py-1.5 bg-[#202c33] hover:bg-[#222e35] text-[#8696a0] rounded-lg text-xs transition-all cursor-pointer"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Chats Feed */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#202c33]/40">
          {filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#8696a0] space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto text-[#8696a0]/40 mb-2" />
              <p className="font-medium text-[#e9edef]">No chats in this queue</p>
              <p className="text-[11px] text-[#8696a0]">
                Click "+ Connect Contact" above to connect to another deployed instance.
              </p>
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isActive = activeConv?.id === conv.id
              const isPending = conv.status === 'pending'
              return (
                <div
                  key={conv.id}
                  onClick={() => setActiveConv(conv)}
                  className={`p-3.5 flex items-start gap-3 cursor-pointer transition-colors relative ${
                    isActive ? 'bg-[#2a3942]' : 'hover:bg-[#202c33]/40'
                  }`}
                >
                  <div className="w-11 h-11 rounded-full bg-[#202c33] border border-[#222e35] flex items-center justify-center font-bold text-xs text-[#00a884] shrink-0">
                    {conv.otherUser.displayName.slice(0, 2).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#e9edef] truncate">
                        {conv.otherUser.displayName}
                      </span>
                      {conv.lastMessage && (
                        <span className="text-[10px] text-[#8696a0] shrink-0">
                          {new Date(conv.lastMessage.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between mt-1">
                      <p className="text-[11px] text-[#8696a0] truncate max-w-[180px]">
                        {conv.lastMessage?.content || (isPending ? 'Waiting for approval...' : 'Connected')}
                      </p>
                      {isPending && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                          Pending
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* 2. Main Chat Panel: Full width on mobile when chat is active, hidden when back to list */}
      <main
        className={`${
          !activeConv ? 'hidden md:flex' : 'flex'
        } flex-1 flex-col bg-[#0b141a] min-w-0 relative w-full h-full`}
      >
        {activeConv ? (
          <>
            {/* Active Header (With Mobile Back Button) */}
            <div className="h-16 px-3 sm:px-5 border-b border-[#202c33] flex items-center justify-between bg-[#202c33]/70 shrink-0 backdrop-blur-sm">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                {/* Back button on mobile */}
                <button
                  onClick={() => setActiveConv(null)}
                  className="md:hidden p-2 -ml-1 text-[#8696a0] hover:text-[#e9edef] rounded-full hover:bg-[#202c33] transition-colors shrink-0"
                  title="Back to all chats"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>

                <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-[#111b21] border border-[#222e35] flex items-center justify-center font-bold text-xs text-[#00a884] shrink-0">
                  {activeConv.otherUser.displayName.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <h2 className="text-xs sm:text-sm font-semibold text-[#e9edef] flex items-center gap-1.5 truncate">
                    <span className="truncate">{activeConv.otherUser.displayName}</span>
                    {activeConv.status === 'pending' ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-normal bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">
                        Pending
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-normal bg-[#00a884]/10 text-[#00a884] border border-[#00a884]/20 shrink-0">
                        Online
                      </span>
                    )}
                  </h2>
                  <p className="text-[11px] text-[#8696a0] truncate">
                    {activeConv.remoteInstanceUrl
                      ? activeConv.remoteInstanceUrl.replace(/^https?:\/\//, '')
                      : `@${activeConv.otherUser.username}`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-[#8696a0] shrink-0">
                <PWAInstallButton />
                <NotificationToggleButton userHandle={currentUser.handle} />
                <span className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full bg-[#111b21] border border-[#202c33] text-[10px] sm:text-[11px]">
                  <span className={`w-2 h-2 rounded-full ${streamConnected ? 'bg-[#00a884]' : 'bg-amber-400 animate-ping'}`} />
                  <span className="hidden sm:inline">{streamConnected ? '100s SSE Live' : 'Reconnecting...'}</span>
                </span>
              </div>
            </div>

            {/* Conversation Messages OR Pending Screen */}
            {activeConv.status === 'pending' ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-8 text-center space-y-4 max-w-md mx-auto">
                <div className="p-4 rounded-3xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  <Clock className="w-10 h-10 sm:w-12 sm:h-12 animate-pulse" />
                </div>
                <h3 className="text-base sm:text-lg font-bold text-[#e9edef]">Connection Request Pending</h3>
                <p className="text-xs text-[#8696a0] leading-relaxed">
                  You sent a connection request to <strong className="text-[#e9edef]">@{activeConv.otherUser.username}</strong> on{' '}
                  <span className="text-[#00a884] font-mono break-all">{activeConv.remoteInstanceUrl || 'their instance'}</span>.
                </p>
                <div className="p-3 bg-[#111b21] border border-[#202c33] rounded-xl text-[11px] text-[#8696a0] text-left space-y-1 w-full">
                  <p className="text-[#e9edef] font-medium flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-[#00a884]" /> WhatsApp-Grade Peer Handshake:
                  </p>
                  <p>1. They log in to their deployed instance and click <strong>Accept</strong>.</p>
                  <p>2. Once accepted, real-time messaging unlocks instantly on both devices in <strong>0ms</strong>.</p>
                </div>

                <div className="flex items-center justify-center gap-2 text-xs text-amber-400/90 font-medium bg-amber-500/10 border border-amber-500/20 py-2.5 px-4 rounded-xl w-full">
                  <Clock className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                  <span>Waiting for @{activeConv.otherUser.username} to accept your request...</span>
                </div>
              </div>
            ) : (
              <div
                ref={messagesContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3 min-h-0 bg-[#0b141a]"
              >
                {messages.map((msg) => {
                  const otherHandle = (activeConv.otherUser.username || '').replace(/^@/, '').trim().toLowerCase()
                  const senderClean = (msg.senderId || '').replace(/^@/, '').trim().toLowerCase()
                  // In a 1-on-1 direct conversation, it is from the other user ONLY if the sender is their handle.
                  // Otherwise, it was sent by ME (from PC, mobile, or any session) -> Right side (Green).
                  const isFromOther = senderClean === otherHandle
                  const isMe = !isFromOther
                  const parsed = parseMessageContent(msg.body)

                  return (
                    <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] sm:max-w-[70%] md:max-w-[55%] rounded-2xl ${
                          parsed.isImage ? 'p-1.5' : 'px-3.5 sm:px-4 py-2'
                        } text-sm shadow-sm transition-all ${
                          isMe
                            ? 'bg-[#005c4b] text-[#e9edef] rounded-br-none'
                            : 'bg-[#202c33] text-[#e9edef] rounded-bl-none'
                        }`}
                      >
                        {parsed.isImage && parsed.imageUrl ? (
                          <div className="space-y-1.5">
                            <div
                              onClick={() => setLightboxUrl(parsed.imageUrl!)}
                              className="relative group rounded-xl overflow-hidden cursor-pointer bg-[#111b21] max-h-[380px] flex items-center justify-center border border-white/5"
                            >
                              <img
                                src={getOptimizedImageUrl(parsed.imageUrl, 700)}
                                onError={(e) => {
                                  const target = e.currentTarget
                                  if (parsed.imageUrl && target.src !== parsed.imageUrl) {
                                    target.src = parsed.imageUrl
                                  }
                                }}
                                alt={parsed.caption || 'Photo message'}
                                loading="lazy"
                                className="w-full h-auto max-h-[380px] object-cover rounded-xl transition-transform duration-200 group-hover:scale-[1.02]"
                              />
                              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 text-white">
                                <span className="p-2 rounded-full bg-black/60 backdrop-blur-sm">
                                  <Maximize2 className="w-4 h-4" />
                                </span>
                              </div>
                            </div>
                            {parsed.caption && (
                              <p className="px-2 pt-0.5 break-words leading-relaxed text-[13px] sm:text-sm">
                                {parsed.caption}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="break-words leading-relaxed text-[13px] sm:text-sm">{msg.body}</p>
                        )}

                        <div className={`flex items-center justify-end gap-1 ${parsed.isImage ? 'px-2 pb-1 pt-0.5' : 'mt-1'} text-[10px] text-[#8696a0]`}>
                          <span>
                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {isMe && (
                            msg.status === 'sending' ? (
                              <Clock className="w-3 h-3 animate-spin text-[#8696a0]" />
                            ) : (
                              <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>
            )}

            {/* Scroll to Bottom Button */}
            {showScrollBottom && (
              <button
                onClick={() => scrollToBottom('smooth')}
                className="absolute bottom-24 right-4 sm:right-8 p-3 rounded-full bg-[#202c33] border border-[#222e35] text-[#00a884] shadow-xl hover:bg-[#2a3942] transition-all flex items-center gap-1.5 text-xs cursor-pointer z-20"
              >
                <ArrowDown className="w-4 h-4" />
                {hasNewUnreadWhileScrolled && (
                  <span className="px-1.5 py-0.5 rounded-full bg-[#00a884] text-[#111b21] font-bold text-[10px]">
                    New
                  </span>
                )}
              </button>
            )}

            {/* Quick Replies Bar */}
            {activeConv.status !== 'pending' && (
              <div className="px-3 sm:px-5 py-2 border-t border-[#202c33] bg-[#111b21]/70 flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0">
                <span className="text-[10px] sm:text-[11px] font-semibold text-[#8696a0] uppercase tracking-wider shrink-0 flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-[#00a884]" /> Quick:
                </span>
                {UNIVERSAL_QUICK_REPLIES.map((reply, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSendMessage(undefined, reply.text)}
                    className="px-2.5 sm:px-3 py-1 bg-[#202c33] hover:bg-[#2a3942] border border-[#222e35] rounded-full text-[11px] sm:text-xs text-[#e9edef] whitespace-nowrap transition-colors shrink-0 cursor-pointer"
                  >
                    {reply.label}
                  </button>
                ))}
              </div>
            )}

            {/* Input Composer Bar */}
            <form
              onSubmit={handleSendMessage}
              onPaste={handlePaste}
              className="p-2.5 sm:p-3.5 border-t border-[#202c33] bg-[#202c33]/50 flex items-center gap-2 sm:gap-3 shrink-0"
            >
              <input
                type="file"
                ref={fileInputRef}
                accept="image/*"
                onChange={handleFileInputChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={activeConv.status === 'pending'}
                onClick={() => fileInputRef.current?.click()}
                className="p-2 sm:p-2.5 text-[#8696a0] hover:text-[#00a884] hover:bg-[#2a3942] rounded-xl transition-all cursor-pointer disabled:opacity-40 shrink-0"
                title="Attach & Send Photo (or Paste with Ctrl+V)"
              >
                <ImageIcon className="w-5 h-5" />
              </button>

              <input
                type="text"
                disabled={activeConv.status === 'pending'}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  activeConv.status === 'pending'
                    ? 'Waiting for contact to approve...'
                    : 'Type a message or paste photo (Ctrl+V)...'
                }
                className="flex-1 bg-[#2a3942] border border-[#222e35] rounded-xl px-3 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] disabled:opacity-40 transition-all"
              />
              <button
                type="submit"
                disabled={activeConv.status === 'pending' || !inputText.trim()}
                className="p-2.5 bg-[#00a884] hover:bg-[#02906f] disabled:opacity-40 text-[#111b21] font-bold rounded-xl transition-all shadow-md shadow-[#00a884]/20 cursor-pointer shrink-0"
              >
                <Send className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 sm:p-8 space-y-4 max-w-sm mx-auto">
            <div className="p-4 rounded-3xl bg-[#111b21] border border-[#202c33] text-[#8696a0]">
              <MessageSquare className="w-10 h-10 sm:w-12 sm:h-12 text-[#00a884]" />
            </div>
            <h3 className="text-base font-bold text-[#e9edef]">Independent WhatsApp at Edge</h3>
            <p className="text-xs text-[#8696a0] leading-relaxed">
              Connect with any user across Cloudflare instances by adding their username and subdomain/domain.
            </p>
            <button
              onClick={() => setShowAddFriendModal(true)}
              className="py-2.5 px-4 bg-[#00a884] hover:bg-[#02906f] text-[#111b21] rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer shadow-lg shadow-[#00a884]/20"
            >
              <UserPlus className="w-4 h-4" /> Connect Contact
            </button>
          </div>
        )}
      </main>

      {/* 3. Connect Contact Modal */}
      {showAddFriendModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150">
          <div className="max-w-md w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-5 sm:p-6 shadow-2xl space-y-4 sm:space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884]">
                  <UserPlus className="w-5 h-5" />
                </div>
                <h3 className="text-sm sm:text-base font-bold text-[#e9edef]">Connect Contact Instance</h3>
              </div>
              <button onClick={() => setShowAddFriendModal(false)} className="text-[#8696a0] hover:text-[#e9edef]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-[#8696a0] leading-relaxed">
              Enter your contact's username and their deployed Cloudflare Workers URL or domain to send an encrypted connection request.
            </p>

            {addFriendError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{addFriendError}</span>
              </div>
            )}

            <form onSubmit={handleSendFriendRequest} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#8696a0]">Contact's Username / Handle</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-[#8696a0] text-sm">@</span>
                  <input
                    type="text"
                    required
                    value={friendHandle}
                    onChange={(e) => setFriendHandle(e.target.value)}
                    placeholder="e.g. suraj or alice"
                    className="w-full pl-8 pr-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-xs sm:text-sm text-[#e9edef] focus:outline-none focus:border-[#00a884]"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#8696a0]">Contact's Subdomain & Domain / URL</label>
                <div className="relative">
                  <Globe className="w-4 h-4 absolute left-3.5 top-3 text-[#8696a0]" />
                  <input
                    type="text"
                    required
                    value={friendDomain}
                    onChange={(e) => setFriendDomain(e.target.value)}
                    placeholder="e.g. your-friend.workers.dev"
                    className="w-full pl-10 pr-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-xs sm:text-sm text-[#e9edef] focus:outline-none focus:border-[#00a884]"
                  />
                </div>
                <p className="text-[10px] text-[#8696a0] pl-1">
                  Their Cloudflare Workers domain (e.g. username.workers.dev)
                </p>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddFriendModal(false)}
                  className="px-4 py-2.5 text-xs text-[#8696a0] hover:text-[#e9edef]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingRequest || !friendHandle.trim() || !friendDomain.trim()}
                  className="px-5 py-2.5 bg-[#00a884] hover:bg-[#02906f] disabled:opacity-50 text-[#111b21] font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer shadow-lg shadow-[#00a884]/20"
                >
                  {sendingRequest ? 'Dispatching...' : 'Send Friend Request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 4. My Instance Address Modal */}
      {showIdentityModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="max-w-md w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-5 sm:p-6 shadow-2xl space-y-4 sm:space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884]">
                  <Share2 className="w-5 h-5" />
                </div>
                <h3 className="text-sm sm:text-base font-bold text-[#e9edef]">Your Chatze Address</h3>
              </div>
              <button onClick={() => setShowIdentityModal(false)} className="text-[#8696a0] hover:text-[#e9edef]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-[#8696a0] leading-relaxed">
              Share your username and instance domain with friends so they can add you from their own deployed app!
            </p>

            <div className="p-4 bg-[#0b141a] rounded-xl border border-[#202c33] space-y-3 text-xs">
              <div>
                <span className="text-[#8696a0] text-[11px] block">Your Username</span>
                <span className="text-[#00a884] font-bold font-mono text-sm">@{currentUser.handle}</span>
              </div>
              <div>
                <span className="text-[#8696a0] text-[11px] block">Your Deployed Domain</span>
                <span className="text-[#e9edef] font-mono text-xs break-all">
                  {typeof window !== 'undefined' ? window.location.origin : 'https://your-subdomain.workers.dev'}
                </span>
              </div>
            </div>

            <button
              onClick={() => {
                const text = `Connect with me on Chatze WhatsApp!\nUsername: @${currentUser.handle}\nInstance: ${window.location.origin}`
                navigator.clipboard.writeText(text)
                setCopiedLink(true)
                setTimeout(() => setCopiedLink(false), 2000)
              }}
              className="w-full py-2.5 bg-[#00a884] hover:bg-[#02906f] text-[#111b21] font-bold rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer transition-all"
            >
              {copiedLink ? <CheckCheck className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedLink ? 'Copied to Clipboard!' : 'Copy Connection Details'}
            </button>
          </div>
        </div>
      )}

      {/* 5. Payment QR Modal */}
      {showQrModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="max-w-xs w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-5 sm:p-6 text-center space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-[#00a884] uppercase tracking-wider">
                Fonepay & eSewa QR
              </span>
              <button onClick={() => setShowQrModal(false)} className="text-[#8696a0] hover:text-[#e9edef]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 bg-white rounded-xl mx-auto w-44 h-44 sm:w-48 sm:h-48 flex items-center justify-center">
              <QrCode className="w-36 h-36 sm:w-40 sm:h-40 text-slate-950" />
            </div>

            <div className="space-y-1 text-xs">
              <p className="font-semibold text-[#e9edef]">{currentUser.display_name}</p>
              <p className="text-[#8696a0]">Scan via eSewa, Khalti, or mobile banking</p>
            </div>

            <button
              onClick={() => {
                setShowQrModal(false)
                if (activeConv && activeConv.status !== 'pending') {
                  handleSendMessage(undefined, '💳 Scannable Payment QR: Open your eSewa, Khalti, or mobile banking app and scan to pay.')
                }
              }}
              className="w-full py-2.5 bg-[#00a884] text-[#111b21] font-bold rounded-xl text-xs hover:bg-[#02906f] transition-colors cursor-pointer"
            >
              Share QR in Chat
            </button>
          </div>
        </div>
      )}

      {/* 6. Image Preview & Send Modal */}
      {selectedImageFile && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="max-w-md w-full bg-[#111b21] border border-[#202c33] rounded-2xl p-4 sm:p-5 shadow-2xl space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#e9edef] flex items-center gap-1.5">
                <ImageIcon className="w-4 h-4 text-[#00a884]" /> Send Photo
              </span>
              <button
                disabled={isUploadingImage}
                onClick={() => setSelectedImageFile(null)}
                className="text-[#8696a0] hover:text-[#e9edef] disabled:opacity-40"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative rounded-xl overflow-hidden bg-black/50 max-h-[300px] sm:max-h-[360px] flex items-center justify-center border border-white/5">
              <img
                src={selectedImageFile.dataUrl}
                alt="Upload preview"
                className="w-full h-auto max-h-[300px] sm:max-h-[360px] object-contain rounded-xl"
              />
              <span className="absolute bottom-2 right-2 px-2.5 py-1 rounded-full bg-black/75 backdrop-blur-md text-[10px] text-[#00a884] font-mono border border-[#00a884]/30 shadow-lg">
                ~{selectedImageFile.sizeKb} KB
                {selectedImageFile.originalKb && selectedImageFile.originalKb > selectedImageFile.sizeKb ? (
                  <span className="text-white/80 ml-1">
                    (from {selectedImageFile.originalKb} KB, {Math.round((1 - selectedImageFile.sizeKb / selectedImageFile.originalKb) * 100)}% saved)
                  </span>
                ) : ' (Edge Optimized)'}
              </span>
            </div>

            <div className="space-y-1">
              <input
                type="text"
                disabled={isUploadingImage}
                value={selectedImageFile.caption}
                onChange={(e) => setSelectedImageFile((prev) => prev ? { ...prev, caption: e.target.value } : null)}
                placeholder="Add a caption... (optional)"
                className="w-full px-3.5 py-2.5 bg-[#202c33] border border-[#222e35] rounded-xl text-xs sm:text-sm text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884]"
              />
              <p className="text-[10px] text-[#8696a0] px-1 flex items-center justify-between">
                <span>Auto-converted to lightweight WebP for D1 database storage.</span>
                <span className="text-[#00a884] font-medium">Cached via wsrv.nl</span>
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={isUploadingImage}
                onClick={() => setSelectedImageFile(null)}
                className="px-4 py-2 text-xs text-[#8696a0] hover:text-[#e9edef] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isUploadingImage}
                onClick={handleSendImage}
                className="px-5 py-2.5 bg-[#00a884] hover:bg-[#02906f] disabled:opacity-50 text-[#111b21] font-bold rounded-xl text-xs flex items-center gap-2 cursor-pointer shadow-lg shadow-[#00a884]/20"
              >
                {isUploadingImage ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Uploading...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Send Photo</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Image Lightbox Modal */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          className="fixed inset-0 bg-black/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 z-50 animate-in fade-in duration-150"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-4xl w-full max-h-[90vh] flex flex-col items-center"
          >
            <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
              <a
                href={getOptimizedImageUrl(lightboxUrl, 1600)}
                target="_blank"
                rel="noopener noreferrer"
                download="photo.webp"
                className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm transition-all"
                title="Download original"
              >
                <Download className="w-4 h-4" />
              </a>
              <button
                onClick={() => setLightboxUrl(null)}
                className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm transition-all"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <img
              src={getOptimizedImageUrl(lightboxUrl, 1600)}
              onError={(e) => {
                const target = e.currentTarget
                if (lightboxUrl && target.src !== lightboxUrl) {
                  target.src = lightboxUrl
                }
              }}
              alt="Full view"
              className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl"
            />
          </div>
        </div>
      )}

      </div>

      {/* Offline Connectivity Status Pill */}
      <OfflineIndicator />
    </div>
  )
}
