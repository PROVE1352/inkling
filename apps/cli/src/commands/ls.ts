import { listWorkspaces } from '../api'
import { loadConfig } from '../config'
import { ApiError } from '../http'

/** inklingctl ls — list workspaces (id, name, role). */
export async function cmdLs(): Promise<void> {
  const config = await loadConfig()
  if (!config.cookie) {
    throw new Error('Not logged in. Run `inklingctl login` first')
  }

  let workspaces
  try {
    workspaces = await listWorkspaces(config.server, config.cookie)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new Error('Session expired. Run `inklingctl login` again')
    }
    throw err
  }

  if (workspaces.length === 0) {
    process.stdout.write('You are not a member of any workspace\n')
    return
  }

  // simple table alignment
  const rows = workspaces.map((w) => ({ name: w.name, role: w.role, id: w.id }))
  const nameWidth = Math.max(4, ...rows.map((r) => stringWidth(r.name)))
  const roleWidth = Math.max(4, ...rows.map((r) => r.role.length))

  process.stdout.write(
    `${pad('NAME', nameWidth)}  ${pad('ROLE', roleWidth)}  ID\n`,
  )
  for (const r of rows) {
    process.stdout.write(`${pad(r.name, nameWidth)}  ${pad(r.role, roleWidth)}  ${r.id}\n`)
  }
}

/** Display width, counting wide characters (Hangul, CJK, etc.) as 2. */
function stringWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    w += code > 0x1100 && isWide(code) ? 2 : 1
  }
  return w
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function pad(s: string, width: number): string {
  const diff = width - stringWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}
