// Plugin API v0 — parent-side wire protocol: limits, message parsing and parameter validation.
// Framework-free and DOM-free on purpose (unit-tested under Node: see broker.test.ts).
//
// Wire format (MessageChannel port, JSON *strings* only — anything else is dropped):
//   frame -> parent  {id:number, method:string, params:object}   RPC request
//   frame -> parent  {pong:number}                                 heartbeat reply
//   parent -> frame  {id, ok:true, result} | {id, ok:false, error:{code, message}}
//   parent -> frame  {event:'init'|'ping'|'theme'|'command'|'block.data', ...}
// The in-frame SDK that speaks this lives in apps/server/src/plugins/frame.ts (SDK_SOURCE).

export const HANDSHAKE = 'inkling-plugin-init:v1'

export const LIMITS = {
  /** Max characters of one incoming message (strings only; checked before JSON.parse). */
  maxMessageChars: 256 * 1024,
  /** Concurrent unanswered RPCs per frame. */
  maxInFlight: 16,
  /** Token bucket per frame: burst and steady rate of incoming messages. */
  rateBurst: 60,
  rateRefillPerSec: 30,
  /** Protocol violations (oversize, malformed, rate-limited, forbidden) tolerated per frame. */
  maxViolations: 100,
  /** Oversized messages tolerated before the frame is killed. */
  maxOversize: 3,
  /** Heartbeat: ping interval and how long without a pong before the frame is killed. */
  heartbeatMs: 4_000,
  heartbeatTimeoutMs: 12_000,
  /** Frame must load + handshake within this time. */
  handshakeTimeoutMs: 10_000,
  /** A command waits this long for the plugin to call commands.register(id). */
  commandRegisterTimeoutMs: 5_000,
  /** Idle worker frames (commands) are torn down after this long. */
  workerIdleMs: 60_000,
  /** Plugin frames alive at once (workers + visible blocks). */
  maxFrames: 8,
  /** Block iframe height clamp (px). */
  blockMinHeight: 40,
  blockMaxHeight: 1200,
  /** Serialized block data stored in the document (JSON chars). */
  blockDataMaxChars: 16 * 1024,
  /** ui.notice */
  noticeMaxChars: 300,
  noticeMinIntervalMs: 1_000,
  /** pages.update confirmation dialogs: minimum spacing per plugin. */
  writeConfirmMinIntervalMs: 3_000,
  /** Server round trip timeout for proxied calls. */
  rpcTimeoutMs: 20_000,
  pagesUpdateMaxChars: 1_000_000,
  searchMaxChars: 200,
} as const

export type PluginPermission = 'commands' | 'read:pages' | 'write:pages' | 'blocks' | 'storage'

export type FrameMode = 'worker' | 'block'

export const METHODS = [
  'commands.register',
  'blocks.register',
  'pages.get',
  'pages.search',
  'pages.update',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
  'ui.notice',
  'block.resize',
  'block.setData',
] as const
export type Method = (typeof METHODS)[number]

/** Permission each method needs (null = always allowed). */
export const METHOD_PERMISSION: Record<Method, PluginPermission | null> = {
  'commands.register': 'commands',
  'blocks.register': 'blocks',
  'pages.get': 'read:pages',
  'pages.search': 'read:pages',
  'pages.update': 'write:pages',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'storage.keys': 'storage',
  'ui.notice': null,
  'block.resize': 'blocks',
  'block.setData': 'blocks',
}

/** Methods that only make sense inside a block frame. */
export const BLOCK_ONLY: ReadonlySet<Method> = new Set<Method>(['block.resize', 'block.setData'])

export type MethodParams = {
  'commands.register': { id: string }
  'blocks.register': { type: string }
  'pages.get': { pageId: string }
  'pages.search': { query: string; workspaceId?: string }
  'pages.update': { pageId: string; markdown: string; mode: 'replace' | 'append' }
  'storage.get': { key: string }
  'storage.set': { key: string; value: unknown }
  'storage.delete': { key: string }
  'storage.keys': Record<string, never>
  'ui.notice': { message: string }
  'block.resize': { height: number }
  'block.setData': { data: Record<string, unknown> }
}

export type Incoming =
  | { kind: 'rpc'; id: number; method: Method; params: unknown }
  | { kind: 'pong'; n: number }
  | { kind: 'oversize' }
  | { kind: 'invalid'; reason: string; id?: number }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const STORAGE_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse one raw port message. Never throws. */
