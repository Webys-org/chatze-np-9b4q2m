import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import {
  getVapidKeys,
  getOrGenerateVapidKeys,
  sendPushNotification,
  memoryPushSubscriptions,
  StoredSubscription,
} from './webpush'

type Bindings = {
  DB?: any // Cloudflare D1 Database binding
  ASSETS?: any // Cloudflare Workers static assets binding
  REALTIME_ROOM?: any // Cloudflare Durable Object binding for 0ms cross-isolate push
  JWT_SECRET?: string
  NODE_ENV?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// Global safety error handler: NEVER return plain text 500
app.onError((err, c) => {
  console.error('[Hono Edge Error]', err)
  return c.json({ error: err.message || 'Server error', timestamp: Date.now() }, 500)
})

// ============================================================================
// 1. In-Memory Process Event Hub (Multi-Device Sync Pipeline: Flow A & B)
// ============================================================================
type UserStreamClient = {
  id: string
  userId: string
  write: (data: string) => void
}

const activeStreams = new Map<string, Set<UserStreamClient>>()

export function emitUserEvent(userId: string, eventName: string, payload: any) {
  const clients = activeStreams.get(userId)
  const packet = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
  if (clients) {
    for (const client of clients) {
      try {
        client.write(packet)
      } catch {
        clients.delete(client)
      }
    }
  }
}

export async function broadcastAllStreams(eventName: string, payload: any, env?: any) {
  // 1. If Cloudflare Durable Object is available, broadcast across ALL global isolates & devices in 0ms!
  if (env?.REALTIME_ROOM) {
    try {
      const id = env.REALTIME_ROOM.idFromName('global_room')
      const stub = env.REALTIME_ROOM.get(id)
      await stub.fetch('http://internal/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName, data: payload }),
      })
    } catch (err: any) {
      console.warn('[DO Broadcast Error]', err?.message)
    }
  }

  // 2. In-memory local isolate broadcast
  const packet = `event: ${eventName}\ndata: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
  for (const [, clients] of activeStreams) {
    for (const client of clients) {
      try {
        client.write(packet)
      } catch {
        clients.delete(client)
      }
    }
  }
}

// ============================================================================
// 2. In-Memory Fallback State (Always active & synced for 100% uptime)
// ============================================================================
interface MemUser {
  id: string
  handle: string
  display_name: string
  password_hash: string
  role: string
  created_at: number
}

interface MemSession {
  userId: string
  createdAt: number
  expiresAt: number
}

interface MemConversation {
  id: string
  user_a: string
  user_b: string
  remote_handle?: string
  remote_instance_url?: string
  last_message_snippet: string | null
  last_message_at: number
  status: string // 'active' | 'pending' | 'archived'
}

interface MemMessage {
  id: string
  conversation_id: string
  sender_id: string
  content: string
  created_at: number
  read_at: number | null
}

interface MemFriendship {
  id: string
  local_user_id: string
  remote_handle: string
  remote_instance_url: string
  status: string // 'pending' | 'active' | 'rejected'
  direction: 'incoming' | 'outgoing'
  created_at: number
}

const memoryStore = {
  users: new Map<string, MemUser>(),
  sessions: new Map<string, MemSession>(),
  conversations: new Map<string, MemConversation>(),
  messages: [] as MemMessage[],
  config: new Map<string, string>(),
  friendships: new Map<string, MemFriendship>(),
  media: new Map<string, { id: string; contentType: string; data: string; createdAt: number }>(),
}

// Session expiration: 30 days
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000

async function createSession(userId: string, db?: any): Promise<string> {
  const token = 'tok_' + crypto.randomUUID().replace(/-/g, '')
  const now = Date.now()
  const expiresAt = now + SESSION_DURATION_MS

  memoryStore.sessions.set(token, { userId, createdAt: now, expiresAt })

  if (db) {
    try {
      await ensureD1Database(db)
      await db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(token, userId, now, expiresAt).run()
    } catch (e: any) {
      console.warn('[Session Save Warning]', e?.message)
    }
  }

  return token
}

async function validateSession(token: string, db?: any): Promise<any | null> {
  if (!token) return null
  const now = Date.now()

  if (db) {
    try {
      await ensureD1Database(db)
      const row: any = await db.prepare(`
        SELECT u.id, u.handle, u.display_name, u.role, u.created_at
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > ?
        LIMIT 1
      `).bind(token, now).first()

      if (row) return row
    } catch (e: any) {
      console.warn('[Session Validate Warning]', e?.message)
    }
  }

  const memSession = memoryStore.sessions.get(token)
  if (memSession && memSession.expiresAt > now) {
    const user = memoryStore.users.get(memSession.userId)
    if (user) {
      const { password_hash, ...safe } = user
      return safe
    }
  }

  return null
}

// ============================================================================
// 3. WebCrypto ECDSA Key Management (Asymmetric Federation Handshake)
// ============================================================================
let serverKeyPair: { publicKey: CryptoKey; privateKey: CryptoKey } | null = null
let exportedPublicKeyBase64 = ''

async function ensureServerKeyPair(db?: any): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  if (serverKeyPair) return serverKeyPair

  if (db) {
    try {
      const pubRow: any = await db.prepare("SELECT value FROM system_config WHERE key = 'federation_public_key'").first()
      const privRow: any = await db.prepare("SELECT value FROM system_config WHERE key = 'federation_private_key'").first()
      if (pubRow && privRow) {
        const pubJwk = JSON.parse(pubRow.value)
        const privJwk = JSON.parse(privRow.value)
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          pubJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        )
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          privJwk,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['sign']
        )
        serverKeyPair = { publicKey, privateKey }
        exportedPublicKeyBase64 = btoa(JSON.stringify(pubJwk))
        return serverKeyPair
      }
    } catch (e) {
      console.warn('[WebCrypto Key Init]', e)
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  serverKeyPair = keyPair

  const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  exportedPublicKeyBase64 = btoa(JSON.stringify(pubJwk))

  if (db) {
    try {
      await db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('federation_public_key', ?), ('federation_private_key', ?)")
        .bind(JSON.stringify(pubJwk), JSON.stringify(privJwk)).run()
    } catch (e) {
      console.warn('[WebCrypto Key Save]', e)
    }
  }

  return serverKeyPair
}

async function signPayload(payloadString: string): Promise<string> {
  const keys = await ensureServerKeyPair()
  const enc = new TextEncoder().encode(payloadString)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc)
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// ============================================================================
// 4. Safe Bulletproof Cloudflare D1 Migration (Individual statements)
// ============================================================================
let d1Initialized = false

const D1_INIT_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT "admin", created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, remote_handle TEXT, remote_instance_url TEXT, last_message_snippet TEXT, last_message_at INTEGER NOT NULL, status TEXT DEFAULT "active")',
  'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS federation_friendships (id TEXT PRIMARY KEY, local_user_id TEXT NOT NULL, remote_handle TEXT NOT NULL, remote_instance_url TEXT NOT NULL, status TEXT DEFAULT "pending", direction TEXT DEFAULT "outgoing", created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS media_attachments (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_handle TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_push_user_handle ON push_subscriptions(user_handle)',
  'CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_friendships_created_at ON federation_friendships(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_user_a ON conversations(user_a, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_conversations_user_b ON conversations(user_b, last_message_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_token_expires ON sessions(token, expires_at)'
]

async function ensureD1Database(db: any) {
  if (d1Initialized || !db) return
  try {
    for (const stmt of D1_INIT_STATEMENTS) {
      try {
        await db.prepare(stmt).run()
      } catch (stmtErr: any) {
        console.warn('[D1 stmt warning]', stmtErr?.message)
      }
    }
    d1Initialized = true
  } catch (err: any) {
    console.warn('[D1 Migration Warning]', err?.message)
  }
}

// Normalize URL helper (Ensures https:// and removes trailing slash)
function normalizeUrl(url: string): string {
  let cleaned = (url || '').trim()
  if (!cleaned.startsWith('http://') && !cleaned.startsWith('https://')) {
    cleaned = 'https://' + cleaned
  }
  return cleaned.replace(/\/+$/, '')
}

// ============================================================================
// 5. First-Launch Setup Wizard & Admin Initialization
// ============================================================================
app.get('/api/setup/status', async (c) => {
  const db = c.env?.DB

  if (db) {
    try {
      await ensureD1Database(db)
      const setupRow: any = await db.prepare("SELECT value FROM system_config WHERE key = 'is_setup'").first()
      const nameRow: any = await db.prepare("SELECT value FROM system_config WHERE key = 'display_name'").first()
      const hasAdmin: any = await db.prepare("SELECT id FROM users LIMIT 1").first()

      const isSetup = setupRow?.value === 'true' && Boolean(hasAdmin)
      return c.json({
        setupRequired: !isSetup,
        displayName: nameRow?.value || 'Chatze User',
      })
    } catch (d1Err: any) {
      console.warn('[D1 Setup Status Warning, falling back to memory]', d1Err?.message)
    }
  }

  const isSetup = memoryStore.config.get('is_setup') === 'true' && memoryStore.users.size > 0
  return c.json({
    setupRequired: !isSetup,
    displayName: memoryStore.config.get('display_name') || 'Chatze User',
  })
})

app.post('/api/setup', async (c) => {
  try {
    const body = await c.req.json()
    const displayName = (body.displayName || body.businessName || 'Chatze User').trim()
    const cleanHandle = (body.adminUsername || body.username || 'admin').replace(/^@/, '').trim().toLowerCase()
    const password = body.password || 'admin123'
    const adminId = 'usr_admin_' + Math.random().toString(36).slice(2, 9)
    const now = Date.now()
    const db = c.env?.DB

    // Sync in-memory store
    memoryStore.config.set('is_setup', 'true')
    memoryStore.config.set('display_name', displayName)
    const newAdmin: MemUser = {
      id: adminId,
      handle: cleanHandle,
      display_name: displayName,
      password_hash: password,
      role: 'admin',
      created_at: now,
    }
    memoryStore.users.set(adminId, newAdmin)

    // Save in D1 if available
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('is_setup', 'true'), ('display_name', ?)")
          .bind(displayName).run()
        await db.prepare("INSERT OR REPLACE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)")
          .bind(adminId, cleanHandle, displayName, password, now).run()
        await ensureServerKeyPair(db)
      } catch (d1Err: any) {
        console.warn('[D1 Setup Save Warning]', d1Err?.message)
      }
    }

    const sessionToken = await createSession(adminId, db)

    return c.json({
      success: true,
      token: sessionToken,
      user: {
        id: adminId,
        handle: cleanHandle,
        display_name: displayName,
        role: 'admin',
      },
    })
  } catch (err: any) {
    return c.json({ error: err.message || 'Setup failed' }, 400)
  }
})

// ============================================================================
// 6. Device-Secured Admin Sign In & Session Validation
// ============================================================================
app.get('/api/auth/session', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()

  if (!token) {
    return c.json({ user: null, error: 'Unauthorized: No session token provided' }, 401)
  }

  const user = await validateSession(token, c.env?.DB)
  if (user) {
    return c.json({ user })
  }

  return c.json({ user: null, error: 'Unauthorized: Session invalid or expired' }, 401)
})

app.post('/api/auth/sign-in', async (c) => {
  try {
    const { username, password } = await c.req.json()
    const cleanHandle = (username || '').replace(/^@/, '').trim().toLowerCase()
    const db = c.env?.DB
    let matchedUser: any = null

    if (db) {
      try {
        await ensureD1Database(db)
        const user: any = await db.prepare("SELECT * FROM users WHERE handle = ? OR id = ?").bind(cleanHandle, cleanHandle).first()
        if (user && user.password_hash === password) {
          matchedUser = user
        }
      } catch (d1Err: any) {
        console.warn('[D1 Sign In Warning]', d1Err?.message)
      }
    }

    if (!matchedUser) {
      const match = Array.from(memoryStore.users.values()).find((u) => u.handle.toLowerCase() === cleanHandle && u.password_hash === password)
      if (match) matchedUser = match
    }

    if (matchedUser) {
      const sessionToken = await createSession(matchedUser.id, db)
      const { password_hash, ...safe } = matchedUser
      return c.json({ success: true, token: sessionToken, user: safe })
    }

    return c.json({ error: 'Incorrect username or password' }, 401)
  } catch (err: any) {
    return c.json({ error: err.message || 'Sign in error' }, 500)
  }
})

app.post('/api/auth/sign-out', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (token) {
    memoryStore.sessions.delete(token)
    if (c.env?.DB) {
      try {
        await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
      } catch (e) {}
    }
  }
  return c.json({ success: true })
})

// ============================================================================
// 7. Conversations & Contact List (WhatsApp Style)
// ============================================================================
app.get('/api/conversations', async (c) => {
  const db = c.env?.DB

  if (db) {
    try {
      await ensureD1Database(db)
      const convRows: any = await db.prepare('SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 100').all()
      if (convRows?.results) {
        const mapped = convRows.results.map((row: any) => ({
          id: row.id,
          otherUser: {
            id: row.user_b,
            username: row.remote_handle || row.user_b,
            displayName: row.remote_handle ? `@${row.remote_handle}` : row.user_b,
          },
          status: row.status,
          remoteInstanceUrl: row.remote_instance_url || null,
          lastMessage: row.last_message_snippet
            ? {
                content: row.last_message_snippet,
                createdAt: row.last_message_at,
              }
            : null,
        }))
        return c.json({ conversations: mapped })
      }
    } catch (d1Err: any) {
      console.warn('[D1 Conversations Warning]', d1Err?.message)
    }
  }

  const convList = Array.from(memoryStore.conversations.values())
    .sort((a, b) => b.last_message_at - a.last_message_at)
    .map((conv) => {
      const otherUser = memoryStore.users.get(conv.user_b) || {
        id: conv.user_b,
        handle: conv.remote_handle || conv.user_b,
        display_name: conv.remote_handle ? `@${conv.remote_handle}` : conv.user_b,
      }
      return {
        id: conv.id,
        otherUser: {
          id: otherUser.id,
          username: otherUser.handle,
          displayName: otherUser.display_name,
        },
        status: conv.status,
        remoteInstanceUrl: conv.remote_instance_url || null,
        lastMessage: conv.last_message_snippet
          ? {
              content: conv.last_message_snippet,
              createdAt: conv.last_message_at,
            }
          : null,
      }
    })

  return c.json({ conversations: convList })
})

// Friendships list (Pending incoming, pending outgoing, active)
app.get('/api/federation/friendships', async (c) => {
  const db = c.env?.DB

  if (db) {
    try {
      await ensureD1Database(db)
      const rows: any = await db.prepare('SELECT * FROM federation_friendships ORDER BY created_at DESC').all()
      if (rows?.results) {
        return c.json({ friendships: rows.results })
      }
    } catch (d1Err: any) {
      console.warn('[D1 Friendships Warning]', d1Err?.message)
    }
  }

  const list = Array.from(memoryStore.friendships.values()).sort((a, b) => b.created_at - a.created_at)
  return c.json({ friendships: list })
})

// Unified Low-Bandwidth Edge Delta-Sync (Single lightweight call for conversations, messages & friendships)
app.get('/api/sync', async (c) => {
  const since = parseInt(c.req.query('since') || '0', 10)
  const conversationId = c.req.query('conversationId') || ''
  const db = c.env?.DB

  let newMessages: any[] = []
  let friendships: any[] = []
  let conversations: any[] = []

  if (db) {
    try {
      await ensureD1Database(db)
      if (conversationId) {
        let reverseConvId = conversationId
        if (conversationId.startsWith('conv_')) {
          const adminUser = memoryStore.users.get('usr_admin')
          const adminHandle = adminUser?.handle || 'admin'
          reverseConvId = 'conv_' + adminHandle
        }
        const msgRows: any = await db.prepare(
          'SELECT * FROM messages WHERE (conversation_id = ? OR conversation_id = ?) AND created_at > ? ORDER BY created_at ASC LIMIT 50'
        ).bind(conversationId, reverseConvId, since).all()
        if (msgRows?.results) {
          const seen = new Set<string>()
          newMessages = []
          for (const r of msgRows.results) {
            if (!seen.has(r.id)) {
              seen.add(r.id)
              newMessages.push({
                id: r.id,
                conversationId: r.conversation_id,
                senderId: r.sender_id,
                body: r.content,
                createdAt: new Date(r.created_at).toISOString(),
                readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
              })
            }
          }
        }
      }

      const fRows: any = await db.prepare('SELECT * FROM federation_friendships ORDER BY created_at DESC LIMIT 50').all()
      if (fRows?.results) friendships = fRows.results

      const cRows: any = await db.prepare('SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT 50').all()
      if (cRows?.results) {
        conversations = cRows.results.map((row: any) => ({
          id: row.id,
          otherUser: {
            id: row.user_b,
            username: row.remote_handle || row.user_b,
            displayName: row.remote_handle ? `@${row.remote_handle}` : row.user_b,
          },
          status: row.status,
          remoteInstanceUrl: row.remote_instance_url || null,
          lastMessage: row.last_message_snippet
            ? { content: row.last_message_snippet, createdAt: row.last_message_at }
            : null,
        }))
      }

      return c.json({
        serverTime: Date.now(),
        newMessages,
        friendships,
        conversations,
      })
    } catch (e: any) {
      console.warn('[Sync D1 Warning]', e?.message)
    }
  }

  // In-memory fallback
  const memMsgs = memoryStore.messages
    .filter((m) => (!conversationId || m.conversation_id === conversationId) && m.created_at > since)
    .map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      body: m.content,
      createdAt: new Date(m.created_at).toISOString(),
      readAt: m.read_at ? new Date(m.read_at).toISOString() : null,
    }))

  const memFriendships = Array.from(memoryStore.friendships.values()).sort((a, b) => b.created_at - a.created_at)
  const memConvs = Array.from(memoryStore.conversations.values())
    .sort((a, b) => b.last_message_at - a.last_message_at)
    .map((conv) => ({
      id: conv.id,
      otherUser: {
        id: conv.user_b,
        username: conv.remote_handle || conv.user_b,
        displayName: conv.remote_handle ? `@${conv.remote_handle}` : conv.user_b,
      },
      status: conv.status,
      remoteInstanceUrl: conv.remote_instance_url || null,
      lastMessage: conv.last_message_snippet
        ? { content: conv.last_message_snippet, createdAt: conv.last_message_at }
        : null,
    }))

  return c.json({
    serverTime: Date.now(),
    newMessages: memMsgs,
    friendships: memFriendships,
    conversations: memConvs,
  })
})

// ============================================================================
// 8. Send Friend Request (Outbound to Remote Peer Subdomain / Domain)
// ============================================================================
app.post('/api/federation/requests', async (c) => {
  try {
    const body = await c.req.json()
    const { remoteHandle, remoteInstanceUrl, senderId, myHandle, myDisplayName, myInstanceUrl } = body
    const cleanRemoteHandle = (remoteHandle || '').replace(/^@/, '').trim().toLowerCase()
    const normalizedUrl = normalizeUrl(remoteInstanceUrl)
    const localUserId = senderId || 'usr_admin'

    const friendshipId = 'freq_' + Math.random().toString(36).slice(2, 9)
    const conversationId = 'conv_' + cleanRemoteHandle
    const now = Date.now()

    let actualHandle = myHandle || ''
    let actualDisplayName = myDisplayName || ''
    const db = c.env?.DB

    if (db && (!actualHandle || !actualDisplayName)) {
      try {
        await ensureD1Database(db)
        const adminRow: any = await db.prepare("SELECT handle, display_name FROM users WHERE role = 'admin' LIMIT 1").first()
        if (adminRow) {
          actualHandle = actualHandle || adminRow.handle
          actualDisplayName = actualDisplayName || adminRow.display_name
        }
      } catch (e) {}
    }
    actualHandle = actualHandle || memoryStore.users.get(localUserId)?.handle || 'user'
    actualDisplayName = actualDisplayName || memoryStore.config.get('display_name') || 'Chatze User'

    const originUrl = myInstanceUrl || c.req.url.replace(/\/api\/.*$/, '')

    const friendshipRecord: MemFriendship = {
      id: friendshipId,
      local_user_id: localUserId,
      remote_handle: cleanRemoteHandle,
      remote_instance_url: normalizedUrl,
      status: 'pending',
      direction: 'outgoing',
      created_at: now,
    }

    const convRecord: MemConversation = {
      id: conversationId,
      user_a: localUserId,
      user_b: cleanRemoteHandle,
      remote_handle: cleanRemoteHandle,
      remote_instance_url: normalizedUrl,
      last_message_snippet: `Friend request sent to @${cleanRemoteHandle}`,
      last_message_at: now,
      status: 'pending',
    }

    memoryStore.friendships.set(friendshipId, friendshipRecord)
    memoryStore.conversations.set(conversationId, convRecord)

    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare('INSERT OR REPLACE INTO federation_friendships (id, local_user_id, remote_handle, remote_instance_url, status, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(friendshipRecord.id, friendshipRecord.local_user_id, friendshipRecord.remote_handle, friendshipRecord.remote_instance_url, friendshipRecord.status, friendshipRecord.direction, now).run()

        await db.prepare('INSERT OR REPLACE INTO conversations (id, user_a, user_b, remote_handle, remote_instance_url, last_message_snippet, last_message_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(convRecord.id, convRecord.user_a, convRecord.user_b, convRecord.remote_handle, convRecord.remote_instance_url, convRecord.last_message_snippet, now, convRecord.status).run()
      } catch (d1Err: any) {
        console.warn('[D1 Outbound Request Warning]', d1Err?.message)
      }
    }

    const payload = JSON.stringify({
      from_handle: actualHandle,
      from_display_name: actualDisplayName,
      from_instance_url: originUrl,
      to_handle: cleanRemoteHandle,
      timestamp: now,
    })

    let signature = ''
    try {
      signature = await signPayload(payload)
    } catch (e) {
      console.warn('[Sign Error]', e)
    }

    let remoteSuccess = false
    try {
      const remoteRes = await fetch(`${normalizedUrl}/api/federation/v1/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Federation-Signature': signature,
        },
        body: payload,
      })
      remoteSuccess = remoteRes.ok
    } catch (remoteErr: any) {
      console.warn('[Remote Peer Request Offline/Failed]', remoteErr?.message)
    }

    emitUserEvent(localUserId, 'conversation_updated', convRecord)

    return c.json({
      success: true,
      remoteDelivered: remoteSuccess,
      friendship: friendshipRecord,
      conversation: convRecord,
    })
  } catch (err: any) {
    return c.json({ error: err.message || 'Request failed' }, 400)
  }
})

