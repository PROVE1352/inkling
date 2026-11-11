import type { FastifyRequest } from 'fastify'
import type { AuthUser } from './auth'

/**
 * Request gates (0.22, docs/adr/2502-*): checks that run on every authenticated request, after the
 * person is known and before the route, e.g. "has not consented to the current terms" (LEGAL_DIR).
 * A gate passes by returning and refuses by throwing an AppError (the response is that error).
 *
 * Where they run (the places that turn a credential into a user):
 *   - REST, cookie session and bearer alike: auth.ts authenticate() (requireUser / requireAdmin),
 *     which also covers the routes MCP tools call through app.inject and automation runs;
 *     channel 'http'. Routes in GATE_EXEMPT_ROUTES skip the gates.
 *   - The /mcp endpoint itself (initialize, tools/list before any tool reaches REST): channel 'mcp'.
 *   - The collaboration socket, per document (Hocuspocus onAuthenticate): channel 'collab', no req.
 *
 * With no gate registered every check is one Map size test and nothing else changes.
 */

export type GateChannel = 'http' | 'mcp' | 'collab'

export interface GateContext {
  user: AuthUser
  /** The HTTP request (channels 'http' and 'mcp'); null on the collaboration socket. */
  req: FastifyRequest | null
  /** How the person signed in: browser session, bearer token (API token, MCP, automation run), or the collab socket's session cookie. */
  via: 'cookie' | 'bearer' | 'collab'
  channel: GateChannel
}

export type RequestGate = (ctx: GateContext) => void | Promise<void>

/**
 * REST routes that never run the gates (method + Fastify route pattern, `/api` prefix included), so a
 * person a gate refuses can still sign out, see who they are, read the documents, consent, and leave.
 * `prefix: true` matches the pattern and everything below it.
 */
export const GATE_EXEMPT_ROUTES: readonly { method: string; url: string; prefix?: true }[] = [
  { method: 'POST', url: '/api/auth/logout' },
  { method: 'GET', url: '/api/auth/me' },
  // terms, privacy, sign-up texts, and the consent submission (POST /api/legal/consent)
  { method: '*', url: '/api/legal', prefix: true },
  { method: 'DELETE', url: '/api/me' },
  { method: 'GET', url: '/api/me/delete-preview' },
]

export function isGateExempt(method: string, url: string | undefined): boolean {
  if (!url) return false
  const m = method.toUpperCase()
  return GATE_EXEMPT_ROUTES.some(
    (r) =>
      (r.method === '*' || r.method === m || (r.method === 'GET' && m === 'HEAD')) &&
      (r.prefix ? url === r.url || url.startsWith(`${r.url}/`) : url === r.url),
  )
}

const gates = new Map<string, RequestGate>()

/** Register a gate under a unique name. Returns the function that removes it (tests). */
export function registerRequestGate(name: string, fn: RequestGate): () => void {
  if (gates.has(name)) throw new Error(`request gate "${name}" is already registered`)
  gates.set(name, fn)
  return () => {
    if (gates.get(name) === fn) gates.delete(name)
  }
}

export function hasRequestGates(): boolean {
  return gates.size > 0
}

/** Run every gate in registration order; the first that throws decides. */
export async function runRequestGates(ctx: GateContext): Promise<void> {
  if (gates.size === 0) return
  for (const g of [...gates.values()]) await g(ctx)
}

/** The REST form: skips exempt routes. Called by auth.ts once req.user is set. */
export async function runRequestGatesForRequest(req: FastifyRequest): Promise<void> {
  if (gates.size === 0 || !req.user) return
  if (isGateExempt(req.method, req.routeOptions?.url)) return
  await runRequestGates({ user: req.user, req, via: req.authVia ?? 'cookie', channel: 'http' })
}
