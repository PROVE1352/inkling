/**
 * Facts for the admin status summary (docs/adr/1230-*).
 *
 * Two kinds:
 *  - heavy probes (disk statfs, database size, upload total, large-page count, stored-secret count,
 *    applied migrations): cached for HEAVY_TTL_MS with one in-flight computation, so a burst of
 *    admin page loads costs one round of queries;
 *  - live facts (sidecar status.json, process counters, env flags): read on every request — they
 *    cost microseconds and a just-finished backup must not look stale for five minutes.
 *
 * The only outbound request is the opt-in release check (version.ts, UPDATE_CHECK=github).
 */
import { readFile, stat, statfs } from 'node:fs/promises'
import { agentUploadEnv } from '../agentUploads'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { BACKUP_DIR, currentAlert, isConfigured, isStale, readStatus } from '../backup/store'
import { LARGE_PAGE_STATE_BYTES, LARGE_PAGE_TOKENS, stateBytesV1Sql, V2_TO_V1_BYTES } from '../context/largePage'
import { db } from '../db/index'
import { env, updateEnv } from '../env'
import { countSecretsAtRest } from '../secretsAtRest'
import { isNewerRelease, releaseCheck, SERVER_VERSION } from '../version'
import { dbPasswordWeakness, type DiskFact, type StatusFacts } from './evaluate'
import { errorStats, restartStats } from './runtime'

export const HEAVY_TTL_MS = 5 * 60 * 1000

export interface HeavyFacts {
  disks: StatusFacts['disks']
  dbBytes: number | null
  uploads: StatusFacts['uploads']
  largePages: number | null
  plaintextSecrets: number | null
  sealedSecrets: number | null
  migrations: StatusFacts['migrations']
}

type Rows<T> = T[]
const q = async <T>(query: ReturnType<typeof sql>): Promise<Rows<T>> => (await db.execute(query)) as unknown as T[]

/** Run a probe; a failing probe yields null (shown as `off`), never a 500. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

async function disk(dir: string): Promise<(DiskFact & { dev: number }) | null> {
  const [fs, st] = await Promise.all([statfs(dir), stat(dir)])
  return { freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize), dev: st.dev }
}

async function largePageCount(): Promise<number> {
  // Same thresholds and column-only reads as the workspace list (routes/largePages.ts, ADR 1103);
  // every workspace, live pages only, count only (no titles leave this query).
  const minStored = Math.floor(LARGE_PAGE_STATE_BYTES / V2_TO_V1_BYTES)
  const [r] = await q<{ n: number }>(sql`
    WITH tok AS (
      SELECT c.page_id, sum(c.token_estimate)::bigint AS tokens FROM page_chunks c GROUP BY c.page_id
      HAVING sum(c.token_estimate) >= ${LARGE_PAGE_TOKENS}
    )
    SELECT count(*)::int AS n
      FROM pages
      LEFT JOIN page_docs d ON d.page_id = pages.id
      LEFT JOIN tok ON tok.page_id = pages.id
     WHERE pages.kind = 'doc' AND pages.deleted_at IS NULL
       AND ((octet_length(d.state) >= ${minStored} AND ${stateBytesV1Sql()} >= ${LARGE_PAGE_STATE_BYTES}) OR tok.page_id IS NOT NULL)
  `)
  return Number(r?.n ?? 0)
}

async function migrationState(): Promise<StatusFacts['migrations']> {
  let expected: number | null = null
  let latest: string | null = null
  try {
    const journal = JSON.parse(await readFile(path.join(env.drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries?: { tag: string }[]
    }
    if (journal.entries?.length) {
      expected = journal.entries.length
      latest = journal.entries[journal.entries.length - 1].tag
    }
  } catch {
    // no journal next to the server (unusual layout) → "unknown"
  }
  const [r] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)
  return { applied: Number(r?.n ?? 0), expected, latest }
}

export async function computeHeavyFacts(): Promise<HeavyFacts> {
  const backupsOn = await isConfigured()
  const [dataDisk, backupDisk, dbBytes, uploads, largePages, secrets, migrations] = await Promise.all([
    safe(() => disk(env.dataDir)),
    backupsOn ? safe(() => disk(BACKUP_DIR)) : Promise.resolve(null),
    safe(async () => Number((await q<{ b: string }>(sql`SELECT pg_database_size(current_database())::bigint AS b`))[0]?.b ?? 0)),
    safe(async () => {
      const [r] = await q<{ b: string; n: number }>(sql`SELECT coalesce(sum(size), 0)::bigint AS b, count(*)::int AS n FROM files`)
      return { bytes: Number(r?.b ?? 0), files: Number(r?.n ?? 0) }
    }),
    safe(largePageCount),
    safe(countSecretsAtRest),
    safe(migrationState),
  ])
  const strip = (d: (DiskFact & { dev: number }) | null): DiskFact | null =>
    d ? { freeBytes: d.freeBytes, totalBytes: d.totalBytes } : null
  return {
    disks: {
      data: strip(dataDisk),
      backups: strip(backupDisk),
      sameDisk: !!(dataDisk && backupDisk && dataDisk.dev === backupDisk.dev),
    },
    dbBytes,
    uploads,
    largePages,
    plaintextSecrets: secrets?.plaintext ?? null,
    sealedSecrets: secrets?.sealed ?? null,
    migrations,
  }
}

let heavy: { at: number; facts: HeavyFacts } | null = null
let heavyInflight: Promise<HeavyFacts> | null = null

/** Heavy facts from the cache, or computed (once, even with concurrent callers). */
export async function heavyFacts(opts: { refresh?: boolean; now?: number } = {}): Promise<{ facts: HeavyFacts; at: number; hit: boolean }> {
  const now = opts.now ?? Date.now()
  if (!opts.refresh && heavy && now - heavy.at < HEAVY_TTL_MS) return { facts: heavy.facts, at: heavy.at, hit: true }
  if (!heavyInflight) {
    heavyInflight = computeHeavyFacts()
      .then((facts) => {
        heavy = { at: Date.now(), facts }
        return facts
      })
      .finally(() => {
        heavyInflight = null
      })
  }
  const facts = await heavyInflight
  return { facts, at: heavy?.at ?? Date.now(), hit: false }
}

