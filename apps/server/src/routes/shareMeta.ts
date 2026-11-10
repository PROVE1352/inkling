/**
 * Link unfurl for public share pages.
 *
 * The SPA shell (index.html) is static, so crawlers (Slack, Discord, iMessage, X, …) that do
 * not run JavaScript would only see "Inkling". For `/s/:token` and `/s/:token/p/:ref` the server
 * serves the same shell with Open Graph / Twitter meta tags injected before `</head>`.
 *
 * Privacy: metadata is produced only for live pages that are publicly shared AND scope='shared'
 * (findSharedPageByToken / loadFolderShare already exclude private pages and private subtrees).
 * Anything else gets the untouched shell — the SPA then renders its normal 404.
 * Invalid tokens are deliberately NOT counted as brute-force failures here: the SPA's own API
 * call already counts them, and link-preview bots must not get an IP banned.
 *
 * Expired links and links with a password (docs/adr/1170-*, 1171-*) get the shell with only
 * `<meta name="robots" content="noindex, nofollow">` and the same X-Robots-Tag header: no title,
 * description, image or URL, whoever asks (an unlock cookie is scoped to /api/public/<token> and
 * never reaches /s/, so a visitor's unlock cannot turn the meta back on).
 *
 * Only active when WEB_DIST is set (production). See docs/adr/0503-share-page-unfurl-meta.md.
 */
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/index'
import { pageTexts } from '../db/schema'
import { env } from '../env'
import { configuredPublicOrigin } from '../origin'
import { parseFileUrl } from '../md/convert'
import { shareGated, shareNotStarted } from '../shareAccess'
import { buildFolderShare, findSharedPageByToken } from './public'
import type { SharedPage } from './public'

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/
const REF_RE = /^[A-Za-z0-9_-]{22}$/
const DESC_MAX = 200
const SITE_NAME = 'Inkling'
const UNTITLED = 'Untitled'

const RATE_LIMIT = {
  // Non-API GETs are on the global limiter's allowList; this route does a DB lookup, so meter it.
  rateLimit: { max: 120, timeWindow: '1 minute', allowList: () => false },
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…'
}

export interface UnfurlMeta {
  title: string
  description: string | null
  url: string | null
  image: string | null
}

