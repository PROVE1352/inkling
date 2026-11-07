// Plugin host: creates sandboxed plugin iframes, wires them to a PluginBroker over a private
// MessageChannel, proxies RPCs to the server with the user's session, and enforces liveness and
// resource limits. See docs/PLUGINS.md "Security model".
//
// Isolation recap:
//  - <iframe sandbox="allow-scripts"> (never allow-same-origin) → opaque origin; the frame
//    document is also served with CSP `sandbox allow-scripts`, `connect-src 'none'`, nonce scripts.
//  - The frame gets exactly one capability: a MessagePort, handed over on its FIRST load event.
//    A second load event means the plugin navigated its frame → the frame is killed.
//  - Parent → frame messages go through that port only (no window.postMessage with '*').
//  - Every request is validated/rate-limited/permission-checked in broker.ts before reaching here.

import { api, ApiError } from '../api'
import { askConfirm } from '../lib/confirm'
import { resolvedTheme, subscribe as subscribeTheme } from '../lib/theme'
import { toast } from '../lib/toast'
import type { PluginInfo } from './api'
import { PluginBroker, PluginError, type BrokerHandlers, type KillReason } from './broker'
import { encodeEvent, HANDSHAKE, LIMITS, type FrameMode, type MethodParams } from './protocol'
import { PLUGIN_STRINGS as S } from './strings'

export type PluginContext = { workspaceId: string | null; pageId: string | null }

export type BlockBinding = {
  type: string
  data: Record<string, unknown>
  editable: boolean
  onResize: (height: number) => void
  onSetData: (data: Record<string, unknown>) => void
}

type FrameOptions = {
  plugin: PluginInfo
  mode: FrameMode
  container: HTMLElement
  context: PluginContext
  block?: BlockBinding
  onDead?: (reason: KillReason) => void
  /** Hidden worker frames are 0×0 and aria-hidden. */
  hidden?: boolean
}

// ------------------------------------------------------------------ frame slots
const alive = new Set<PluginFrame>()
const slotListeners = new Set<() => void>()

/** Subscribe to "a frame slot was released" (blocks waiting for a slot retry on this). */
export function onSlotFreed(cb: () => void): () => void {
  slotListeners.add(cb)
  return () => {
    slotListeners.delete(cb)
  }
}

function releaseSlot(f: PluginFrame) {
  if (alive.delete(f)) for (const cb of [...slotListeners]) cb()
}

/** Reserve a slot, evicting the least-recently-used idle worker if needed. */
function acquireSlot(): boolean {
  if (alive.size < LIMITS.maxFrames) return true
  let lru: WorkerEntry | null = null
  for (const w of workers.values()) {
    if (!lru || w.lastUsed < lru.lastUsed) lru = w
  }
  if (lru) {
    disposeWorker(lru.plugin.id)
    return alive.size < LIMITS.maxFrames
  }
  return false
}

// ------------------------------------------------------------------ theme fan-out
let themeUnsub: (() => void) | null = null
function ensureThemeSubscription() {
  if (themeUnsub) return
  themeUnsub = subscribeTheme(() => {
    const msg = encodeEvent('theme', { theme: resolvedTheme() })
    for (const f of alive) f.post(msg)
  })
}

// ------------------------------------------------------------------ server proxy
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), LIMITS.rpcTimeoutMs)
  try {
    return await api<T>(path, { ...init, signal: ctrl.signal })
  } catch (err) {
    if (err instanceof ApiError) throw new PluginError(err.code, err.message)
    if ((err as { name?: string })?.name === 'AbortError') throw new PluginError('TIMEOUT', 'request timed out')
    throw new PluginError('FAILED', 'request failed')
  } finally {
    window.clearTimeout(timer)
  }
}

const lastNoticeAt = new Map<string, number>()
const lastWriteConfirmAt = new Map<string, number>()
const writeConfirmPending = new Set<string>()