/** Tests only. */
export function _resetStatusCache(): void {
  heavy = null
}

// ---------------------------------------------------------------------------
// Environment facts (never values)
// ---------------------------------------------------------------------------

export function securityEnvFacts(): Omit<StatusFacts['security'], 'plaintextSecrets' | 'sealedSecrets'> {
  const origin = env.publicUrl ?? env.appUrl
  return {
    secretKey: !!env.appSecretKey,
    publicUrl: !!origin,
    publicUrlHttps: !!origin && /^https:\/\//i.test(origin),
    cookieSecure: env.cookieSecure,
    signupRequiresKey: env.signupRequireKey,
    delegated: !!env.delegatedAuthUrl,
    oidcEnabled: !!(env.oidc.issuer && env.oidc.clientId && env.oidc.clientSecret),
    oidcOpenAutoCreate:
      !!(env.oidc.issuer && env.oidc.clientId && env.oidc.clientSecret) && env.oidc.autoCreate && env.oidc.allowedDomains.length === 0,
    dbPasswordWeak: dbPasswordWeakness(env.databaseUrl),
    agentUploads: {
      mode: agentUploadEnv.mode,
      maxBytes: agentUploadEnv.maxBytes,
      dailyBytes: agentUploadEnv.dailyBytes,
      mcpBodyBytes: agentUploadEnv.mcpUploadBodyBytes,
      warnings: agentUploadEnv.warnings.length,
    },
  }
}

/** All facts: heavy (cached) + live. */
export async function gatherFacts(opts: { refresh?: boolean } = {}): Promise<{ facts: StatusFacts; cache: { hit: boolean; at: number } }> {
  const now = Date.now()
  const [h, configured, status, rel] = await Promise.all([
    heavyFacts({ refresh: opts.refresh }),
    isConfigured(),
    readStatus().catch(() => null),
    updateEnv.check === 'github' ? releaseCheck() : Promise.resolve({ latest: null, securityFix: null }),
  ])
  const st = configured ? status : null
  const facts: StatusFacts = {
    now,
    isProd: env.isProd,
    backup: {
      configured,
      status: st,
      alert: st ? currentAlert(st, now) : null,
      stale: st ? isStale(st, now) : false,
    },
    disks: h.facts.disks,
    dbBytes: h.facts.dbBytes,
    uploads: h.facts.uploads,
    largePages: h.facts.largePages,
    uptimeSec: process.uptime(),
    version: SERVER_VERSION,
    restarts: restartStats(now),
    errors: errorStats(now),
    migrations: h.facts.migrations,
    security: { ...securityEnvFacts(), plaintextSecrets: h.facts.plaintextSecrets, sealedSecrets: h.facts.sealedSecrets },
    update: {
      enabled: updateEnv.check === 'github',
      current: SERVER_VERSION,
      latest: rel.latest,
      updateAvailable: isNewerRelease(rel.latest?.version ?? null, SERVER_VERSION),
      securityFix: rel.securityFix,
    },
  }
  return { facts, cache: { hit: h.hit, at: h.at } }
}