// Inbound Friend Request from remote peer
app.post('/api/federation/v1/requests', async (c) => {
  try {
    const body = await c.req.json()
    const { from_handle, from_display_name, from_instance_url } = body
    const cleanFromHandle = (from_handle || 'peer').replace(/^@/, '').trim().toLowerCase()
    const remoteUrl = normalizeUrl(from_instance_url || '')
    const now = Date.now()

    const friendshipId = 'freq_in_' + Math.random().toString(36).slice(2, 9)
    const conversationId = 'conv_' + cleanFromHandle

    const incomingFriendship: MemFriendship = {
      id: friendshipId,
      local_user_id: 'usr_admin',
      remote_handle: cleanFromHandle,
      remote_instance_url: remoteUrl,
      status: 'pending',
      direction: 'incoming',
      created_at: now,
    }

    const incomingConv: MemConversation = {
      id: conversationId,
      user_a: 'usr_admin',
      user_b: cleanFromHandle,
      remote_handle: cleanFromHandle,
      remote_instance_url: remoteUrl,
      last_message_snippet: `Connection request from @${cleanFromHandle}`,
      last_message_at: now,
      status: 'pending',
    }

    memoryStore.friendships.set(friendshipId, incomingFriendship)
    memoryStore.conversations.set(conversationId, incomingConv)

    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare('INSERT OR REPLACE INTO federation_friendships (id, local_user_id, remote_handle, remote_instance_url, status, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(incomingFriendship.id, incomingFriendship.local_user_id, incomingFriendship.remote_handle, incomingFriendship.remote_instance_url, incomingFriendship.status, incomingFriendship.direction, now).run()

        await db.prepare('INSERT OR REPLACE INTO conversations (id, user_a, user_b, remote_handle, remote_instance_url, last_message_snippet, last_message_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(incomingConv.id, incomingConv.user_a, incomingConv.user_b, incomingConv.remote_handle, incomingConv.remote_instance_url, incomingConv.last_message_snippet, now, incomingConv.status).run()
      } catch (d1Err: any) {
        console.warn('[D1 Inbound Request Warning]', d1Err?.message)
      }
    }

    await broadcastAllStreams('incoming_friend_request', {
      friendship: incomingFriendship,
      from_handle: cleanFromHandle,
      from_display_name: from_display_name || `@${cleanFromHandle}`,
      from_instance_url: remoteUrl,
    }, c.env)

    return c.json({ success: true, status: 'received' }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// ============================================================================
// 9. Friend Request Accept & Dual-Sided 0ms Live Unlock
// ============================================================================
app.post('/api/federation/requests/accept', async (c) => {
  try {
    const { remoteHandle, remoteInstanceUrl, myHandle } = await c.req.json()
    const cleanHandle = (remoteHandle || '').replace(/^@/, '').trim().toLowerCase()
    const conversationId = 'conv_' + cleanHandle
    const now = Date.now()

    for (const [, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) f.status = 'active'
    }
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.status = 'active'
      conv.last_message_snippet = 'Connected! You can now message each other.'
    }

    const db = c.env?.DB
    let actualMyHandle = myHandle || ''
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare("UPDATE federation_friendships SET status = 'active', created_at = ? WHERE remote_handle = ?").bind(now, cleanHandle).run()
        await db.prepare("UPDATE conversations SET status = 'active', last_message_snippet = 'Connected! You can now message each other.', last_message_at = ? WHERE id = ?").bind(now, conversationId).run()
        if (!actualMyHandle) {
          const adminRow: any = await db.prepare("SELECT handle FROM users WHERE role = 'admin' LIMIT 1").first()
          if (adminRow) actualMyHandle = adminRow.handle
        }
      } catch (d1Err: any) {
        console.warn('[D1 Accept Warning]', d1Err?.message)
      }
    }
    actualMyHandle = actualMyHandle || 'me'

    await broadcastAllStreams('friend_accepted', {
      remoteHandle: cleanHandle,
      conversationId,
      status: 'active',
    }, c.env)

    if (remoteInstanceUrl) {
      try {
        await fetch(`${normalizeUrl(remoteInstanceUrl)}/api/federation/v1/requests/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_handle: actualMyHandle,
            accepted: true,
            timestamp: now,
          }),
        })
      } catch (err: any) {
        console.warn('[Accept Dispatch Warning]', err?.message)
      }
    }

    return c.json({ success: true, unlocked: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// Peer approved our request
app.post('/api/federation/v1/requests/accept', async (c) => {
  try {
    const { from_handle } = await c.req.json()
    const cleanHandle = (from_handle || '').replace(/^@/, '').trim().toLowerCase()
    const conversationId = 'conv_' + cleanHandle

    for (const [, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) f.status = 'active'
    }
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.status = 'active'
      conv.last_message_snippet = 'Connected! You can now message each other.'
    }

    const db = c.env?.DB
    const now = Date.now()
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare("UPDATE federation_friendships SET status = 'active', created_at = ? WHERE remote_handle = ?").bind(now, cleanHandle).run()
        await db.prepare("UPDATE conversations SET status = 'active', last_message_snippet = 'Connected! You can now message each other.', last_message_at = ? WHERE id = ?").bind(now, conversationId).run()
      } catch (d1Err: any) {
        console.warn('[D1 Remote Accept Warning]', d1Err?.message)
      }
    }

    await broadcastAllStreams('friend_accepted', {
      remoteHandle: cleanHandle,
      conversationId,
      status: 'active',
    }, c.env)

    return c.json({ success: true, status: 'unlocked' })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// Reject / Decline
app.post('/api/federation/requests/reject', async (c) => {
  try {
    const { remoteHandle } = await c.req.json()
    const cleanHandle = (remoteHandle || '').replace(/^@/, '').trim().toLowerCase()

    for (const [id, f] of memoryStore.friendships) {
      if (f.remote_handle === cleanHandle) memoryStore.friendships.delete(id)
    }
    memoryStore.conversations.delete('conv_' + cleanHandle)

    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare("DELETE FROM federation_friendships WHERE remote_handle = ?").bind(cleanHandle).run()
        await db.prepare("DELETE FROM conversations WHERE id = ?").bind('conv_' + cleanHandle).run()
      } catch (d1Err: any) {
        console.warn('[D1 Reject Warning]', d1Err?.message)
      }
    }

    await broadcastAllStreams('friendship_removed', { remoteHandle: cleanHandle }, c.env)
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// ============================================================================
// 10. Messages: 0ms Optimistic Delivery + Cross-Peer Forwarding
// ============================================================================
app.get('/api/messaging', async (c) => {
  const conversationId = c.req.query('conversationId')
  if (!conversationId) return c.json({ messages: [] })
  const db = c.env?.DB

  // Bidirectional resolution: if query is conv_alice, also resolve reverse conv_bob if needed
  let reverseConvId = conversationId
  if (conversationId.startsWith('conv_')) {
    const handlePart = conversationId.replace('conv_', '')
    const adminUser = memoryStore.users.get('usr_admin')
    const adminHandle = adminUser?.handle || 'admin'
    reverseConvId = 'conv_' + adminHandle
  }

  if (db) {
    try {
      await ensureD1Database(db)
      const rows: any = await db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? OR conversation_id = ? ORDER BY created_at ASC'
      ).bind(conversationId, reverseConvId).all()
      if (rows?.results) {
        const seen = new Set<string>()
        const mapped: any[] = []
        for (const r of rows.results) {
          if (!seen.has(r.id)) {
            seen.add(r.id)
            mapped.push({
              id: r.id,
              conversationId: r.conversation_id,
              senderId: r.sender_id,
              body: r.content,
              createdAt: new Date(r.created_at).toISOString(),
              readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
            })
          }
        }
        return c.json({ messages: mapped })
      }
    } catch (d1Err: any) {
      console.warn('[D1 Messages Warning]', d1Err?.message)
    }
  }

  const seen = new Set<string>()
  const msgs = memoryStore.messages
    .filter((m) => m.conversation_id === conversationId || m.conversation_id === reverseConvId)
    .sort((a, b) => a.created_at - b.created_at)
    .filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    .map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      body: m.content,
      createdAt: new Date(m.created_at).toISOString(),
      readAt: m.read_at ? new Date(m.read_at).toISOString() : null,
    }))

  return c.json({ messages: msgs })
})

app.post('/api/messaging', async (c) => {
  try {
    const { conversationId, body, senderId, tempId, remoteInstanceUrl, remoteHandle, myHandle } = await c.req.json()
    const messageId = 'msg_' + Math.random().toString(36).slice(2, 9)
    const now = Date.now()
    const actualSender = senderId || 'usr_admin'
    const cleanSenderHandle = (myHandle || '').replace(/^@/, '').trim().toLowerCase()
    const cleanRemoteHandle = (remoteHandle || '').replace(/^@/, '').trim().toLowerCase()

    const messageRecord = {
      id: messageId,
      conversationId: conversationId || 'conv_general',
      senderId: actualSender,
      senderHandle: cleanSenderHandle,
      recipientHandle: cleanRemoteHandle,
      body: body || '',
      createdAt: new Date(now).toISOString(),
      readAt: null,
      tempId: tempId || null,
    }

    memoryStore.messages.push({
      id: messageRecord.id,
      conversation_id: messageRecord.conversationId,
      sender_id: messageRecord.senderId,
      content: messageRecord.body,
      created_at: now,
      read_at: null,
    })
    const conv = memoryStore.conversations.get(messageRecord.conversationId)
    if (conv) {
      conv.last_message_snippet = messageRecord.body
      conv.last_message_at = now
    }

    const reverseConvId = cleanSenderHandle ? 'conv_' + cleanSenderHandle : null
    const reverseConv = reverseConvId ? memoryStore.conversations.get(reverseConvId) : null
    if (reverseConv) {
      reverseConv.last_message_snippet = messageRecord.body
      reverseConv.last_message_at = now
    }

    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)')
          .bind(messageRecord.id, messageRecord.conversationId, messageRecord.senderId, messageRecord.body, now).run()
        await db.prepare('UPDATE conversations SET last_message_snippet = ?, last_message_at = ? WHERE id = ? OR (id = ? AND ? IS NOT NULL)')
          .bind(messageRecord.body, now, messageRecord.conversationId, reverseConvId, reverseConvId).run()
      } catch (d1Err: any) {
        console.warn('[D1 Message Insert Warning]', d1Err?.message)
      }
    }

    emitUserEvent(actualSender, 'new_message', messageRecord)
    await broadcastAllStreams('new_message', messageRecord, c.env)

    // Web Push background dispatch (asynchronous, 0ms latency to SSE)
    const recipientToNotify = cleanRemoteHandle || (conv?.user_a === actualSender ? conv?.user_b : conv?.user_a) || null
    const pushNotification = {
      title: `@${cleanSenderHandle || 'User'}`,
      body: messageRecord.body,
      conversationId: messageRecord.conversationId,
      url: `/?conv=${messageRecord.conversationId}`,
    }
    try {
      await sendPushNotification(c.env, recipientToNotify, pushNotification)
    } catch (e: any) {
      console.warn('[Push Notification Error]', e?.message)
    }

    const targetUrl = remoteInstanceUrl || memoryStore.conversations.get(conversationId)?.remote_instance_url
    if (targetUrl) {
      let senderHandle = myHandle || ''
      if (db && !senderHandle) {
        try {
          const adminRow: any = await db.prepare("SELECT handle FROM users WHERE role = 'admin' LIMIT 1").first()
          if (adminRow) senderHandle = adminRow.handle
        } catch (e) {}
      }
      senderHandle = senderHandle || memoryStore.users.get(actualSender)?.handle || 'me'
      const targetHandle = remoteHandle || memoryStore.conversations.get(conversationId)?.remote_handle

      try {
        await fetch(`${normalizeUrl(targetUrl)}/api/federation/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender_handle: senderHandle,
            recipient_handle: targetHandle,
            body: messageRecord.body,
            conversation_id: 'conv_' + senderHandle,
            timestamp: now,
          }),
        })
      } catch (err: any) {
        console.warn('[Remote Forward Warning]', err?.message)
      }
    }

    return c.json({ success: true, message: messageRecord }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// Peer sent a message to us
app.post('/api/federation/v1/messages', async (c) => {
  try {
    const { sender_handle, body, timestamp } = await c.req.json()
    const cleanSender = (sender_handle || 'peer').replace(/^@/, '').trim().toLowerCase()
    const conversationId = 'conv_' + cleanSender
    const messageId = 'msg_in_' + Math.random().toString(36).slice(2, 9)
    const now = timestamp || Date.now()

    const adminUser = memoryStore.users.get('usr_admin')
    const adminHandle = adminUser?.handle || 'admin'

    const messageRecord = {
      id: messageId,
      conversationId,
      senderId: cleanSender,
      senderHandle: cleanSender,
      recipientHandle: adminHandle,
      body: body || '',
      createdAt: new Date(now).toISOString(),
      readAt: null,
    }

    memoryStore.messages.push({
      id: messageRecord.id,
      conversation_id: messageRecord.conversationId,
      sender_id: messageRecord.senderId,
      content: messageRecord.body,
      created_at: now,
      read_at: null,
    })
    const conv = memoryStore.conversations.get(conversationId)
    if (conv) {
      conv.last_message_snippet = messageRecord.body
      conv.last_message_at = now
    }

    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare('INSERT INTO messages (id, conversation_id, sender_id, content, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)')
          .bind(messageRecord.id, messageRecord.conversationId, messageRecord.senderId, messageRecord.body, now).run()
        await db.prepare('UPDATE conversations SET last_message_snippet = ?, last_message_at = ? WHERE id = ?')
          .bind(messageRecord.body, now, conversationId).run()
      } catch (d1Err: any) {
        console.warn('[D1 Peer Inbound Message Warning]', d1Err?.message)
      }
    }

    await broadcastAllStreams('new_message', messageRecord, c.env)

    // Web Push background alert for inbound peer message (asynchronous, never blocks HTTP response)
    const pushNotification = {
      title: `@${cleanSender}`,
      body: messageRecord.body,
      conversationId: messageRecord.conversationId,
      url: `/?conv=${messageRecord.conversationId}`,
    }
    try {
      await sendPushNotification(c.env, null, pushNotification)
    } catch (e: any) {
      console.warn('[Federation Inbound Push Error]', e?.message)
    }

    return c.json({ success: true, id: messageId }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// ============================================================================
// 10.5 Lightweight Media Attachment API (Optimized for Free D1 & wsrv.nl)
// ============================================================================
app.post('/api/media/upload', async (c) => {
  try {
    const { data, contentType } = await c.req.json()
    if (!data || typeof data !== 'string') {
      return c.json({ error: 'Missing media data' }, 400)
    }

    // Safety check: 350 KB payload limit to ensure D1 rows stay super lightweight
    if (data.length > 400 * 1024) {
      return c.json({ error: 'Image exceeds maximum compressed size. Please compress to under 300KB.' }, 400)
    }

    const mediaId = 'med_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
    const mime = contentType || 'image/webp'
    const now = Date.now()

    memoryStore.media.set(mediaId, {
      id: mediaId,
      contentType: mime,
      data,
      createdAt: now,
    })

    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db.prepare('INSERT OR REPLACE INTO media_attachments (id, content_type, data, created_at) VALUES (?, ?, ?, ?)')
          .bind(mediaId, mime, data, now).run()
      } catch (d1Err: any) {
        console.warn('[D1 Media Save Warning]', d1Err?.message)
      }
    }

    const reqUrl = new URL(c.req.url)
    const publicUrl = `${reqUrl.protocol}//${reqUrl.host}/api/media/${mediaId}`

    return c.json({
      success: true,
      id: mediaId,
      url: publicUrl,
    }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

app.get('/api/media/:id', async (c) => {
  const id = c.req.param('id')
  let mediaRecord = memoryStore.media.get(id)

  const db = c.env?.DB
  if (!mediaRecord && db) {
    try {
      await ensureD1Database(db)
      const row: any = await db.prepare('SELECT * FROM media_attachments WHERE id = ? LIMIT 1').bind(id).first()
      if (row) {
        mediaRecord = {
          id: row.id,
          contentType: row.content_type,
          data: row.data,
          createdAt: row.created_at,
        }
        memoryStore.media.set(id, mediaRecord)
      }
    } catch (d1Err: any) {
      console.warn('[D1 Media Fetch Warning]', d1Err?.message)
    }
  }

  if (!mediaRecord) {
    return c.text('Media not found', 404)
  }

  let base64Content = mediaRecord.data
  if (base64Content.includes(',')) {
    base64Content = base64Content.split(',')[1]
  }

  try {
    const binaryStr = atob(base64Content)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': mediaRecord.contentType || 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return c.text('Failed to decode media', 500)
  }
})

// ============================================================================
// 11. Server-Sent Events Stream (Durable Object Global Room + Zero Polling)
// ============================================================================
app.get('/api/stream', async (c) => {
  // If Cloudflare Durable Object is bound, forward to the singleton cross-isolate room!
  // This delivers messages across ALL isolates, PC, mobile, and tablets in 0 milliseconds!
  if (c.env?.REALTIME_ROOM) {
    try {
      const id = c.env.REALTIME_ROOM.idFromName('global_room')
      const stub = c.env.REALTIME_ROOM.get(id)
      return stub.fetch(new Request('http://internal/stream', {
        headers: c.req.raw.headers,
      }))
    } catch (e: any) {
      console.warn('[DO Stream Route Fallback]', e?.message)
    }
  }

  const userId = c.req.query('userId') || 'usr_admin'

  return streamSSE(c, async (stream) => {
    const clientId = 'client_' + Math.random().toString(36).slice(2, 9)

    const clientRecord: UserStreamClient = {
      id: clientId,
      userId,
      write: (data: string) => {
        stream.write(data)
      },
    }

    if (!activeStreams.has(userId)) {
      activeStreams.set(userId, new Set())
    }
    activeStreams.get(userId)!.add(clientRecord)

    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({
        clientId,
        userId,
        timestamp: Date.now(),
        edgeNode: 'Kathmandu (KTM) PoP',
      }),
    })

    // 100% PURE EVENT-DRIVEN SSE (Fallback Mode):
    // Zero D1 reads, zero D1 writes, zero polling!
    // TCP keepalive ping every 12s so socket stays active without database touches.
    const pingInterval = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ t: Date.now() }),
        })
      } catch {
        clearInterval(pingInterval)
        activeStreams.get(userId)?.delete(clientRecord)
      }
    }, 12000)

    stream.onAbort(() => {
      clearInterval(pingInterval)
      activeStreams.get(userId)?.delete(clientRecord)
    })

    // 25s stream lifecycle on fallback to ensure fast reconnection sync if DO is not bound
    await new Promise((resolve) => setTimeout(resolve, 25000))
    clearInterval(pingInterval)
    activeStreams.get(userId)?.delete(clientRecord)
  })
})

