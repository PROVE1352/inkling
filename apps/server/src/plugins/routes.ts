import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getUser, requireAdmin, requireUser } from '../auth'
import { db } from '../db/index'
import { pluginInstalls, users } from '../db/schema'
import { AppError, forbidden, notFound } from '../errors'
import { requireMembership } from '../helpers'
import { stripFrontmatter } from '../md/convert'
import { exportPageMd } from '../md/exporter'
import { findVisiblePage } from '../pageDto'
import {
  FRAME_SECURITY_HEADERS,
  frameCsp,
  frameHtml,
  newNonce,
  SCRIPT_RESPONSE_CSP,
  SDK_PATH,
  SDK_SOURCE,
} from './frame'
import { APP_VERSION, PLUGIN_ID_RE, type PluginManifest, type PluginPermission } from './manifest'
import { getScannedPlugins, PLUGINS_DIR, type ScannedPlugin } from './registry'
import { storageDelete, storageGet, storageKeys, storagePurgePlugin, storageSet, validateKey } from './storage'

/**
 * Plugin API v0 routes (experimental `plugins`; only registered when the flag is on).
 *
 *  Admin (cookie session + is_admin):
 *    GET    /api/admin/plugins                 disk scan merged with approval state
 *    POST   /api/admin/plugins/:id/approve     {hash, permissions} → enable exactly that content
 *    POST   /api/admin/plugins/:id/disable
 *    DELETE /api/admin/plugins/:id             forget approval + delete all users' plugin storage
 *  User (cookie session; plugin must be active = approved, enabled, on-disk hash unchanged):
 *    GET    /api/plugins                       active plugins for the app shell
 *    GET    /api/plugins/:id/pages/:pageId     read:pages
 *    GET    /api/plugins/:id/search            read:pages   (?workspaceId=&q=)
 *    POST   /api/plugins/:id/pages/:pageId/content  write:pages ({markdown, mode})
 *    GET    /api/plugins/:id/storage           storage (list keys)
 *    GET|PUT|DELETE /api/plugins/:id/storage/:key   storage
 *  Frame assets (unauthenticated — loaded by opaque-origin iframes, which carry no cookies):
 *    GET    /api/plugin-sdk/v1.js
 *    GET    /api/plugin-frame/:id/:hash/index.html
 *    GET    /api/plugin-frame/:id/:hash/main.js
 *
 * The web app (parent window) proxies plugin RPCs and checks the approved permissions first; these
 * routes check them again, then delegate to the same visibility/membership guards the app uses
 * (findVisiblePage + requireMembership, or an inject into the existing route with the user's own
 * cookie), so a plugin can never see more than the signed-in user can.
 */

const HASH_RE = /^[0-9a-f]{64}$/
const UUID = z.uuid()

export type ActivePlugin = {
  manifest: PluginManifest
  hash: string
  entry: Buffer
  permissions: PluginPermission[]
}

type InstallRow = typeof pluginInstalls.$inferSelect

/** approved ∩ requested — a manifest edit can only ever shrink effective permissions. */
function effectivePermissions(manifest: PluginManifest, install: InstallRow): PluginPermission[] {
  const approved = new Set(install.approvedPermissions)
  return manifest.permissions.filter((p) => approved.has(p))
}

function isActive(scanned: ScannedPlugin, install: InstallRow | undefined): boolean {
  return !!(scanned.ok && install?.enabled && install.approvedHash === scanned.hash)
}

function pluginStatus(
  scanned: ScannedPlugin | undefined,
  install: InstallRow | undefined,
): 'invalid' | 'missing' | 'not-approved' | 'needs-reapproval' | 'enabled' | 'disabled' {
  if (!scanned) return 'missing'
  if (!scanned.ok) return 'invalid'
  if (!install || !install.approvedHash) return 'not-approved'
  if (install.approvedHash !== scanned.hash) return 'needs-reapproval'
  return install.enabled ? 'enabled' : 'disabled'
}

/** Resolve an active plugin by id or 404 (inactive and unknown plugins are indistinguishable). */
export async function getActivePlugin(id: string): Promise<ActivePlugin> {
  if (!PLUGIN_ID_RE.test(id)) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
  const scanned = (await getScannedPlugins()).find((p) => p.dirName === id)
  if (!scanned || !scanned.ok) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
  const [install] = await db.select().from(pluginInstalls).where(eq(pluginInstalls.id, id)).limit(1)
  if (!install || !isActive(scanned, install)) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
  return {
    manifest: scanned.manifest,
    hash: scanned.hash,
    entry: scanned.entry,
    permissions: effectivePermissions(scanned.manifest, install),
  }
}

