import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import pkg from '../package.json' with { type: 'json' }
import { requireAdmin } from './auth'
import { env, updateEnv } from './env'
import { compareSemver } from './plugins/manifest'
import { safeFetch } from './safeFetch'

// Build/version exposure and the optional release check
// (docs/adr/0990-build-id-and-version-header.md, 0991-*, 0994-*, 1232-*).
//
// The web build writes dist/build.json ({ build }) next to index.html (apps/web/vite.config.ts).
// The server reads it from WEB_DIST once at boot, so the id it advertises is, by construction,
// the id of the bundle it serves — no git, build-arg or env needed for the two to agree.
// Every /api response carries it as X-Inkling-Build; a tab compares it with the id compiled into
// its own bundle and switches to "update available" when they differ (apps/web/src/lib/update.ts).

/** Allowed build id characters: what vite.config.ts produces (hex / commit hash / tag-like). */
export function sanitizeBuild(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/[^\w.-]/g, '').slice(0, 40)
  return s || null
}

/**
 * Build id of the served web bundle: WEB_DIST/build.json first (the truth for what this process
 * serves), then INKLING_BUILD, else null (dev / unknown → no header, clients never compare).
 */
export function readBuildId(webDist: string | undefined, override: string | null): string | null {
  if (webDist) {
    try {
      const raw = JSON.parse(readFileSync(path.join(webDist, 'build.json'), 'utf8')) as { build?: unknown }
      const id = sanitizeBuild(raw?.build)
      if (id) return id
    } catch {
      // no build.json (older build, or web served elsewhere) — fall through
    }
  }
  return sanitizeBuild(override)
}

export const BUILD_ID = readBuildId(env.webDist, updateEnv.buildOverride)
export const SERVER_VERSION = process.env.APP_VERSION?.trim() || pkg.version

// ---------------------------------------------------------------------------
// Optional GitHub release check (UPDATE_CHECK=github)
// ---------------------------------------------------------------------------

export type LatestRelease = { version: string; url: string }

const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/
const DAY_MS = 24 * 60 * 60 * 1000
/** A failed check is retried after an hour, not on every admin page view. */
const RETRY_MS = 60 * 60 * 1000

/** `v1.2.3` / `1.2.3` → `1.2.3`; anything that is not x.y.z(-pre) → null. */
export function normalizeVersion(tag: unknown): string | null {
  if (typeof tag !== 'string') return null
  const s = tag.trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(s) ? s : null
}

/** GitHub `releases/latest` body → { version, url } (url only when it is a github.com link). */
export function parseRelease(body: unknown): LatestRelease | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }
  if (b.draft === true || b.prerelease === true) return null
  const version = normalizeVersion(b.tag_name)
  if (!version) return null
  const url = typeof b.html_url === 'string' && /^https:\/\/github\.com\//.test(b.html_url) ? b.html_url : ''
  return { version, url }
}

/** Whether `latest` is a newer release than `current` (both x.y.z; unknown → false). */
export function isNewerRelease(latest: string | null, current: string): boolean {
  const l = normalizeVersion(latest)
  const c = normalizeVersion(current)
  if (!l || !c) return false
  return compareSemver(l, c) > 0
}

/** What one release check found (docs/adr/1232-*). */
export interface ReleaseCheck {
  latest: LatestRelease | null
  /**
   * Whether a release newer than this server has a "Security" section in its notes: true / false,
   * or null when no newer release has notes to read (the release body is empty).
   */
  securityFix: boolean | null
}

/** A "## Security" / "### Security" heading (Keep a Changelog) or the Korean "보안" in release notes. */
const SECURITY_HEADING_RE = /^#{2,4}\s*(?:Security\b|보안)/im

/**
 * GitHub `releases?per_page=N` body → the newest stable release by semver, and whether any release
 * newer than `current` carries a Security section. Drafts and pre-releases are ignored.
 */
export function parseReleaseList(body: unknown, current: string): ReleaseCheck {
  if (!Array.isArray(body)) return { latest: null, securityFix: null }
  let latest: LatestRelease | null = null
  let securityFix: boolean | null = null
  for (const item of body) {
    const r = parseRelease(item)
    if (!r) continue
    if (!latest || compareSemver(r.version, latest.version) > 0) latest = r
    if (!isNewerRelease(r.version, current)) continue
    const notes = (item as { body?: unknown }).body
    if (typeof notes !== 'string' || !notes.trim()) continue
    if (SECURITY_HEADING_RE.test(notes)) securityFix = true
    else if (securityFix === null) securityFix = false
  }
  return { latest, securityFix }
}

let cached: { at: number; ttl: number; check: ReleaseCheck } | null = null
let inflight: Promise<ReleaseCheck> | null = null
const NO_CHECK: ReleaseCheck = { latest: null, securityFix: null }

async function fetchReleases(repo: string): Promise<ReleaseCheck> {
  if (!REPO_RE.test(repo)) return NO_CHECK
  // Only the public repository name goes out. Generic User-Agent (GitHub requires one): no host
  // name, instance URL, user, email or version is sent. One request lists the recent releases, so
  // a security fix in a release between this one and the newest is seen too (docs/adr/1232-*).
  const res = await safeFetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: { 'User-Agent': 'inkling-update-check', Accept: 'application/vnd.github+json' },
    allowedHosts: ['api.github.com'],
    maxRedirects: 0,
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    truncate: false,
    allowedContentTypes: ['application/json'],
  })
  if (res.status !== 200) return NO_CHECK
  return parseReleaseList(JSON.parse(res.body.toString('utf8')), SERVER_VERSION)
}

/** Release check, cached for a day (an hour after a failure). Failures resolve to "nothing found". */
export async function releaseCheck(now = Date.now()): Promise<ReleaseCheck> {
  if (updateEnv.check !== 'github') return NO_CHECK
  if (cached && now - cached.at < cached.ttl) return cached.check
  if (!inflight) {
    inflight = fetchReleases(updateEnv.checkRepo)
      .catch(() => NO_CHECK)
      .then((check) => {
        cached = { at: Date.now(), ttl: check.latest ? DAY_MS : RETRY_MS, check }
        inflight = null
        return check
      })
  }
  return inflight
}

/** Latest release, cached for a day (an hour after a failure). Failures resolve to null. */
export async function latestRelease(now = Date.now()): Promise<LatestRelease | null> {
  return (await releaseCheck(now)).latest
}

/**
 * Registered inside the /api plugin (index.ts): the X-Inkling-Build header on every /api
 * response (set in onRequest so errors, 304s and 429s carry it too), GET /api/version, and the
 * admin-only GET /api/version/latest.
 */
export function registerVersionRoutes(api: FastifyInstance): void {
  if (BUILD_ID) {
    const build = BUILD_ID
    api.addHook('onRequest', async (_req, reply) => {
      reply.header('X-Inkling-Build', build)
    })
  }
  api.get('/version', { logLevel: 'silent' }, async () => ({
    build: BUILD_ID,
    version: SERVER_VERSION,
    updateMode: updateEnv.mode,
  }))
  api.get('/version/latest', { preHandler: requireAdmin }, async () => {
    if (updateEnv.check !== 'github') return { enabled: false, current: SERVER_VERSION, latest: null, updateAvailable: false, securityFix: false }
    const { latest, securityFix } = await releaseCheck()
    const updateAvailable = isNewerRelease(latest?.version ?? null, SERVER_VERSION)
    return {
      enabled: true,
      current: SERVER_VERSION,
      latest,
      updateAvailable,
      securityFix: updateAvailable ? securityFix : false,
    }
  })
}
