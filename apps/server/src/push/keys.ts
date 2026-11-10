import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { protectSecret, revealSecret } from '../secretsAtRest'
import { pushEnv } from './config'
import { assertVapidKeys, generateVapidKeys } from './webPushCrypto'
import type { VapidKeys } from './webPushCrypto'

/**
 * The server's VAPID key pair (docs/adr/2220-*).
 *
 *  - VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY set: those (checked to be a matching P-256 pair).
 *  - Neither set: the pair in push_vapid_keys, made on first use. Its private key is protected like
 *    the other stored secrets (sealed with APP_SECRET_KEY when it is set, docs/adr/1111-*). Two
 *    processes making it at once: INSERT … ON CONFLICT DO NOTHING, then both read the one row.
 *  - Only one of them set, a pair that does not match, or a stored key that cannot be opened
 *    (APP_SECRET_KEY missing or changed): push is unavailable and the reason is reported; nothing is
 *    replaced by itself, because a new key silently voids every browser's subscription.
 *
 * Each subscription records the fingerprint of the key it was made with (`vapid_key_id`). Changing the
 * key (setting the env pair later, or deleting the stored row) voids the old subscriptions: they are
 * dropped at their next delivery and the app subscribes again with the new key when it next starts.
 */

export interface ActiveVapid {
  keys: VapidKeys
  /** 16 hex characters of SHA-256(public key). */
  keyId: string
  source: 'env' | 'db'
}

export type VapidProblem = 'disabled' | 'env_incomplete' | 'env_invalid' | 'stored_unreadable'

export class PushUnavailableError extends Error {
  constructor(public readonly reason: VapidProblem) {
    super(`web push unavailable: ${reason}`)
    this.name = 'PushUnavailableError'
  }
}

export function keyIdOf(publicKey: string): string {
  return createHash('sha256').update(publicKey, 'utf8').digest('hex').slice(0, 16)
}

let cached: ActiveVapid | null = null
let loading: Promise<ActiveVapid> | null = null

/** Test hook: forget the cached pair (after changing the env pair or the stored row). */
export function _resetVapidCache(): void {
  cached = null
  loading = null
}

function fromEnv(): ActiveVapid | null {
  const { vapidPublicKey: pub, vapidPrivateKey: priv } = pushEnv
  if (!pub && !priv) return null
  if (!pub || !priv) throw new PushUnavailableError('env_incomplete')
  const keys = { publicKey: pub.replace(/=+$/, ''), privateKey: priv.replace(/=+$/, '') }
  try {
    assertVapidKeys(keys)
  } catch {
    throw new PushUnavailableError('env_invalid')
  }
  return { keys, keyId: keyIdOf(keys.publicKey), source: 'env' }
}

async function fromDb(): Promise<ActiveVapid> {
  const read = async () =>
    ((await db.execute(sql`SELECT public_key AS "publicKey", private_key AS "privateKey" FROM push_vapid_keys WHERE id = 1`)) as unknown as {
      publicKey: string
      privateKey: string
    }[])[0]
  let row = await read()
  if (!row) {
    const fresh = generateVapidKeys()
    await db.execute(sql`
      INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, ${fresh.publicKey}, ${protectSecret('push-vapid-key', fresh.privateKey, '1')})
      ON CONFLICT (id) DO NOTHING`)
    row = await read()
  }
  let privateKey: string
  try {
    privateKey = revealSecret('push-vapid-key', row.privateKey, '1')
    assertVapidKeys({ publicKey: row.publicKey, privateKey })
  } catch {
    // SecretUnreadableError (APP_SECRET_KEY missing or changed) or a stored pair that does not match
    throw new PushUnavailableError('stored_unreadable')
  }
  return { keys: { publicKey: row.publicKey, privateKey }, keyId: keyIdOf(row.publicKey), source: 'db' }
}

/** The active key pair (cached per process). Throws PushUnavailableError. */
export async function activeVapid(): Promise<ActiveVapid> {
  if (!pushEnv.enabled) throw new PushUnavailableError('disabled')
  if (cached) return cached
  const env = fromEnv()
  if (env) return (cached = env)
  loading ??= fromDb().finally(() => {
    loading = null
  })
  return (cached = await loading)
}

/** For status and the public-key route: the problem, or null when push can run. Never throws. */
export async function vapidProblem(): Promise<VapidProblem | null> {
  try {
    await activeVapid()
    return null
  } catch (e) {
    if (e instanceof PushUnavailableError) return e.reason
    // a database error is not a key problem (the status page reports the database on its own)
    return null
  }
}