export function parseIncoming(raw: unknown): Incoming {
  if (typeof raw !== 'string') return { kind: 'invalid', reason: 'messages must be JSON strings' }
  if (raw.length > LIMITS.maxMessageChars) return { kind: 'oversize' }
  let m: unknown
  try {
    m = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', reason: 'malformed JSON' }
  }
  if (!isObj(m)) return { kind: 'invalid', reason: 'message must be an object' }
  if ('pong' in m) {
    return typeof m.pong === 'number' ? { kind: 'pong', n: m.pong } : { kind: 'invalid', reason: 'bad pong' }
  }
  const id = m.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return { kind: 'invalid', reason: 'request id must be a positive integer' }
  }
  if (typeof m.method !== 'string' || !(METHODS as readonly string[]).includes(m.method)) {
    return { kind: 'invalid', reason: 'unknown method', id }
  }
  return { kind: 'rpc', id, method: m.method as Method, params: m.params ?? {} }
}

/** Validate params for a method. Returns typed params or an error message. */
export function validateParams<M extends Method>(
  method: M,
  params: unknown,
): { ok: true; params: MethodParams[M] } | { ok: false; error: string } {
  if (!isObj(params)) return { ok: false, error: 'params must be an object' }
  const p = params
  const ok = (v: unknown) => ({ ok: true as const, params: v as MethodParams[M] })
  const bad = (error: string) => ({ ok: false as const, error })
  switch (method) {
    case 'commands.register':
      return typeof p.id === 'string' && LOCAL_ID_RE.test(p.id) ? ok({ id: p.id }) : bad('invalid command id')
    case 'blocks.register':
      return typeof p.type === 'string' && LOCAL_ID_RE.test(p.type) ? ok({ type: p.type }) : bad('invalid block type')
    case 'pages.get':
      return typeof p.pageId === 'string' && UUID_RE.test(p.pageId) ? ok({ pageId: p.pageId }) : bad('pageId must be a UUID')
    case 'pages.search': {
      if (typeof p.query !== 'string' || !p.query.trim() || p.query.length > LIMITS.searchMaxChars) {
        return bad(`query must be 1..${LIMITS.searchMaxChars} characters`)
      }
      if (p.workspaceId !== undefined && (typeof p.workspaceId !== 'string' || !UUID_RE.test(p.workspaceId))) {
        return bad('workspaceId must be a UUID')
      }
      return ok({ query: p.query.trim(), workspaceId: p.workspaceId as string | undefined })
    }
    case 'pages.update': {
      if (typeof p.pageId !== 'string' || !UUID_RE.test(p.pageId)) return bad('pageId must be a UUID')
      if (typeof p.markdown !== 'string' || p.markdown.length > LIMITS.pagesUpdateMaxChars) {
        return bad('markdown must be a string (max 1,000,000 characters)')
      }
      const mode = p.mode ?? 'replace'
      if (mode !== 'replace' && mode !== 'append') return bad("mode must be 'replace' or 'append'")
      return ok({ pageId: p.pageId, markdown: p.markdown, mode })
    }
    case 'storage.get':
    case 'storage.delete':
      return typeof p.key === 'string' && STORAGE_KEY_RE.test(p.key) ? ok({ key: p.key }) : bad('invalid storage key')
    case 'storage.set':
      if (typeof p.key !== 'string' || !STORAGE_KEY_RE.test(p.key)) return bad('invalid storage key')
      if (!('value' in p) || p.value === undefined) return bad('value is required')
      return ok({ key: p.key, value: p.value })
    case 'storage.keys':
      return ok({})
    case 'ui.notice': {
      if (typeof p.message !== 'string' || !p.message.trim()) return bad('message must be a non-empty string')
      return ok({ message: p.message.trim().slice(0, LIMITS.noticeMaxChars) })
    }
    case 'block.resize': {
      const h = p.height
      if (typeof h !== 'number' || !Number.isFinite(h)) return bad('height must be a number')
      return ok({ height: clampHeight(h) })
    }
    case 'block.setData': {
      if (!isObj(p.data)) return bad('data must be an object')
      let text: string
      try {
        text = JSON.stringify(p.data)
      } catch {
        return bad('data must be JSON-serialisable')
      }
      if (text.length > LIMITS.blockDataMaxChars) return bad('block data exceeds 16 KB')
      return ok({ data: JSON.parse(text) as Record<string, unknown> })
    }
  }
  return bad('unknown method')
}

export function clampHeight(h: number): number {
  return Math.min(LIMITS.blockMaxHeight, Math.max(LIMITS.blockMinHeight, Math.round(h)))
}

/** Token bucket with an injectable clock (for tests). */
export class TokenBucket {
  private tokens: number
  private last: number
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.last = now()
  }
  take(): boolean {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec)
    this.last = t
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

export function encodeResult(id: number, result: unknown): string {
  return JSON.stringify({ id, ok: true, result: result ?? null })
}

export function encodeError(id: number, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message } })
}

export function encodeEvent(event: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...payload, event })
}

/** Parse the JSON string stored in a block's `data` prop; anything invalid becomes {}. */
export function parseBlockData(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}
