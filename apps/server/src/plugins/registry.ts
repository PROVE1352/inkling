import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../env'
import { MAX_ENTRY_BYTES, MAX_MANIFEST_BYTES, parseManifest, PLUGIN_ID_RE, type PluginManifest } from './manifest'

/**
 * On-disk plugin registry. Plugins are installed by the server operator by placing
 *   PLUGINS_DIR/<id>/manifest.json
 *   PLUGINS_DIR/<id>/<entry>.js
 * There is no upload/install API (v0). Only those two files are ever read; only the entry is served.
 *
 * Path safety:
 *  - directory names must already match the id regex (no dots, no separators);
 *  - directories, manifest.json and the entry are lstat'ed and must NOT be symlinks;
 *  - the resolved entry realpath must stay inside realpath(PLUGINS_DIR)/<id>/.
 * The bytes that were hashed are the bytes that are served (kept in memory), so a file swapped
 * on disk after the scan can never be served under an old approval.
 */

export const PLUGINS_DIR = path.resolve(process.env.PLUGINS_DIR?.trim() || path.join(env.dataDir, 'plugins'))

/** Upper bound on directories considered per scan (keeps a misconfigured dir from blowing up memory). */
const MAX_PLUGINS = 50
/** User-facing reads reuse a scan this recent; admin views force a fresh scan. */
const CACHE_MS = 5_000

export type ScannedPlugin =
  | {
      ok: true
      dirName: string
      manifest: PluginManifest
      /** sha256(manifest bytes || 0x00 || entry bytes), hex */
      hash: string
      entry: Buffer
    }
  | { ok: false; dirName: string; error: string }

export function contentHash(manifestBytes: Buffer, entryBytes: Buffer): string {
  return createHash('sha256').update(manifestBytes).update(Buffer.from([0])).update(entryBytes).digest('hex')
}

async function isRegularFile(p: string): Promise<boolean> {
  try {
    const st = await lstat(p)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/** Load + validate one plugin directory. Never throws. */
export async function loadPluginDir(root: string, dirName: string): Promise<ScannedPlugin> {
  const fail = (error: string): ScannedPlugin => ({ ok: false, dirName, error })
  if (!PLUGIN_ID_RE.test(dirName)) return fail('directory name is not a valid plugin id')
  const dir = path.join(root, dirName)
  try {
    const st = await lstat(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return fail('not a directory (symlinks are not allowed)')
  } catch {
    return fail('directory not found')
  }

  const manifestPath = path.join(dir, 'manifest.json')
  if (!(await isRegularFile(manifestPath))) return fail('manifest.json missing or not a regular file')
  const mst = await lstat(manifestPath)
  if (mst.size > MAX_MANIFEST_BYTES) return fail('manifest.json is larger than 64 KB')
  const manifestBytes = await readFile(manifestPath)
  const parsed = parseManifest(manifestBytes, dirName)
  if (!parsed.ok) return fail(parsed.error)
  const manifest = parsed.manifest

  // entry is regex-restricted to a bare file name, but confine it anyway (defense in depth).
  const entryPath = path.resolve(dir, manifest.entry)
  let realRoot: string
  let realEntry: string
  try {
    realRoot = await realpath(root)
    realEntry = await realpath(entryPath)
  } catch {
    return fail(`entry "${manifest.entry}" not found`)
  }
  if (!realEntry.startsWith(path.join(realRoot, dirName) + path.sep)) {
    return fail('entry resolves outside the plugin directory')
  }
  if (!(await isRegularFile(entryPath))) return fail('entry is not a regular file (symlinks are not allowed)')
  const est = await lstat(entryPath)
  if (est.size > MAX_ENTRY_BYTES) return fail('entry bundle is larger than 1 MB')
  const entry = await readFile(entryPath)
  return { ok: true, dirName, manifest, hash: contentHash(manifestBytes, entry), entry }
}

/** Scan a plugins root. A missing root is "no plugins", not an error. */
export async function scanPluginsDir(root: string): Promise<ScannedPlugin[]> {
  let names: string[]
  try {
    const ents = await readdir(root, { withFileTypes: true })
    names = ents
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.'))
      .sort()
      .slice(0, MAX_PLUGINS)
  } catch {
    return []
  }
  return Promise.all(names.map((n) => loadPluginDir(root, n)))
}

let cache: { at: number; list: ScannedPlugin[] } | null = null
let inflight: Promise<ScannedPlugin[]> | null = null

/** Cached scan of PLUGINS_DIR. `fresh` bypasses the cache (admin screens). */
export async function getScannedPlugins(fresh = false): Promise<ScannedPlugin[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list
  if (inflight) return inflight
  inflight = scanPluginsDir(PLUGINS_DIR)
    .then((list) => {
      cache = { at: Date.now(), list }
      return list
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
