import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), node:crypto only (docs/adr/1061-*).
 *
 * Authenticator apps use HMAC-SHA1, 6 digits, 30-second steps, so those are the defaults; the
 * algorithm and digit count are parameters only so the RFC test vectors can be checked.
 */

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512'

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Accepted clock drift in steps on each side (±30 s). */
export const TOTP_WINDOW = 1

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, upper case, no padding) — the secret format of otpauth:// URIs
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/** Decode base32, ignoring case, spaces, dashes and padding. Throws on other characters. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------

/** HOTP value for one counter (RFC 4226 §5.3), zero-padded to `digits`. */
export function hotp(
  secret: Uint8Array,
  counter: number | bigint,
  digits = TOTP_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  // The counter is an 8-byte big-endian integer: T = 20000000000 / 30 does not fit in 32 bits.
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm, secret).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(bin).padStart(digits, '0')
}

/** Time step for a unix time in seconds. */
export function totpStep(unixSeconds: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(unixSeconds / period)
}

/** TOTP value at a unix time in seconds (RFC 6238 §4). */
export function totpAt(
  secret: Uint8Array,
  unixSeconds: number,
  opts: { digits?: number; algorithm?: TotpAlgorithm; period?: number } = {},
): string {
  return hotp(secret, totpStep(unixSeconds, opts.period), opts.digits, opts.algorithm)
}

function sameDigits(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/**
 * Check a 6-digit code against the steps now-1 … now+1. Returns the matching step (the caller
 * stores it and refuses that step and older ones next time, RFC 6238 §5.2), or null.
 * Every candidate step is computed and compared, so timing does not reveal which one matched.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  opts: { now?: number; window?: number } = {},
): number | null {
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  const now = totpStep((opts.now ?? Date.now()) / 1000)
  const window = opts.window ?? TOTP_WINDOW
  let matched: number | null = null
  for (let step = now - window; step <= now + window; step++) {
    if (sameDigits(hotp(secret, step), digits) && matched === null) matched = step
  }
  return matched
}

/** A new 160-bit secret (RFC 4226 §4 recommends 160 bits; SHA-1 block-friendly). */
export function newTotpSecret(): Buffer {
  return randomBytes(20)
}

/** otpauth:// URI understood by authenticator apps (Google Authenticator key URI format). */
export function otpauthUri(secretBase32: string, account: string, issuer = 'Inkling'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${q.toString()}`
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

// Same confusable-free alphabet as invite codes / signup keys (util.ts).
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Ten single-use recovery codes, XXXXX-XXXXX (10 characters, ~49 bits each). */
export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    let s = ''
    for (let j = 0; j < 10; j++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
    codes.push(`${s.slice(0, 5)}-${s.slice(5)}`)
  }
  return codes
}

/** Normalize a typed recovery code: upper case, drop spaces and dashes. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}
