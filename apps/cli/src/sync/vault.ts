import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Vault-side helpers for `inklingctl sync`: scanning, hashing, safe writes, path mapping. */

export const STATE_DIR = '.inkling'
export const ASSET_DIR = 'assets'
/** `<name> (conflict 2026-11-07).md` / `<name> (conflict 2026-11-07 2).md` — never synced. */
const CONFLICT_RE = / \(conflict \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/

// same reserved-character rule as the server's sanitizeName (apps/server/src/md/mime.ts)
const RESERVED_CHARS = /[/\\:*?"<>|]/g
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]', 'g')

export function sanitizeName(title: string): string {
  const cleaned = title.replace(RESERVED_CHARS, '').replace(CONTROL_CHARS, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled'
  return cleaned
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface LocalFile {
  /** vault-relative posix path */
  rel: string
  text: string
  hash: string
  /** frontmatter inkling-id, if any */
  id: string | null
}

export function isConflictFile(rel: string): boolean {
  return CONFLICT_RE.test(rel)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reads `inkling-id:` from a leading frontmatter block (line scan, no YAML parser). */
export function frontmatterId(text: string): string | null {
  const t = text.replace(/^﻿/, '')
  if (!t.startsWith('---\n') && !t.startsWith('---\r\n')) return null
  const lines = t.split(/\r?\n/, 200)
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '---') return null
    if (l.startsWith('inkling-id:')) {
      const v = l.slice('inkling-id:'.length).trim().replace(/^["']|["']$/g, '')
      return UUID_RE.test(v) ? v.toLowerCase() : null
    }
  }
  return null
}

/**
 * Recursively lists markdown notes, skipping dot-directories, the root assets/ dir and conflict copies.
 * Obsidian canvases (`.canvas`) are listed separately: they are never synced, only reported.
 */
export async function scanVault(root: string): Promise<{ notes: LocalFile[]; dirs: Set<string>; canvases: string[] }> {
  const notes: LocalFile[] = []
  const dirs = new Set<string>()
  const canvases: string[] = []
  const walk = async (absDir: string, rel: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!rel && e.name === ASSET_DIR) continue
        dirs.add(childRel)
        await walk(path.join(absDir, e.name), childRel)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !isConflictFile(childRel)) {
        const buf = await readFile(path.join(absDir, e.name))
        const text = buf.toString('utf8')
        notes.push({ rel: childRel, text, hash: sha256(buf), id: frontmatterId(text) })
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.canvas')) {
        canvases.push(childRel)
      }
    }
  }
  await walk(root, '')
  notes.sort((a, b) => a.rel.localeCompare(b.rel))
  canvases.sort()
  return { notes, dirs, canvases }
}

/**
 * Page id the server gives a create with this client key (docs/adr/2166-*). Must stay equal to
 * `syncCreateId` in apps/server/src/routes/sync.ts (vaultSyncReadiness.db.test.ts compares them).
 */
export function syncCreateId(workspaceId: string, clientKey: string): string {
  const h = createHash('sha256').update(`inkling-vault-sync-create\u0000${workspaceId.toLowerCase()}\u0000${clientKey.toLowerCase()}`).digest()
  h[6] = (h[6] & 0x0f) | 0x40
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.subarray(0, 16).toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`
}

// ---------------------------------------------------------------------------
// frontmatter the server does not store (docs/adr/2168-*)
// ---------------------------------------------------------------------------

interface FmEntry {
  key: string
  lines: string[]
}

/** The leading frontmatter block split into top-level entries (key line + indented lines), or null. */
export function frontmatterEntries(text: string): { entries: FmEntry[]; start: number; end: number } | null {
  const t = text.replace(/\r\n?/g, '\n')
  if (!t.startsWith('---\n')) return null
  const close = t.indexOf('\n---', 3)
  if (close < 0) return null
  const after = t.indexOf('\n', close + 4)
  if (t.slice(close + 1, after < 0 ? undefined : after).trim() !== '---') return null
  const entries: FmEntry[] = []
  for (const line of t.slice(4, close).split('\n')) {
    const m = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s#'"][^:]*?))\s*:(?:\s|$)/.exec(line)
    if (m && !/^\s/.test(line) && !line.startsWith('- ')) entries.push({ key: (m[1] ?? m[2] ?? m[3]).trim(), lines: [line] })
    else if (entries.length) entries[entries.length - 1].lines.push(line)
  }
  return { entries, start: 4, end: close }
}

/**
 * `serverText` with the frontmatter entries of `localText` named in `keys` added back (those the
 * server reported it does not store), unless the server text has the key itself. Other keys and the
 * body come from `serverText` unchanged.
 */
export function keepFrontmatterKeys(serverText: string, localText: string, keys: string[] | undefined): string {
  if (!keys?.length) return serverText
  const local = frontmatterEntries(localText)
  const server = frontmatterEntries(serverText)
  if (!local || !server) return serverText
  const want = new Set(keys.map((k) => k.trim().toLowerCase()))
  const have = new Set(server.entries.map((e) => e.key.toLowerCase()))
  const extra = local.entries.filter((e) => want.has(e.key.toLowerCase()) && !have.has(e.key.toLowerCase()))
  if (!extra.length) return serverText
  const t = serverText.replace(/\r\n?/g, '\n')
  const lines = extra.flatMap((e) => e.lines)
  return `${t.slice(0, server.end)}\n${lines.join('\n')}${t.slice(server.end)}`
}

/** Lists every non-markdown file (for resolving Obsidian `![[name.ext]]` embeds by basename). */
export async function scanAttachments(root: string): Promise<Map<string, string>> {
  const byName = new Map<string, string>()
  const walk = async (absDir: string, rel: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(absDir, e.name), childRel)
      else if (e.isFile() && !e.name.toLowerCase().endsWith('.md')) {
        const key = e.name.toLowerCase()
        // Obsidian resolves the shortest path first — keep the shallowest match
        const prev = byName.get(key)
        if (!prev || prev.split('/').length > childRel.split('/').length) byName.set(key, childRel)
      }
    }
  }
  await walk(root, '')
  return byName
}

/** Resolves a vault-relative path and refuses anything escaping the vault. */
export function vaultPath(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'))
  const r = path.relative(root, abs)
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`Path escapes the vault: ${rel}`)
  return abs
}

/** Atomic write (temp file + rename) with parent directories. */
export async function writeAtomic(root: string, rel: string, data: string | Buffer): Promise<void> {
  const abs = vaultPath(root, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, abs)
}

export async function readText(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(vaultPath(root, rel), 'utf8')
  } catch {
    return null
  }
}

export async function readBytes(root: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(vaultPath(root, rel))
  } catch {
    return null
  }
}

export async function moveFile(root: string, fromRel: string, toRel: string): Promise<void> {
  const to = vaultPath(root, toRel)
  await mkdir(path.dirname(to), { recursive: true })
  await rename(vaultPath(root, fromRel), to)
}

export async function removeFile(root: string, rel: string): Promise<void> {
  await rm(vaultPath(root, rel), { force: true })
}

export function posixDir(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

export function baseTitle(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  return name.replace(/\.md$/i, '')
}

/** Relative posix link from a note's directory to a vault-relative target. */
export function relLink(fromNoteRel: string, targetRel: string): string {
  const from = posixDir(fromNoteRel)
  const r = path.posix.relative(from || '.', targetRel)
  return r || targetRel
}

/** First free `<dir>/<name><suffix>.md` (suffix " (2)", " (3)", …). */
export function uniquePath(taken: (rel: string) => boolean, dir: string, name: string, suffix = ''): string {
  for (let n = 1; n < 1000; n++) {
    const extra = n === 1 ? '' : ` ${n}`
    const candidate = suffix
      ? `${dir ? `${dir}/` : ''}${name} (${suffix}${extra}).md`
      : `${dir ? `${dir}/` : ''}${name}${n === 1 ? '' : ` (${n})`}.md`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`No free file name for ${name}`)
}

// upload allow-list mirrors the server's (apps/server/src/routes/files.ts)
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
}
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'text/plain': '.txt',
}

export function mimeForPath(rel: string): string | null {
  return EXT_MIME[path.extname(rel).toLowerCase()] ?? null
}

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? ''
}

export function localDateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
