import { isIPv4, isIPv6 } from 'node:net'

/**
 * Address keys for counting (0.22 security fix F6, contract §14, docs/adr/2537-*). Pure: no
 * settings, no database, so the request limiter can use it.
 *
 * One IPv6 subscriber usually holds a /64 and often a /56 or a /48, so a key of the full address is
 * no limit at all. IPv4 is its own key; an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, or its hex
 * form `::ffff:102:304`) is the IPv4 address, so a dual-stack socket and a proxy header count alike.
 *
 *   the global request limit (rateLimitKey.ts)   IPv6 per /64
 *   the sign-up limits (account/signupGuards.ts) IPv6 per /56
 *   the sign-in failure bans (guard.ts ipKey)    unchanged (IPv6 per /64)
 */

/** The 8 groups of an IPv6 address as numbers (a dotted IPv4 tail becomes the last two), or null. */
function v6Groups(ip: string): number[] | null {
  let addr = ip
  const v4tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (v4tail) {
    if (!isIPv4(v4tail[2])) return null
    const [a, b, c, d] = v4tail[2].split('.').map(Number)
    addr = `${v4tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  let head: string[]
  let tail: string[]
  if (addr.includes('::')) {
    const [h, t] = addr.split('::')
    head = h ? h.split(':') : []
    tail = t ? t.split(':') : []
  } else {
    head = addr.split(':')
    tail = []
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

const hex = (n: number) => n.toString(16)

/**
 * The counting key of `ip`: IPv4 (mapped IPv6 included) as the dotted address, IPv6 as its /64 or
 * /56 prefix (`2001:db8:1:ab00::/56`). Anything that is not an address comes back unchanged.
 */
export function ipPrefixKey(ip: string, v6Bits: 56 | 64): string {
  if (isIPv4(ip)) return ip
  const bare = ip.split('%')[0]
  if (!isIPv6(bare)) return ip
  const g = v6Groups(bare)
  if (!g) return ip
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  }
  const fourth = v6Bits === 56 ? g[3] & 0xff00 : g[3]
  return `${hex(g[0])}:${hex(g[1])}:${hex(g[2])}:${hex(fourth)}::/${v6Bits}`
}

/** The sign-up limits' key: IPv6 per /56 (SIGNUP_PER_IP_PER_DAY, the taken-ID count). */
export const signupIpKey = (ip: string): string => ipPrefixKey(ip, 56)