/** Active plugin that holds `perm`, for the signed-in cookie user. */
async function requirePluginPermission(req: FastifyRequest, perm: PluginPermission): Promise<ActivePlugin> {
  // Plugins are a browser feature: never reachable through MCP bearer tokens.
  if (req.authVia !== 'cookie') throw forbidden('plugins are available to browser sessions only')
  const { id } = z.object({ id: z.string() }).parse(req.params)
  const plugin = await getActivePlugin(id)
  if (!plugin.permissions.includes(perm)) {
    throw new AppError(403, 'PLUGIN_PERMISSION', `plugin "${id}" does not have the "${perm}" permission`)
  }
  return plugin
}

/** Forward an internal request to an existing /api route as the same user (same cookie, same IP). */
async function injectAsUser(
  app: FastifyInstance,
  req: FastifyRequest,
  method: 'GET' | 'POST',
  url: string,
  json?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({
    method,
    url,
    headers: {
      cookie: req.headers.cookie ?? '',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: json !== undefined ? JSON.stringify(json) : undefined,
    remoteAddress: req.ip,
  })
  let body: unknown = null
  try {
    body = res.json()
  } catch {
    body = null
  }
  return { status: res.statusCode, body }
}

/** Re-throw an injected error response with its own status/code. */
function rethrow(r: { status: number; body: unknown }): never {
  const err = (r.body as { error?: { code?: string; message?: string } } | null)?.error
  throw new AppError(r.status, err?.code ?? 'UPSTREAM', err?.message ?? `request failed (${r.status})`)
}

const approveSchema = z.object({
  hash: z.string().regex(HASH_RE),
  permissions: z.array(z.string()).max(10),
})
const searchSchema = z.object({
  workspaceId: z.uuid(),
  q: z.string().trim().min(1).max(200),
})
const updateSchema = z.object({
  markdown: z.string().max(1_000_000),
  mode: z.enum(['replace', 'append']),
})
const storagePutSchema = z.object({ value: z.unknown() })

function setScriptHeaders(reply: FastifyReply, cache: string) {
  reply.header('Content-Type', 'text/javascript; charset=utf-8')
  reply.header('Content-Security-Policy', SCRIPT_RESPONSE_CSP)
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('Cache-Control', cache)
}

export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  const log = (msg: string) => app.log.info(msg)
  const admin = { preHandler: requireAdmin }
  const user = { preHandler: requireUser }
  // Per-IP caps on plugin RPC endpoints (the parent broker also rate-limits per plugin frame).
  const rpc = (max: number) => ({ preHandler: requireUser, config: { rateLimit: { max, timeWindow: '1 minute' } } })

  // ---------------------------------------------------------------- admin
  app.get('/admin/plugins', admin, async () => {
    const scanned = await getScannedPlugins(true)
    const rows = await db
      .select({ install: pluginInstalls, approvedByName: users.name })
      .from(pluginInstalls)
      .leftJoin(users, eq(users.id, pluginInstalls.approvedBy))
    const byId = new Map(rows.map((r) => [r.install.id, r]))
    const list = scanned.map((s) => {
      const row = byId.get(s.dirName)
      byId.delete(s.dirName)
      return {
        id: s.dirName,
        status: pluginStatus(s, row?.install),
        error: s.ok ? null : s.error,
        manifest: s.ok ? s.manifest : null,
        hash: s.ok ? s.hash : null,
        install: row
          ? {
              enabled: row.install.enabled,
              approvedVersion: row.install.approvedVersion,
              approvedPermissions: row.install.approvedPermissions,
              approvedHash: row.install.approvedHash,
              approvedAt: row.install.approvedAt?.toISOString() ?? null,
              approvedByName: row.approvedByName ?? null,
            }
          : null,
      }
    })
    // Approval rows whose directory is gone.
    for (const row of byId.values()) {
      list.push({
        id: row.install.id,
        status: 'missing',
        error: 'plugin directory not found',
        manifest: null,
        hash: null,
        install: {
          enabled: row.install.enabled,
          approvedVersion: row.install.approvedVersion,
          approvedPermissions: row.install.approvedPermissions,
          approvedHash: row.install.approvedHash,
          approvedAt: row.install.approvedAt?.toISOString() ?? null,
          approvedByName: row.approvedByName ?? null,
        },
      })
    }
    return { pluginsDir: PLUGINS_DIR, appVersion: APP_VERSION, plugins: list }
  })

  app.post('/admin/plugins/:id/approve', admin, async (req) => {
    const me = getUser(req)
    const { id } = z.object({ id: z.string().regex(PLUGIN_ID_RE) }).parse(req.params)
    const body = approveSchema.parse(req.body)
    const scanned = (await getScannedPlugins(true)).find((p) => p.dirName === id)
    if (!scanned) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
    if (!scanned.ok) throw new AppError(400, 'PLUGIN_INVALID', scanned.error)
    // The admin approves exactly the bytes they reviewed: a file changed since the list was loaded → 409.
    if (scanned.hash !== body.hash) {
      throw new AppError(409, 'PLUGIN_CHANGED', 'plugin files changed on disk since you loaded the list — reload and review again')
    }
    const requested = new Set<string>(scanned.manifest.permissions)
    const unknown = body.permissions.filter((p) => !requested.has(p))
    if (unknown.length) {
      throw new AppError(400, 'PLUGIN_PERMISSION', `permissions not requested by the manifest: ${unknown.join(', ')}`)
    }
    const granted = scanned.manifest.permissions.filter((p) => body.permissions.includes(p))
    const now = new Date()
    const values = {
      enabled: true,
      approvedVersion: scanned.manifest.version,
      approvedPermissions: granted,
      approvedHash: scanned.hash,
      approvedBy: me.id,
      approvedAt: now,
      updatedAt: now,
    }
    await db
      .insert(pluginInstalls)
      .values({ id, ...values })
      .onConflictDoUpdate({ target: pluginInstalls.id, set: values })
    log(`[plugins] ${me.email} approved ${id}@${scanned.manifest.version} perms=[${granted.join(',')}] hash=${scanned.hash.slice(0, 12)}`)
    return { ok: true, permissions: granted }
  })

  app.post('/admin/plugins/:id/disable', admin, async (req) => {
    const me = getUser(req)
    const { id } = z.object({ id: z.string().regex(PLUGIN_ID_RE) }).parse(req.params)
    const res = await db
      .update(pluginInstalls)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(pluginInstalls.id, id))
      .returning({ id: pluginInstalls.id })
    if (!res.length) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
    log(`[plugins] ${me.email} disabled ${id}`)
    return { ok: true }
  })

  app.delete('/admin/plugins/:id', admin, async (req) => {
    const me = getUser(req)
    const { id } = z.object({ id: z.string().regex(PLUGIN_ID_RE) }).parse(req.params)
    await db.delete(pluginInstalls).where(eq(pluginInstalls.id, id))
    await storagePurgePlugin(id)
    log(`[plugins] ${me.email} removed approval and data of ${id}`)
    return { ok: true }
  })

  // ---------------------------------------------------------------- user
  app.get('/plugins', user, async () => {
    const scanned = (await getScannedPlugins()).filter((s): s is Extract<ScannedPlugin, { ok: true }> => s.ok)
    if (!scanned.length) return { plugins: [] }
    const installs = await db
      .select()
      .from(pluginInstalls)
      .where(inArray(pluginInstalls.id, scanned.map((s) => s.dirName)))
    const byId = new Map(installs.map((i) => [i.id, i]))
    const plugins = scanned
      .filter((s) => isActive(s, byId.get(s.dirName)))
      .map((s) => {
        const install = byId.get(s.dirName)!
        const perms = effectivePermissions(s.manifest, install)
        return {
          id: s.manifest.id,
          name: s.manifest.name,
          version: s.manifest.version,
          description: s.manifest.description ?? null,
          permissions: perms,
          commands: perms.includes('commands') ? (s.manifest.commands ?? []) : [],
          blocks: perms.includes('blocks') ? (s.manifest.blocks ?? []) : [],
          frameUrl: `/api/plugin-frame/${s.manifest.id}/${s.hash}/index.html`,
        }
      })
    return { plugins }
  })

  app.get('/plugins/:id/pages/:pageId', rpc(120), async (req) => {
    await requirePluginPermission(req, 'read:pages')
    const me = getUser(req)
    const pageId = UUID.parse((req.params as { pageId?: string }).pageId)
    const page = await findVisiblePage(pageId, me.id)
    if (!page) throw notFound()
    await requireMembership(page.workspaceId, me.id)
    if (page.kind === 'canvas' || page.kind === 'folder') {
      throw new AppError(400, 'PLUGIN_UNSUPPORTED_PAGE', `pages.get does not support ${page.kind} pages`)
    }
    const { body } = await exportPageMd(page, me.id)
    return {
      page: {
        id: page.id,
        workspaceId: page.workspaceId,
        title: page.title,
        kind: page.kind,
        updatedAt: page.updatedAt.toISOString(),
        markdown: stripFrontmatter(body),
      },
    }
  })

  app.get('/plugins/:id/search', rpc(120), async (req) => {
    await requirePluginPermission(req, 'read:pages')
    const q = searchSchema.parse(req.query)
    const r = await injectAsUser(
      app,
      req,
      'GET',
      `/api/workspaces/${q.workspaceId}/search?q=${encodeURIComponent(q.q)}`,
    )
    if (r.status >= 400) rethrow(r)
    const pages = ((r.body as { pages?: Array<Record<string, unknown>> })?.pages ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      updatedAt: p.updatedAt,
      snippet: p.snippet ?? null,
    }))
    return { pages }
  })

  app.post('/plugins/:id/pages/:pageId/content', rpc(30), async (req) => {
    await requirePluginPermission(req, 'write:pages')
    const pageId = UUID.parse((req.params as { pageId?: string }).pageId)
    const body = updateSchema.parse(req.body)
    const r = await injectAsUser(app, req, 'POST', `/api/pages/${pageId}/content`, body)
    if (r.status >= 400) rethrow(r)
    return { ok: true }
  })

  app.get('/plugins/:id/storage', rpc(300), async (req) => {
    const plugin = await requirePluginPermission(req, 'storage')
    return { keys: await storageKeys(plugin.manifest.id, getUser(req).id) }
  })

  app.get('/plugins/:id/storage/:key', rpc(300), async (req) => {
    const plugin = await requirePluginPermission(req, 'storage')
    const key = validateKey(String((req.params as { key?: string }).key ?? ''))
    return { value: await storageGet(plugin.manifest.id, getUser(req).id, key) }
  })

  app.put(
    '/plugins/:id/storage/:key',
    { ...rpc(120), bodyLimit: 128 * 1024 },
    async (req) => {
      const plugin = await requirePluginPermission(req, 'storage')
      const key = validateKey(String((req.params as { key?: string }).key ?? ''))
      const { value } = storagePutSchema.parse(req.body ?? {})
      await storageSet(plugin.manifest.id, getUser(req).id, key, value)
      return { ok: true }
    },
  )

  app.delete('/plugins/:id/storage/:key', rpc(120), async (req) => {
    const plugin = await requirePluginPermission(req, 'storage')
    const key = validateKey(String((req.params as { key?: string }).key ?? ''))
    await storageDelete(plugin.manifest.id, getUser(req).id, key)
    return { ok: true }
  })

  // ---------------------------------------------------------------- frame assets
  app.get(SDK_PATH.replace(/^\/api/, ''), async (_req, reply) => {
    setScriptHeaders(reply, 'public, max-age=3600')
    return reply.send(SDK_SOURCE)
  })

  const assetParams = z.object({ id: z.string().regex(PLUGIN_ID_RE), hash: z.string().regex(HASH_RE) })

  /** Active plugin whose approved hash is exactly the one in the URL, else 404. */
  const assetPlugin = async (params: unknown): Promise<ActivePlugin> => {
    const parsed = assetParams.safeParse(params)
    if (!parsed.success) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
    const plugin = await getActivePlugin(parsed.data.id)
    if (plugin.hash !== parsed.data.hash) throw notFound('PLUGIN_NOT_FOUND', 'plugin not found')
    return plugin
  }

  app.get('/plugin-frame/:id/:hash/index.html', async (req, reply) => {
    const plugin = await assetPlugin(req.params)
    const nonce = newNonce()
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.header('Content-Security-Policy', frameCsp(nonce))
    for (const [k, v] of Object.entries(FRAME_SECURITY_HEADERS)) reply.header(k, v)
    reply.header('Cache-Control', 'no-store')
    return reply.send(frameHtml(plugin.manifest.id, plugin.hash, nonce))
  })

  app.get('/plugin-frame/:id/:hash/main.js', async (req, reply) => {
    const plugin = await assetPlugin(req.params)
    // The hash is in the URL, so the bytes behind this URL can never change.
    setScriptHeaders(reply, 'public, max-age=31536000, immutable')
    return reply.send(plugin.entry)
  })
}
