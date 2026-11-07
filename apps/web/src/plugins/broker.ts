// Parent-side RPC broker for ONE plugin frame. DOM-free (unit-tested under Node).
//
// Every message that comes out of a plugin iframe goes through `receive()`:
//   1. type/size check (strings only, ≤ LIMITS.maxMessageChars, before JSON.parse)
//   2. per-frame token-bucket rate limit
//   3. schema check (known method, positive integer id, typed params)
//   4. permission check against the ADMIN-APPROVED permission set (not the manifest's request)
//   5. declared-contribution check (command ids / block types must be in the manifest)
//   6. in-flight cap, then dispatch to the host's handler and answer with the same request id
// Repeated violations or oversize floods call `kill()`; the host then tears the iframe down.

import {
  BLOCK_ONLY,
  encodeError,
  encodeResult,
  LIMITS,
  METHOD_PERMISSION,
  parseIncoming,
  TokenBucket,
  validateParams,
  type FrameMode,
  type Method,
  type MethodParams,
  type PluginPermission,
} from './protocol'

export type KillReason = 'flood' | 'oversize' | 'unresponsive' | 'navigated' | 'handshake' | 'closed'

export type Handler<M extends Method> = (params: MethodParams[M]) => Promise<unknown> | unknown

export type BrokerHandlers = { [M in Method]?: Handler<M> }

export type BrokerOptions = {
  pluginId: string
  /** Effective permissions approved by the server admin. */
  permissions: readonly PluginPermission[]
  mode: FrameMode
  /** Manifest-declared contributions. */
  declaredCommands: readonly string[]
  declaredBlocks: readonly string[]
  /** For block frames: the block type this frame renders. */
  blockType?: string
  handlers: BrokerHandlers
  /** Send a string to the frame (port.postMessage). */
  post: (msg: string) => void
  kill: (reason: KillReason) => void
  onPong?: (n: number) => void
  onCommandRegistered?: (id: string) => void
  now?: () => number
}

export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class PluginBroker {
  readonly registeredCommands = new Set<string>()
  readonly registeredBlocks = new Set<string>()
  private readonly bucket: TokenBucket
  private readonly perms: ReadonlySet<PluginPermission>
  private inFlight = 0
  private violations = 0
  private oversize = 0
  private dead = false
  /** Counters exposed for tests/diagnostics. */
  readonly stats = { received: 0, dropped: 0, answered: 0 }

  constructor(private readonly o: BrokerOptions) {
    this.bucket = new TokenBucket(LIMITS.rateBurst, LIMITS.rateRefillPerSec, o.now)
    this.perms = new Set(o.permissions)
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Stop processing (frame destroyed). Pending handler results are discarded. */
  close(): void {
    this.dead = true
  }

  private violate(reason: KillReason = 'flood'): void {
    this.stats.dropped++
    this.violations++
    if (this.violations > LIMITS.maxViolations) this.terminate(reason)
  }

  private terminate(reason: KillReason): void {
    if (this.dead) return
    this.dead = true
    this.o.kill(reason)
  }

  private reply(msg: string): void {
    if (this.dead) return
    this.stats.answered++
    this.o.post(msg)
  }

  receive(raw: unknown): void {
    if (this.dead) return
    this.stats.received++

    // Rate limit first: a flood must not even cost a JSON.parse.
    if (!this.bucket.take()) {
      this.violate()
      return
    }
    const msg = parseIncoming(raw)
    if (msg.kind === 'oversize') {
      this.oversize++
      this.stats.dropped++
      if (this.oversize >= LIMITS.maxOversize) this.terminate('oversize')
      return
    }
    if (msg.kind === 'pong') {
      this.o.onPong?.(msg.n)
      return
    }
    if (msg.kind === 'invalid') {
      this.violate()
      if (msg.id !== undefined) this.reply(encodeError(msg.id, 'BAD_REQUEST', msg.reason))
      return
    }

    const { id, method } = msg
    const perm = METHOD_PERMISSION[method]
    if (perm && !this.perms.has(perm)) {
      this.violate()
      this.reply(encodeError(id, 'PERMISSION_DENIED', `"${method}" requires the "${perm}" permission`))
      return
    }
    if (BLOCK_ONLY.has(method) && this.o.mode !== 'block') {
      this.violate()
      this.reply(encodeError(id, 'BAD_REQUEST', `"${method}" is only available inside a block`))
      return
    }
    const v = validateParams(method, msg.params)
    if (!v.ok) {
      this.violate()
      this.reply(encodeError(id, 'BAD_REQUEST', v.error))
      return
    }
    // Contributions must be declared in the (approved) manifest.
    if (method === 'commands.register') {
      const cid = (v.params as MethodParams['commands.register']).id
      if (!this.o.declaredCommands.includes(cid)) {
        this.violate()
        this.reply(encodeError(id, 'NOT_DECLARED', `command "${cid}" is not declared in manifest.json`))
        return
      }
    }
    if (method === 'blocks.register') {
      const bt = (v.params as MethodParams['blocks.register']).type
      if (!this.o.declaredBlocks.includes(bt)) {
        this.violate()
        this.reply(encodeError(id, 'NOT_DECLARED', `block type "${bt}" is not declared in manifest.json`))
        return
      }
    }
    if (this.inFlight >= LIMITS.maxInFlight) {
      // Back-pressure, not a violation: the token bucket already bounds how often this can happen.
      this.stats.dropped++
      this.reply(encodeError(id, 'BUSY', 'too many concurrent requests'))
      return
    }

    this.inFlight++
    void this.dispatch(id, method, v.params).finally(() => {
      this.inFlight--
    })
  }

  private async dispatch<M extends Method>(id: number, method: M, params: MethodParams[M]): Promise<void> {
    try {
      let result: unknown
      if (method === 'commands.register') {
        const cid = (params as MethodParams['commands.register']).id
        this.registeredCommands.add(cid)
        this.o.onCommandRegistered?.(cid)
        result = { ok: true }
      } else if (method === 'blocks.register') {
        this.registeredBlocks.add((params as MethodParams['blocks.register']).type)
        result = { ok: true }
      } else {
        const h = this.o.handlers[method] as Handler<M> | undefined
        if (!h) throw new PluginError('NOT_SUPPORTED', `"${method}" is not available here`)
        result = await h(params)
      }
      this.reply(encodeResult(id, result))
    } catch (err) {
      const code = err instanceof PluginError ? err.code : ((err as { code?: string })?.code ?? 'FAILED')
      const message = err instanceof Error ? err.message : 'request failed'
      this.reply(encodeError(id, code, message))
    }
  }
}