/** Build the tag block injected into <head>. Every value is HTML-escaped. */
export function renderMetaTags(m: UnfurlMeta): string {
  const tags: [string, string, string][] = [
    ['property', 'og:type', 'article'],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:title', m.title],
    ['name', 'twitter:card', m.image ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', m.title],
  ]
  if (m.description) {
    tags.push(['property', 'og:description', m.description])
    tags.push(['name', 'twitter:description', m.description])
    tags.push(['name', 'description', m.description])
  }
  if (m.url) tags.push(['property', 'og:url', m.url])
  if (m.image) {
    tags.push(['property', 'og:image', m.image])
    tags.push(['name', 'twitter:image', m.image])
  }
  return tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${escapeHtml(v)}" />`).join('\n    ')
}

/** Shell for a gated link: keep it out of search engines, say nothing about the page. */
export function injectNoindex(shell: string): string {
  const idx = shell.indexOf('</head>')
  if (idx < 0) return shell
  return shell.slice(0, idx) + '    <meta name="robots" content="noindex, nofollow" />\n  ' + shell.slice(idx)
}

/** Inject meta + replace <title> in the shell. Pure string ops on a trusted template. */
export function injectMeta(shell: string, m: UnfurlMeta): string {
  const title = `<title>${escapeHtml(m.title)}</title>`
  let out = /<title>[^<]*<\/title>/.test(shell) ? shell.replace(/<title>[^<]*<\/title>/, () => title) : shell
  const idx = out.indexOf('</head>')
  if (idx < 0) return out
  out = out.slice(0, idx) + '    ' + renderMetaTags(m) + '\n  ' + out.slice(idx)
  return out
}

function siteOrigin(req: FastifyRequest): string | null {
  // Configured origin only (origin.ts, C-M1); the dev fallback warns once.
  return configuredPublicOrigin(req) || null
}

async function describe(page: SharedPage, childCount?: number): Promise<string | null> {
  if (page.kind === 'folder') {
    return childCount !== undefined ? `Shared folder · ${childCount} page${childCount === 1 ? '' : 's'}` : 'Shared folder'
  }
  if (page.kind !== 'doc') return null
  const row = (
    await db.select({ text: pageTexts.text }).from(pageTexts).where(eq(pageTexts.pageId, page.id)).limit(1)
  )[0]
  if (!row?.text) return null
  // Only the head of the indexed text is needed; avoid scanning the whole 200 KB body.
  const d = excerpt(row.text.slice(0, DESC_MAX * 4), DESC_MAX)
  return d || null
}

function imageFor(page: SharedPage, origin: string | null, fileBase: string): string | null {
  const cover = page.coverUrl
  if (!cover) return null
  const fid = parseFileUrl(cover)
  if (fid) return origin ? `${origin}${fileBase}/f/${fid}` : null
  return /^https:\/\//i.test(cover) && cover.length <= 2048 ? cover : null
}

export async function registerShareMetaRoutes(app: FastifyInstance): Promise<void> {
  if (!env.webDist) return
  const indexPath = path.join(env.webDist, 'index.html')
  let cached: { mtimeMs: number; html: string } | null = null

  async function shell(): Promise<string> {
    const st = await stat(indexPath)
    if (!cached || cached.mtimeMs !== st.mtimeMs) {
      cached = { mtimeMs: st.mtimeMs, html: await readFile(indexPath, 'utf8') }
    }
    return cached.html
  }

  function send(reply: FastifyReply, html: string) {
    reply.header('Content-Type', 'text/html; charset=utf-8')
    reply.header('Cache-Control', 'no-store')
    return reply.send(html)
  }

  async function handle(req: FastifyRequest, reply: FastifyReply) {
    const { token, ref } = req.params as { token?: string; ref?: string }
    const base = await shell()
    if (!token || !TOKEN_RE.test(token) || (ref !== undefined && !REF_RE.test(ref))) return send(reply, base)

    const origin = siteOrigin(req)
    try {
      let target: SharedPage | null = null
      let fileBase = `/api/public/${token}`
      let childCount: number | undefined
      // The gate is the root's: a folder's expiry and password cover every page below it.
      const root = await findSharedPageByToken(token)
      // A scheduled link before its start is the plain shell, like a token that is not shared (docs/adr/1844-*).
      if (!root || shareNotStarted(root.gate)) return send(reply, base)
      if (shareGated(root.gate)) {
        reply.header('X-Robots-Tag', 'noindex, nofollow')
        return send(reply, injectNoindex(base))
      }
      if (ref === undefined) {
        target = root
        if (root.kind === 'folder') childCount = (await buildFolderShare(root, token)).pages.length
      } else {
        const share = root.kind === 'folder' ? await buildFolderShare(root, token) : null
        target = share?.byRef.get(ref) ?? null
        fileBase = `/api/public/${token}/p/${ref}`
      }
      if (!target || target.scope !== 'shared') return send(reply, base)

      const pathOnly = ref === undefined ? `/s/${token}` : `/s/${token}/p/${ref}`
      const meta: UnfurlMeta = {
        title: target.title.trim() || UNTITLED,
        description: await describe(target, childCount),
        url: origin ? origin + pathOnly : null,
        image: imageFor(target, origin, fileBase),
      }
      return send(reply, injectMeta(base, meta))
    } catch (err) {
      req.log.warn({ err }, 'share meta injection failed')
      return send(reply, base)
    }
  }

  app.get('/s/:token', { config: RATE_LIMIT }, handle)
  app.get('/s/:token/p/:ref', { config: RATE_LIMIT }, handle)
}
