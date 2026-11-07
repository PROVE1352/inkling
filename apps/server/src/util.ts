import { randomBytes, randomInt } from 'node:crypto'

/**
 * Parse a raw Cookie header. (Used on paths that don't go through @fastify/cookie,
 * such as the Hocuspocus upgrade.)
 * - Split entries on `; ` and trim each one
 * - Split key/value at the first `=` (values may contain `=`)
 * - value is decodeURIComponent'd
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim()
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    if (!key) continue
    const value = part.slice(eq + 1)
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}

/** Session token: 32 random bytes as base64url */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Escape the special characters (\ % _) of an ILIKE pattern. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// Upper-case letters + digits, excluding confusable characters (0/O, 1/I/L etc.)
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Invite code: 10 characters from the alphabet above, crypto-random */
export function newInviteCode(length = 10): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
  }
  return code
}

/** Signup key: same alphabet as invite codes, in XXXX-XXXX-XXXX-XXXX form */
export function newSignupKey(): string {
  const groups: string[] = []
  for (let g = 0; g < 4; g++) {
    let part = ''
    for (let i = 0; i < 4; i++) {
      part += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
    }
    groups.push(part)
  }
  return groups.join('-')
}

// For temporary passwords: lower-case letters + digits without confusable characters (0/o, 1/l/i)
const TEMP_PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Temporary password: xxxx-xxxx-xxxx (12 characters, about 59 bits). Assumes the user changes it after receiving it. */
export function newTempPassword(): string {
  const groups: string[] = []
  for (let g = 0; g < 3; g++) {
    let part = ''
    for (let i = 0; i < 4; i++) {
      part += TEMP_PW_ALPHABET[randomInt(TEMP_PW_ALPHABET.length)]
    }
    groups.push(part)
  }
  return groups.join('-')
}

/**
 * Masks bearer secrets in a request URL before it is logged (C-L8): path tokens of the iCal feed
 * (/ical/<token>.ics), public shares (/api/public/<token>…, /s/<token>) and secret-looking query
 * parameters (code, token, key, secret, password, state, refresh_token, …).
 */
export function maskUrlSecrets(url: string): string {
  if (!url) return url
  const q = url.indexOf('?')
  let pathPart = q >= 0 ? url.slice(0, q) : url
  const query = q >= 0 ? url.slice(q + 1) : ''
  pathPart = pathPart
    .replace(/^(\/ical\/)[^/?]+/i, '$1***')
    .replace(/^(\/api\/public\/)[^/?]+/i, '$1***')
    .replace(/^(\/s\/)[^/?]+/i, '$1***')
  if (!query) return pathPart
  const masked = query
    .split('&')
    .map((kv) => {
      const eq = kv.indexOf('=')
      const k = eq >= 0 ? kv.slice(0, eq) : kv
      return /^(code|token|key|secret|password|state|code_verifier|refresh_token|access_token|signup_?key|invite(_?code)?)$/i.test(
        decodeURIComponentSafe(k),
      ) && eq >= 0
        ? `${k}=***`
        : kv
    })
    .join('&')
  return `${pathPart}?${masked}`
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
