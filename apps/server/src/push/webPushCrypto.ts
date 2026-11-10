import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Web push message encryption and VAPID, with node:crypto only (docs/adr/2220-*).
 *
 *  - RFC 8291 (Message Encryption for Web Push) over RFC 8188's `aes128gcm` content coding: one
 *    record, an ephemeral P-256 key per message, the subscription's `p256dh` and `auth` secret.
 *  - RFC 8292 (VAPID): an ES256 JWT (`aud` = origin of the push endpoint, `exp` ≤ 24 h, `sub`)
 *    sent as `Authorization: vapid t=<jwt>, k=<public key>`.
 *
 * Keys travel in the forms browsers and the `web-push` tool use: the public key as the 65-byte
 * uncompressed point (0x04‖x‖y), the private key as the 32-byte scalar, both base64url.
 */

/** Record size written in the header. One record per message, so it only has to exceed the body. */
export const RECORD_SIZE = 4096
/** Push services accept at most 4096 bytes of encrypted body (RFC 8030 §7.2 "SHOULD support 4096"). */
export const MAX_ENCRYPTED_BYTES = 4096
/** salt(16) + rs(4) + idlen(1) + keyid(65) */
export const HEADER_BYTES = 86
/** GCM tag (16) + the padding delimiter 0x02 (1). */
export const RECORD_OVERHEAD = 17
/** The largest plaintext that fits into MAX_ENCRYPTED_BYTES. */
export const MAX_PLAINTEXT_BYTES = MAX_ENCRYPTED_BYTES - HEADER_BYTES - RECORD_OVERHEAD

export function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url')
}

export function fromB64u(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('not base64url')
  return Buffer.from(s.replace(/=+$/, ''), 'base64url')
}

export interface VapidKeys {
  /** 65-byte uncompressed P-256 point, base64url. */
  publicKey: string
  /** 32-byte private scalar, base64url. */
  privateKey: string
}

/** A fresh P-256 key pair in the raw base64url forms. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string }
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  return { publicKey: b64u(pub), privateKey: jwk.d }
}

function pointParts(pub: Buffer): { x: string; y: string } {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('public key must be a 65-byte uncompressed P-256 point')
  return { x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }
}

/** Private KeyObject from the raw forms; throws when the pair does not match or is malformed. */
export function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const pub = fromB64u(keys.publicKey)
  const d = fromB64u(keys.privateKey)
  if (d.length !== 32) throw new Error('private key must be 32 bytes')
  const { x, y } = pointParts(pub)
  // The JWK import does not check that (x, y) is the point of d: derive it and compare.
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID public key does not belong to the private key')
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d: b64u(d) }, format: 'jwk' })
}

export function vapidPublicKeyObject(publicKey: string): KeyObject {
  const { x, y } = pointParts(fromB64u(publicKey))
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' })
}

/** Throws unless the pair is a valid P-256 key pair (boot and first-use check). */
export function assertVapidKeys(keys: VapidKeys): void {
  vapidPrivateKey(keys)
}

// ---------------------------------------------------------------------------
// RFC 8292: VAPID
// ---------------------------------------------------------------------------

/** Longest JWT lifetime push services accept (RFC 8292 §2: "MUST NOT be more than 24 hours"). */
export const VAPID_MAX_TTL_S = 24 * 60 * 60