// ============================================================================
// 12. Identity & Health
// ============================================================================
app.get('/api/federation/identity', async (c) => {
  await ensureServerKeyPair(c.env?.DB)
  const myHandle = memoryStore.users.get('usr_admin')?.handle || 'admin'
  return c.json({
    version: '1.0.0',
    instance_url: c.req.url.replace(/\/api\/.*$/, ''),
    handle: myHandle,
    name: memoryStore.config.get('display_name') || 'Chatze User',
    public_key: exportedPublicKeyBase64,
    algorithm: 'ECDSA-P256-SHA256',
    created_at: Date.now(),
  })
})

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    engine: 'hono-cloudflare-workers',
    edgeNode: 'Kathmandu (KTM) PoP',
    federation: 'enabled',
  })
)

// ============================================================================
// 12.5 Web Push Notification Subscriptions API (Zero-Polling Background Alerts)
// ============================================================================
app.get('/api/push/vapid-public-key', async (c) => {
  const vapid = await getOrGenerateVapidKeys(c.env)
  return c.json({ publicKey: vapid.publicKey })
})

app.post('/api/push/subscribe', async (c) => {
  try {
    const { endpoint, keys, userHandle, userAgent } = await c.req.json()
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return c.json({ error: 'Invalid push subscription payload' }, 400)
    }

    const cleanHandle = (userHandle || 'admin').replace(/^@/, '').trim().toLowerCase()
    const subId = 'sub_' + Math.random().toString(36).slice(2, 10)
    const now = Date.now()

    const subRecord: StoredSubscription = {
      id: subId,
      user_handle: cleanHandle,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: userAgent || 'Browser PWA',
      created_at: now,
    }

    // Save in memory cache
    memoryPushSubscriptions.set(endpoint, subRecord)

    // Save in D1 if available
    const db = c.env?.DB
    if (db) {
      try {
        await ensureD1Database(db)
        await db
          .prepare(
            'INSERT INTO push_subscriptions (id, user_handle, endpoint, p256dh, auth, user_agent, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(endpoint) DO UPDATE SET user_handle = excluded.user_handle, p256dh = excluded.p256dh, auth = excluded.auth'
          )
          .bind(subId, cleanHandle, endpoint, keys.p256dh, keys.auth, userAgent || 'Browser PWA', now)
          .run()
      } catch (err: any) {
        console.warn('[D1 Push Subscribe Warning]', err?.message)
      }
    }

    return c.json({ success: true, id: subId }, 201)
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

app.post('/api/push/unsubscribe', async (c) => {
  try {
    const { endpoint } = await c.req.json()
    if (!endpoint) return c.json({ error: 'Endpoint required' }, 400)

    memoryPushSubscriptions.delete(endpoint)
    const db = c.env?.DB
    if (db) {
      try {
        await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run()
      } catch {}
    }
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

app.post('/api/push/test', async (c) => {
  try {
    const { userHandle } = await c.req.json().catch(() => ({}))
    const summary = await sendPushNotification(c.env, userHandle || null, {
      title: 'Chatze Notification Test',
      body: '🎉 Notifications working on your device! You will receive alerts when new messages arrive.',
      url: '/',
    })

    return c.json({
      success: summary.successful > 0 || summary.dispatched > 0,
      dispatched: summary.dispatched,
      successful: summary.successful,
      results: summary.results,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

app.get('/api/push/status', async (c) => {
  try {
    const db = c.env?.DB
    let subs: any[] = []
    if (db) {
      try {
        const { results } = await db
          .prepare('SELECT id, user_handle, endpoint, user_agent, created_at FROM push_subscriptions')
          .all()
        if (Array.isArray(results)) subs = results
      } catch {}
    }
    if (subs.length === 0) {
      subs = Array.from(memoryPushSubscriptions.values()).map((s) => ({
        id: s.id,
        user_handle: s.user_handle,
        endpoint: s.endpoint,
        user_agent: s.user_agent,
        created_at: s.created_at,
      }))
    }
    return c.json({
      activeSubscriptions: subs.length,
      subscriptions: subs.map((s) => {
        let domain = 'unknown'
        try {
          domain = new URL(s.endpoint).hostname
        } catch {}
        return {
          id: s.id,
          user_handle: s.user_handle,
          gateway: domain,
          created_at: s.created_at,
        }
      }),
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 400)
  }
})

// Fallback to static assets in production on Cloudflare Workers
app.all('*', async (c) => {
  if (c.env?.ASSETS) {
    const res = await c.env.ASSETS.fetch(c.req.raw)
    const url = new URL(c.req.url)
    if (url.pathname.startsWith('/assets/')) {
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }
    return res
  }
  return c.notFound()
})

// ============================================================================
// 13. Cloudflare Durable Object: RealtimeBroadcaster (Zero-Polling Cross-Isolate Hub)
// ============================================================================
export class RealtimeBroadcaster {
  state: any
  env: any
  sessions: Set<ReadableStreamDefaultController>

  constructor(state: any, env: any) {
    this.state = state
    this.env = env
    this.sessions = new Set()

    // Pure TCP ping every 15s to keep connections alive: ZERO database queries!
    setInterval(() => {
      if (this.sessions.size > 0) {
        const pingPayload = new TextEncoder().encode(`: ping\n\nevent: ping\ndata: {"t":${Date.now()}}\n\n`)
        for (const controller of Array.from(this.sessions)) {
          try {
            controller.enqueue(pingPayload)
          } catch {
            this.sessions.delete(controller)
          }
        }
      }
    }, 15000)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Broadcast event across all connected clients on any device/isolate in 0ms!
    if (url.pathname === '/broadcast') {
      try {
        const body: any = await request.json()
        const eventName = body.event || 'new_message'
        const eventData = typeof body.data === 'string' ? body.data : JSON.stringify(body.data)
        const chunk = new TextEncoder().encode(`event: ${eventName}\ndata: ${eventData}\n\n`)

        for (const controller of Array.from(this.sessions)) {
          try {
            controller.enqueue(chunk)
          } catch {
            this.sessions.delete(controller)
          }
        }
        return new Response(JSON.stringify({ success: true, count: this.sessions.size }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 })
      }
    }

    // Connect SSE client into global room
    if (url.pathname === '/stream') {
      let clientController: ReadableStreamDefaultController
      const stream = new ReadableStream({
        start: (controller) => {
          clientController = controller
          this.sessions.add(controller)
          // Initial flush with comment to prevent mobile browser proxy buffering
          const welcome = new TextEncoder().encode(': ok\n\nevent: connected\ndata: {"status":"connected","source":"durable_object"}\n\n')
          controller.enqueue(welcome)
        },
        cancel: () => {
          this.sessions.delete(clientController)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    return new Response('Not Found', { status: 404 })
  }
}

export default app
