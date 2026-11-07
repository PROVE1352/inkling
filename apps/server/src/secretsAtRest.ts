import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from './db/index'
import { openSecret, sealSecret, secretBoxAvailable } from './secretBox'

/**
 * Secrets at rest other than sessions and TOTP (docs/adr/1110-*, 1111-*).
 *
 * Lookup secrets (share tokens, invite codes, signup keys) are found by their SHA-256 only: the
 * lookup column keeps its name and holds 64 lowercase hex characters, like `sessions.token`
 * (docs/adr/1060-*). None of the raw forms can be 64 hex characters (share tokens are 22 base64url
 * characters, invite codes 10 and signup keys 19 characters of an upper-case alphabet), so the two
 * forms never collide and the boot pass below can tell what still needs converting.
 *
 * Values the app must show or use again (the "copy link" copy of a lookup secret, webhook and sheet
 * URLs) are stored "protected": sealed with APP_SECRET_KEY (secretBox.ts, `v1.<iv>.<tag>.<ct>`) when
 * the key is set, otherwise as they are. None of the raw forms contains a '.', or starts with `v1.`
 * (URLs start with a scheme), so `isSealed` is unambiguous.
 */

export const HASH_RE = /^[0-9a-f]{64}$/
const SEALED_PREFIX = 'v1.'

export type SecretPurpose = 'share-token' | 'invite-code' | 'signup-key' | 'webhook-url' | 'sheet-sync-url'

function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Invite codes and signup keys are typed by people: compare them trimmed and upper case. */
export function canonicalCode(v: string): string {
  return v.trim().toUpperCase()
}

/** Share tokens are case-sensitive base64url: hashed exactly as presented. */
export const hashShareToken = (token: string): string => sha256hex(token)
export const hashInviteCode = (code: string): string => sha256hex(canonicalCode(code))
export const hashSignupKey = (key: string): string => sha256hex(canonicalCode(key))
/** Last four characters of a signup key, shown once the key itself is no longer stored. */
export const signupKeyHint = (key: string): string => canonicalCode(key).slice(-4)

export function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX)
}

/** Stored form of a value that must be readable again: sealed when APP_SECRET_KEY is set, else as is. */
export function protectSecret(purpose: SecretPurpose, raw: string, aad: string): string {
  return secretBoxAvailable() ? sealSecret(purpose, Buffer.from(raw, 'utf8'), aad) : raw
}

/** A sealed value could not be opened: APP_SECRET_KEY is unset, was changed, or the row was tampered with. */
export class SecretUnreadableError extends Error {
  constructor(purpose: SecretPurpose) {
    super(`stored ${purpose} cannot be decrypted (APP_SECRET_KEY missing or changed)`)
    this.name = 'SecretUnreadableError'
  }
}

/** Stored form → raw value. Plaintext passes through; a sealed value that cannot be opened throws. */
export function revealSecret(purpose: SecretPurpose, stored: string, aad: string): string {
  if (!isSealed(stored)) return stored
  if (!secretBoxAvailable()) throw new SecretUnreadableError(purpose)
  try {
    return openSecret(purpose, stored, aad).toString('utf8')
  } catch {
    throw new SecretUnreadableError(purpose)
  }
}