export function vapidJwt(opts: { audience: string; subject: string; keys: VapidKeys; expiresAt?: number; now?: number }): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  // 12 h: well inside the 24 h limit, and clock skew between us and the push service does not matter.
  const exp = opts.expiresAt ?? now + 12 * 60 * 60
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud: opts.audience, exp, sub: opts.subject })))
  const input = `${header}.${claims}`
  // ES256 = ECDSA P-256 + SHA-256 with the JOSE signature form r‖s (64 bytes), not DER.
  const sig = sign('sha256', Buffer.from(input), { key: vapidPrivateKey(opts.keys), dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64u(sig)}`
}

/** Verify a VAPID JWT with the public key (tests, the fake push service). Returns the claims or null. */
export function verifyVapidJwt(jwt: string, publicKey: string): { aud: string; exp: number; sub: string } | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  const ok = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: vapidPublicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' }, fromB64u(parts[2]))
  if (!ok) return null
  try {
    const header = JSON.parse(fromB64u(parts[0]).toString('utf8')) as { alg?: string }
    if (header.alg !== 'ES256') return null
    return JSON.parse(fromB64u(parts[1]).toString('utf8')) as { aud: string; exp: number; sub: string }
  } catch {
    return null
  }
}

/** `Authorization` header value of RFC 8292 §3. */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`
}

// ---------------------------------------------------------------------------
// RFC 8291: message encryption (aes128gcm)
// ---------------------------------------------------------------------------

export interface SubscriptionKeys {
  /** The user agent's P-256 public key (65 bytes uncompressed), base64url. */
  p256dh: string
  /** The 16-byte authentication secret, base64url. */
  auth: string
}

/** Throws unless the keys have the sizes RFC 8291 requires (registration check). */
export function assertSubscriptionKeys(k: SubscriptionKeys): void {
  const pub = fromB64u(k.p256dh)
  const auth = fromB64u(k.auth)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('p256dh must be a 65-byte uncompressed P-256 point')
  if (auth.length !== 16) throw new Error('auth must be 16 bytes')
  // A point that is not on the curve fails here instead of at the first send.
  createPublicKey({ key: { kty: 'EC', crv: 'P-256', ...pointParts(pub) }, format: 'jwk' })
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, len))
}

function derive(ecdhSecret: Buffer, auth: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  // RFC 8291 §3.4: key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic])
  const ikm = hkdf(auth, ecdhSecret, keyInfo, 32)
  // RFC 8188 §2.2 / §2.3
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12)
  return { cek, nonce }
}

export interface EncryptOptions {
  /** Tests only: the RFC 8291 example's sender key (32-byte private scalar). */
  asPrivateKey?: Buffer
  /** Tests only: the RFC 8291 example's salt. */
  salt?: Buffer
}

/**
 * Encrypt `plaintext` for one subscription: the complete aes128gcm body (header + one record).
 * Throws when it would exceed MAX_ENCRYPTED_BYTES.
 */
export function encryptPayload(plaintext: Buffer, sub: SubscriptionKeys, opts: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error(`payload too large (${plaintext.length} > ${MAX_PLAINTEXT_BYTES} bytes)`)
  const uaPublic = fromB64u(sub.p256dh)
  const auth = fromB64u(sub.auth)
  const ecdh = createECDH('prime256v1')
  if (opts.asPrivateKey) ecdh.setPrivateKey(opts.asPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(uaPublic)
  const salt = opts.salt ?? randomBytes(16)
  const { cek, nonce } = derive(secret, auth, uaPublic, asPublic, salt)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // Last (and only) record: plaintext, then the delimiter 0x02, no further padding.
  const ct = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(HEADER_BYTES)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  asPublic.copy(header, 21)
  return Buffer.concat([header, ct])
}

/**
 * Decrypt an aes128gcm body with the user agent's private key (tests and the fake push service in
 * them; the server never holds a user agent key).
 */
export function decryptPayload(body: Buffer, uaPrivateKey: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const record = body.subarray(21 + idlen)
  if (record.length > rs) throw new Error('more than one record')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivateKey)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const { cek, nonce } = derive(secret, auth, uaPublic, asPublic, salt)
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(record.subarray(record.length - 16))
  const padded = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()])
  // Strip padding: trailing zeros, then the delimiter (0x02 for the last record).
  let end = padded.length - 1
  while (end >= 0 && padded[end] === 0) end--
  if (end < 0 || padded[end] !== 2) throw new Error('bad padding delimiter')
  return padded.subarray(0, end)
}
