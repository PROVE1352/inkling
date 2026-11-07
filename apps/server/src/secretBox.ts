import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { env } from './env'

/**
 * Application-level encryption for secrets that must be readable again (docs/adr/1061-*).
 *
 * Key material: APP_SECRET_KEY (env). Each use gets its own 256-bit AES key derived with HKDF-SHA256
 * and a purpose label, so one value can later also protect other secrets (webhook URLs, C-L13)
 * without the ciphertexts being interchangeable. Ciphertext format:
 *
 *   v1.<iv base64url>.<GCM tag base64url>.<ciphertext base64url>
 *
 * AES-256-GCM with a 96-bit random IV; `aad` (e.g. the user id) binds a ciphertext to its row, so
 * copying one user's encrypted secret onto another account in the database does not decrypt.
 * There is deliberately no fallback key: a random per-boot key would make every stored secret
 * unreadable after a restart, and plaintext would defeat the purpose.
 */

const VERSION = 'v1'

/** Whether APP_SECRET_KEY is configured (features that need it answer 501 otherwise). */
export function secretBoxAvailable(): boolean {
  return env.appSecretKey !== null
}

const keyCache = new Map<string, Buffer>()

function keyFor(purpose: string): Buffer {
  const material = env.appSecretKey
  if (!material) throw new Error('APP_SECRET_KEY is not set')
  let key = keyCache.get(purpose)
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), `inkling:${purpose}`, 32))
    keyCache.set(purpose, key)
  }
  return key
}

export function sealSecret(purpose: string, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
}

/** Decrypt a sealed value. Throws when the key changed, the value was tampered with or aad differs. */
export function openSecret(purpose: string, sealed: string, aad: string): Buffer {
  const [version, iv, tag, ct] = sealed.split('.')
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('unsupported sealed secret')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()])
}

/** Test hook: forget derived keys (after changing env.appSecretKey). */
export function _resetSecretBoxCache(): void {
  keyCache.clear()
}

/** Boot check: a too-short key is a configuration mistake, not something to run with. */
export function assertSecretKeyConfig(): void {
  const k = env.appSecretKey
  if (k !== null && k.length < 32) {
    throw new Error('APP_SECRET_KEY must be at least 32 characters (e.g. `openssl rand -base64 32`).')
  }
}