/** revealSecret for display paths: null when there is no copy or it cannot be opened. */
export function tryRevealSecret(purpose: SecretPurpose, stored: string | null | undefined, aad: string): string | null {
  if (!stored) return null
  try {
    return revealSecret(purpose, stored, aad)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Boot-time data pass
// ---------------------------------------------------------------------------

export interface SecretsAtRestReport {
  /** Lookup values (share tokens, invite codes, signup keys, users.signup_key) hashed in this pass. */
  hashed: number
  /** Copies and URLs sealed in this pass (APP_SECRET_KEY set). */
  sealed: number
  /** Copies and URLs left in plaintext because APP_SECRET_KEY is unset. */
  plaintext: number
  /** Sealed values present while APP_SECRET_KEY is unset: they cannot be shown or used. */
  unreadable: number
}

type Row = Record<string, string | number | null>

async function rows<T extends Row>(q: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(q)) as unknown as T[]
}

/** The by-hand selection predicates (also quoted in the operator notes). */
export const NOT_HASHED = `!~ '^[0-9a-f]{64}$'`
export const NOT_SEALED = `NOT LIKE 'v1.%'`

/**
 * Convert every lookup secret still stored in plaintext to its hash (keeping a protected copy for
 * "copy link"), and seal every stored copy / URL that is still plaintext when APP_SECRET_KEY is set.
 * Runs after the schema migrations and before the server listens. Idempotent: each step selects
 * only rows that still need it, and each UPDATE is guarded by the old value. Hashing happens in
 * Node with the same functions the lookups use, so normalisation cannot drift from SQL's.
 */
export async function migrateSecretsAtRest(opts: { workspaceIds?: string[] } = {}): Promise<SecretsAtRestReport> {
  const report: SecretsAtRestReport = { hashed: 0, sealed: 0, plaintext: 0, unreadable: 0 }
  const keyed = secretBoxAvailable()
  // Tests limit the workspace-owned rows to their own workspaces (other suites share the database).
  const ids = opts.workspaceIds?.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const scope = (col: string) => (ids ? ` AND ${col}::text IN (${ids.map((id) => `'${id}'`).join(',') || 'NULL'})` : '')

  // 1) Share tokens → hash + copy.
  for (const r of await rows<{ id: string; t: string }>(
    sql.raw(`SELECT id, share_token AS t FROM pages WHERE share_token IS NOT NULL AND share_token ${NOT_HASHED}${scope('workspace_id')}`),
  )) {
    const res = await rows(sql`
      UPDATE pages SET share_token = ${hashShareToken(r.t)}, share_token_enc = ${protectSecret('share-token', r.t, r.id)}
       WHERE id = ${r.id} AND share_token = ${r.t} RETURNING 1`)
    report.hashed += res.length
  }

  // 2) Invite codes → hash + copy.
  for (const r of await rows<{ id: string; c: string }>(
    sql.raw(`SELECT id, invite_code AS c FROM workspaces WHERE invite_code ${NOT_HASHED}${scope('id')}`),
  )) {
    const res = await rows(sql`
      UPDATE workspaces SET invite_code = ${hashInviteCode(r.c)}, invite_code_enc = ${protectSecret('invite-code', r.c, r.id)}
       WHERE id = ${r.id} AND invite_code = ${r.c} RETURNING 1`)
    report.hashed += res.length
  }

  // 3) Signup keys and the accounts that used them, in one transaction per key so the
  //    users.signup_key → signup_keys.key join never points at a missing row. A used-up key keeps
  //    no copy: a used single-use key is its person's recovery code (docs/adr/0101-*).
  for (const r of await rows<{ k: string; used: number; max: number }>(
    sql.raw(`SELECT key AS k, used_count AS used, max_uses AS max FROM signup_keys WHERE key ${NOT_HASHED}`),
  )) {
    const h = hashSignupKey(r.k)
    const copy = Number(r.used) >= Number(r.max) ? null : protectSecret('signup-key', canonicalCode(r.k), h)
    await db.transaction(async (tx) => {
      const res = (await tx.execute(sql`
        UPDATE signup_keys SET key = ${h}, key_enc = ${copy}, key_hint = ${signupKeyHint(r.k)}
         WHERE key = ${r.k} RETURNING 1`)) as unknown as unknown[]
      await tx.execute(sql`UPDATE users SET signup_key = ${h} WHERE signup_key = ${r.k}`)
      report.hashed += res.length
    })
  }
  //    Accounts whose key was revoked (row deleted) still carry it: hash those too.
  for (const r of await rows<{ id: string; k: string }>(
    sql.raw(`SELECT id, signup_key AS k FROM users WHERE signup_key IS NOT NULL AND signup_key ${NOT_HASHED}`),
  )) {
    const res = await rows(sql`
      UPDATE users SET signup_key = ${hashSignupKey(r.k)} WHERE id = ${r.id} AND signup_key = ${r.k} RETURNING 1`)
    report.hashed += res.length
  }

  // 4) Copies and URLs: seal what is still plaintext (key set), or count it (no key).
  const targets: { table: string; col: string; aad: string; purpose: SecretPurpose; pk: string; ws: string | null }[] = [
    { table: 'pages', col: 'share_token_enc', aad: 'id', purpose: 'share-token', pk: 'id', ws: 'workspace_id' },
    { table: 'workspaces', col: 'invite_code_enc', aad: 'id', purpose: 'invite-code', pk: 'id', ws: 'id' },
    { table: 'signup_keys', col: 'key_enc', aad: 'key', purpose: 'signup-key', pk: 'key', ws: null },
    { table: 'workspace_webhooks', col: 'url', aad: 'id', purpose: 'webhook-url', pk: 'id', ws: 'workspace_id' },
    { table: 'collection_sheet_syncs', col: 'url', aad: 'page_id', purpose: 'sheet-sync-url', pk: 'page_id', ws: 'workspace_id' },
  ]
  for (const t of targets) {
    if (!keyed) {
      const [c] = await rows<{ plain: number; sealed: number }>(
        sql.raw(`SELECT count(*) FILTER (WHERE ${t.col} ${NOT_SEALED})::int AS plain,
                        count(*) FILTER (WHERE ${t.col} LIKE 'v1.%')::int AS sealed
                   FROM ${t.table} WHERE ${t.col} IS NOT NULL${t.ws ? scope(t.ws) : ''}`),
      )
      report.plaintext += Number(c?.plain ?? 0)
      report.unreadable += Number(c?.sealed ?? 0)
      continue
    }
    for (const r of await rows<{ pk: string; aad: string; v: string }>(
      sql.raw(`SELECT ${t.pk}::text AS pk, ${t.aad}::text AS aad, ${t.col} AS v FROM ${t.table}
                WHERE ${t.col} IS NOT NULL AND ${t.col} ${NOT_SEALED}${t.ws ? scope(t.ws) : ''}`),
    )) {
      const sealed = protectSecret(t.purpose, r.v, r.aad)
      const res = await rows(sql`
        UPDATE ${sql.identifier(t.table)} SET ${sql.identifier(t.col)} = ${sealed}
         WHERE ${sql.identifier(t.pk)}::text = ${r.pk} AND ${sql.identifier(t.col)} = ${r.v} RETURNING 1`)
      report.sealed += res.length
    }
  }
  return report
}
