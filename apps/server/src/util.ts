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
 * (/ical/<token>.ics), public shares (/api/public/<token>…, /s/<token>), public forms
 * (/api/public/forms/<token>, /f/<token>), workspace invite codes (/join/<code>), page invites
 * (/api/page-invites/<token>, /invite/page/<token>), signup keys in admin paths, secret-looking query
 * parameters (code, token, key, secret, password, state, refresh_token, …), and a sign-in redirect
 * (`next`, `returnTo`) that points at any of these (0.25.4 security fix F-3 / E-3).
 */
export function maskUrlSecrets(url: string): string {
  return maskUrl(url, 0)
}

const PATH_SECRETS: RegExp[] = [
  /^(\/ical\/)[^/?]+/i,
  /^(\/api\/public\/forms\/)[^/?]+/i,
  /^(\/api\/public\/)(?!forms(?:\/|$))[^/?]+/i,
  /^(\/s\/)[^/?]+/i,
  /^(\/f\/)[^/?]+/i,
  /^(\/join\/)[^/?]+/i,
  /^(\/invite\/page\/)[^/?]+/i,
  /^(\/api\/page-invites\/)[^/?]+/i,
  /^(\/api\/admin\/signup-keys\/)[^/?]+/i,
]
const SECRET_QUERY = /^(code|token|key|secret|password|state|code_verifier|refresh_token|access_token|signup_?key|invite(_?code)?)$/i
/** Query parameters that hold an in-app path (sign-in redirects): masked as a URL of their own. */
const REDIRECT_QUERY = /^(next|returnTo|return_to|redirect)$/i

function maskUrl(url: string, depth: number): string {
  if (!url) return url
  const q = url.indexOf('?')
  let pathPart = q >= 0 ? url.slice(0, q) : url
  const query = q >= 0 ? url.slice(q + 1) : ''
  for (const re of PATH_SECRETS) pathPart = pathPart.replace(re, '$1***')
  if (!query) return pathPart
  const masked = query
    .split('&')
    .map((kv) => {
      const eq = kv.indexOf('=')
      if (eq < 0) return kv
      const k = decodeURIComponentSafe(kv.slice(0, eq))
      if (SECRET_QUERY.test(k)) return `${kv.slice(0, eq)}=***`
      if (REDIRECT_QUERY.test(k)) {
        // a nested redirect inside a redirect is not followed further: masked whole
        if (depth > 0) return `${kv.slice(0, eq)}=***`
        const inner = decodeURIComponentSafe(kv.slice(eq + 1).replace(/\+/g, ' '))
        const out = maskUrl(inner, depth + 1)
        return out === inner ? kv : `${kv.slice(0, eq)}=${encodeURIComponent(out)}`
      }
      return kv
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
