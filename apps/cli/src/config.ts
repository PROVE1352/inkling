import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Schema of the ~/.inkling.json config file. */
export interface InklingConfig {
  server: string
  /** The full saved session cookie string ("inkling_sid=..."), from `inklingctl login`. */
  cookie?: string
  /** A personal API token (`ink_pat_…`), from `inklingctl login --token`. Used before the cookie. */
  token?: string
  vault?: string
  subdir?: string
}

export const DEFAULT_SERVER = 'http://localhost:3000'
export const DEFAULT_SUBDIR = 'Inkling'

/** Path of ~/.inkling.json relative to HOME (or os.homedir). Tests can isolate it via HOME. */
export function configPath(): string {
  return path.join(homedir(), '.inkling.json')
}

/** Load the config — defaults if the file is missing, an error if the JSON is corrupt. */
export async function loadConfig(): Promise<InklingConfig> {
  const p = configPath()
  let raw: string
  try {
    raw = await readFile(p, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { server: DEFAULT_SERVER }
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Config file is corrupt: ${p}`)
  }
  const obj = (parsed ?? {}) as Partial<InklingConfig>
  return {
    server: typeof obj.server === 'string' && obj.server ? obj.server : DEFAULT_SERVER,
    cookie: typeof obj.cookie === 'string' ? obj.cookie : undefined,
    token: typeof obj.token === 'string' ? obj.token : undefined,
    vault: typeof obj.vault === 'string' ? obj.vault : undefined,
    subdir: typeof obj.subdir === 'string' ? obj.subdir : undefined,
  }
}

/**
 * What authenticates requests, first match wins: the INKLING_TOKEN environment variable, the saved
 * API token, the saved session cookie. Undefined = not logged in.
 */
export function credentialOf(config: InklingConfig): string | undefined {
  const env = process.env.INKLING_TOKEN?.trim()
  return env || config.token || config.cookie || undefined
}

/** Where the credential came from, for `inklingctl status`. */
export function credentialSource(config: InklingConfig): 'env' | 'token' | 'cookie' | null {
  if (process.env.INKLING_TOKEN?.trim()) return 'env'
  if (config.token) return 'token'
  if (config.cookie) return 'cookie'
  return null
}

/** Save the config with mode 0600 (protects the sensitive cookie). */
export async function saveConfig(config: InklingConfig): Promise<void> {
  const p = configPath()
  await mkdir(path.dirname(p), { recursive: true })
  const body = JSON.stringify(config, null, 2) + '\n'
  // Pass mode, then chmod again so leftover permissions on an existing file get overwritten.
  await writeFile(p, body, { mode: 0o600 })
  await chmod(p, 0o600)
}