function makeHandlers(frame: PluginFrame): BrokerHandlers {
  const plugin = frame.plugin
  const base = `/api/plugins/${encodeURIComponent(plugin.id)}`
  let setDataTimer: number | null = null
  let pendingData: Record<string, unknown> | null = null

  return {
    'pages.get': async ({ pageId }: MethodParams['pages.get']) =>
      (await call<{ page: unknown }>(`${base}/pages/${pageId}`)).page,

    'pages.search': async ({ query, workspaceId }: MethodParams['pages.search']) => {
      const ws = workspaceId ?? frame.context.workspaceId
      if (!ws) throw new PluginError('NO_WORKSPACE', 'no workspace in context')
      const qs = `workspaceId=${encodeURIComponent(ws)}&q=${encodeURIComponent(query)}`
      return (await call<{ pages: unknown[] }>(`${base}/search?${qs}`)).pages
    },

    'pages.update': async ({ pageId, markdown, mode }: MethodParams['pages.update']) => {
      // One pending confirmation per plugin, and a minimum spacing between dialogs, so a plugin
      // cannot spam or pre-empt the user's own confirmation dialogs.
      if (writeConfirmPending.has(plugin.id)) throw new PluginError('BUSY', S.writeBusy)
      const last = lastWriteConfirmAt.get(plugin.id) ?? 0
      if (Date.now() - last < LIMITS.writeConfirmMinIntervalMs) throw new PluginError('RATE_LIMITED', S.writeBusy)
      writeConfirmPending.add(plugin.id)
      let ok = false
      try {
        ok = await askConfirm(
          S.confirmWrite(plugin.name, mode, pageId === frame.context.pageId),
          S.confirmWriteLabel,
        )
      } finally {
        writeConfirmPending.delete(plugin.id)
        lastWriteConfirmAt.set(plugin.id, Date.now())
      }
      if (!ok) throw new PluginError('DENIED', S.writeDenied)
      await call(`${base}/pages/${pageId}/content`, {
        method: 'POST',
        body: JSON.stringify({ markdown, mode }),
      })
      return { ok: true }
    },

    'storage.get': async ({ key }: MethodParams['storage.get']) =>
      (await call<{ value: unknown }>(`${base}/storage/${encodeURIComponent(key)}`)).value,
    'storage.set': async ({ key, value }: MethodParams['storage.set']) => {
      await call(`${base}/storage/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      return { ok: true }
    },
    'storage.delete': async ({ key }: MethodParams['storage.delete']) => {
      await call(`${base}/storage/${encodeURIComponent(key)}`, { method: 'DELETE' })
      return { ok: true }
    },
    'storage.keys': async () => (await call<{ keys: string[] }>(`${base}/storage`)).keys,

    'ui.notice': ({ message }: MethodParams['ui.notice']) => {
      const now = Date.now()
      if (now - (lastNoticeAt.get(plugin.id) ?? 0) < LIMITS.noticeMinIntervalMs) {
        throw new PluginError('RATE_LIMITED', 'notices are limited to one per second')
      }
      lastNoticeAt.set(plugin.id, now)
      // Always prefixed with the plugin name so a plugin cannot impersonate app messages.
      toast({ message: S.noticePrefix(plugin.name) + message, duration: 5000 })
      return { ok: true }
    },

    'block.resize': ({ height }: MethodParams['block.resize']) => {
      frame.block?.onResize(height)
      return { ok: true }
    },

    'block.setData': ({ data }: MethodParams['block.setData']) => {
      const b = frame.block
      if (!b) throw new PluginError('NOT_SUPPORTED', 'not a block')
      if (!b.editable) throw new PluginError('READ_ONLY', S.readOnlyBlock)
      // Coalesce bursts into at most ~4 document writes per second.
      pendingData = data
      if (setDataTimer === null) {
        setDataTimer = window.setTimeout(() => {
          setDataTimer = null
          if (pendingData && !frame.isDead) b.onSetData(pendingData)
          pendingData = null
        }, 250)
      }
      return { ok: true }
    },
  }
}

// ------------------------------------------------------------------ frame
export class PluginFrame {
  readonly plugin: PluginInfo
  readonly mode: FrameMode
  context: PluginContext
  block?: BlockBinding
  readonly broker: PluginBroker
  private iframe: HTMLIFrameElement | null = null
  private port: MessagePort | null = null
  private loads = 0
  private lastPong = 0
  private pingSeq = 0
  private heartbeat: number | null = null
  private handshakeTimer: number | null = null
  private dead = false

  constructor(private readonly o: FrameOptions) {
    this.plugin = o.plugin
    this.mode = o.mode
    this.context = o.context
    this.block = o.block
    this.broker = new PluginBroker({
      pluginId: o.plugin.id,
      permissions: o.plugin.permissions,
      mode: o.mode,
      declaredCommands: o.plugin.commands.map((c) => c.id),
      declaredBlocks: o.plugin.blocks.map((b) => b.type),
      blockType: o.block?.type,
      handlers: makeHandlers(this),
      post: (m) => this.post(m),
      kill: (reason) => this.kill(reason),
      onPong: () => {
        this.lastPong = Date.now()
      },
      onCommandRegistered: (id) => this.onCommandRegistered?.(id),
    })
  }

  onCommandRegistered?: (id: string) => void

  get isDead(): boolean {
    return this.dead
  }

  /** Create the iframe. Caller must have acquired a slot. */
  start(): void {
    alive.add(this)
    ensureThemeSubscription()
    const f = document.createElement('iframe')
    // The ONLY sandbox token. Never add allow-same-origin: with it, the frame would share the app
    // origin (cookies, localStorage, parent DOM) and could remove its own sandbox.
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('referrerpolicy', 'no-referrer')
    // No delegated powerful features (camera, clipboard, fullscreen, …).
    f.setAttribute('allow', '')
    // Where supported, load without any credentials at all (defense in depth).
    f.setAttribute('credentialless', '')
    f.title = this.plugin.name
    f.src = this.plugin.frameUrl
    f.style.border = '0'
    f.style.display = 'block'
    if (this.o.hidden) {
      f.setAttribute('aria-hidden', 'true')
      f.tabIndex = -1
      f.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0'
    } else {
      f.style.width = '100%'
      f.style.height = '100%'
      f.style.background = 'transparent'
    }
    f.addEventListener('load', this.onLoad)
    this.iframe = f
    this.handshakeTimer = window.setTimeout(() => this.kill('handshake'), LIMITS.handshakeTimeoutMs)
    this.o.container.appendChild(f)
  }

  private onLoad = () => {
    if (this.dead || !this.iframe) return
    this.loads++
    if (this.loads > 1) {
      // The plugin navigated its own frame (only possible channel left for exfiltration).
      this.kill('navigated')
      return
    }
    const win = this.iframe.contentWindow
    if (!win) {
      this.kill('handshake')
      return
    }
    const ch = new MessageChannel()
    this.port = ch.port1
    ch.port1.onmessage = (e: MessageEvent) => this.broker.receive(e.data)
    // targetOrigin must be '*': a sandboxed frame has an opaque origin that cannot be named.
    // The capability is the transferred port, delivered to this specific window object.
    win.postMessage(HANDSHAKE, '*', [ch.port2])
    if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.post(
      encodeEvent('init', {
        context: {
          pluginId: this.plugin.id,
          mode: this.mode,
          workspaceId: this.context.workspaceId,
          pageId: this.context.pageId,
          theme: resolvedTheme(),
          blockType: this.block?.type ?? null,
          data: this.block?.data ?? null,
          editable: this.block?.editable ?? false,
        },
      }),
    )
    this.lastPong = Date.now()
    this.heartbeat = window.setInterval(() => {
      if (Date.now() - this.lastPong > LIMITS.heartbeatTimeoutMs) {
        this.kill('unresponsive')
        return
      }
      this.post(encodeEvent('ping', { n: ++this.pingSeq }))
    }, LIMITS.heartbeatMs)
  }

  post(msg: string): void {
    if (!this.dead && this.port) this.port.postMessage(msg)
  }

  /** Push new block data (e.g. a collaborator changed it). */
  updateBlock(data: Record<string, unknown>, editable: boolean): void {
    if (this.block) {
      this.block.data = data
      this.block.editable = editable
    }
    this.post(encodeEvent('block.data', { data, editable }))
  }

  kill(reason: KillReason): void {
    if (this.dead) return
    this.destroy()
    if (reason !== 'closed') {
      toast({ message: S.stopped(this.plugin.name, S.killReason[reason] ?? reason), duration: 6000 })
    }
    this.o.onDead?.(reason)
  }

  destroy(): void {
    if (this.dead) return
    this.dead = true
    this.broker.close()
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat)
    if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer)
    this.heartbeat = null
    this.handshakeTimer = null
    try {
      this.port?.close()
    } catch {
      // already closed
    }
    this.port = null
    if (this.iframe) {
      this.iframe.removeEventListener('load', this.onLoad)
      // Removing the element unloads the document and stops its scripts.
      this.iframe.remove()
      this.iframe = null
    }
    releaseSlot(this)
  }
}

/** Create + start a block frame, or null when no slot is free. */
export function startBlockFrame(opts: Omit<FrameOptions, 'mode' | 'hidden'>): PluginFrame | null {
  if (!acquireSlot()) return null
  const f = new PluginFrame({ ...opts, mode: 'block' })
  f.start()
  return f
}

// ------------------------------------------------------------------ command workers
type WorkerEntry = {
  plugin: PluginInfo
  frame: PluginFrame
  lastUsed: number
  idleTimer: number | null
  waiters: Map<string, Array<() => void>>
}
const workers = new Map<string, WorkerEntry>()
let workerHost: HTMLDivElement | null = null

function hostEl(): HTMLDivElement {
  if (!workerHost || !workerHost.isConnected) {
    workerHost = document.createElement('div')
    workerHost.setAttribute('data-plugin-workers', '')
    workerHost.setAttribute('aria-hidden', 'true')
    document.body.appendChild(workerHost)
  }
  return workerHost
}

function disposeWorker(id: string) {
  const w = workers.get(id)
  if (!w) return
  workers.delete(id)
  if (w.idleTimer !== null) window.clearTimeout(w.idleTimer)
  w.frame.destroy()
}

function touch(w: WorkerEntry) {
  w.lastUsed = Date.now()
  if (w.idleTimer !== null) window.clearTimeout(w.idleTimer)
  w.idleTimer = window.setTimeout(() => disposeWorker(w.plugin.id), LIMITS.workerIdleMs)
}

function getWorker(plugin: PluginInfo, context: PluginContext): WorkerEntry | null {
  const cur = workers.get(plugin.id)
  if (cur && !cur.frame.isDead && cur.plugin.frameUrl === plugin.frameUrl) {
    cur.frame.context = context
    return cur
  }
  if (cur) disposeWorker(plugin.id)
  if (!acquireSlot()) return null
  const frame = new PluginFrame({
    plugin,
    mode: 'worker',
    container: hostEl(),
    context,
    hidden: true,
    onDead: () => {
      const w = workers.get(plugin.id)
      if (w?.frame === frame) {
        workers.delete(plugin.id)
        if (w.idleTimer !== null) window.clearTimeout(w.idleTimer)
      }
    },
  })
  const entry: WorkerEntry = { plugin, frame, lastUsed: Date.now(), idleTimer: null, waiters: new Map() }
  frame.onCommandRegistered = (id) => {
    const ws = entry.waiters.get(id)
    entry.waiters.delete(id)
    ws?.forEach((fn) => fn())
  }
  workers.set(plugin.id, entry)
  frame.start()
  return entry
}

function waitForCommand(w: WorkerEntry, commandId: string): Promise<boolean> {
  if (w.frame.broker.registeredCommands.has(commandId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), LIMITS.commandRegisterTimeoutMs)
    const list = w.waiters.get(commandId) ?? []
    list.push(() => {
      window.clearTimeout(timer)
      resolve(true)
    })
    w.waiters.set(commandId, list)
  })
}

/** Run a manifest-declared command of an active plugin (from the command palette). */
export async function runPluginCommand(
  plugin: PluginInfo,
  commandId: string,
  context: PluginContext,
): Promise<void> {
  if (!plugin.permissions.includes('commands')) return
  if (!plugin.commands.some((c) => c.id === commandId)) return
  const w = getWorker(plugin, context)
  if (!w) {
    toast({ message: S.tooManyFrames })
    return
  }
  touch(w)
  const ok = await waitForCommand(w, commandId)
  if (!ok || w.frame.isDead) {
    if (!w.frame.isDead) toast({ message: S.commandTimeout(plugin.name) })
    return
  }
  w.frame.post(encodeEvent('command', { commandId, context }))
  touch(w)
}

/** Current workspace/page from the URL (/w/:wsId/p/:pageId). */
export function contextFromLocation(): PluginContext {
  const m = /\/w\/([0-9a-f-]{36})(?:\/p\/([0-9a-f-]{36}))?/i.exec(window.location.pathname)
  return { workspaceId: m?.[1] ?? null, pageId: m?.[2] ?? null }
}
