import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { boolFlag, strFlag } from '../args'
import { listWorkspaces, selectWorkspace } from '../api'
import { credentialOf, loadConfig } from '../config'
import { ApiError } from '../http'
import { joinLines, merge3 } from '../sync/diff3'
import type { PageMarkdown, SyncPage } from '../sync/syncApi'
import { RevisionMismatch, SyncApi } from '../sync/syncApi'
import {
  ASSET_DIR,
  baseTitle,
  extForMime,
  keepFrontmatterKeys,
  localDateStamp,
  mimeForPath,
  moveFile,
  posixDir,
  readBytes,
  readText,
  relLink,
  removeFile,
  sanitizeName,
  scanAttachments,
  scanVault,
  sha256,
  STATE_DIR,
  syncCreateId,
  uniquePath,
  vaultPath,
  writeAtomic,
} from '../sync/vault'
import type { LocalFile } from '../sync/vault'

/**
 * inklingctl sync <vaultDir> [--workspace <name|id>] [--server <url>] [--dry-run]
 *
 * Two-way sync between an Obsidian vault folder and an Inkling workspace (experimental
 * `vault-sync`; the server must list it in EXPERIMENTAL_FEATURES). Design and edge cases:
 * docs/adr/0200-vault-sync-protocol.md, 0202-vault-sync-merge-and-deletes.md; retries, directories,
 * kept frontmatter and refusals, block tokens: docs/adr/2166–2169.
 *
 * State lives in <vault>/.inkling/: sync-state.json (per page: path, last local file hash,
 * last server content hash, server revision) and base/<pageId>.md (last synced text, the
 * common ancestor for three-way merges).
 */

interface FileState {
  path: string
  /** sha256 of the vault file bytes as last written/seen by sync */
  localHash: string
  /** server contentHash (canonical markdown) at last sync */
  serverHash: string
  /** server revision token at last sync */
  revision: string
  /** unresolved conflict copy (vault-relative); the page is skipped while it exists */
  conflict?: string
  /** frontmatter keys the server does not store; kept in the note when it is rewritten (docs/adr/2168-*) */
  keep?: string[]
}

interface SyncState {
  version: 1
  server: string
  workspaceId: string
  cursor: string | null
  files: Record<string, FileState>
  /** folder pages (and doc pages with children) → vault directory */
  folders: Record<string, string>
  /** attachment fileId → vault path + sha256 (+ the page it was uploaded to by this CLI) */
  assets: Record<string, { path: string; hash: string; page?: string }>
  /**
   * Retry keys of creates not yet answered (vault path, or `dir:<path>` for folders → client key),
   * saved before the requests go out (docs/adr/2166-*).
   */
  pending?: Record<string, string>
  /** every page shown as a directory (page id → dir) at the end of the last completed run (docs/adr/2167-*) */
  dirs?: Record<string, string>
  /** those of `dirs` that held at least one note then (only such a folder is trashed when its directory goes) */
  filled?: string[]
}

type Action =
  | 'upload'
  | 'download'
  | 'merge'
  | 'conflict'
  | 'create-server'
  | 'create-local'
  | 'trash-server'
  | 'trash-local'
  | 'rename-server'
  | 'move-local'
  | 'skip'
  | 'keep'

const FILES_URL_RE = /\]\(\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi
// `](target)` or `](<target with spaces>)` (CommonMark's angle-bracket form, which Obsidian writes)
const LINK_TARGET_RE = /\]\((<[^<>\n]+>|[^()\s]+)\)/g
const EMBED_RE = /!\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g

export async function cmdSync(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const dir = positionals[0]
  if (!dir) throw new Error('Usage: inklingctl sync <vaultDir> [--workspace <name|id>] [--dry-run]')
  let root: string
  try {
    root = await realpath(dir)
    if (!(await stat(root)).isDirectory()) throw new Error()
  } catch {
    throw new Error(`Vault directory not found: ${dir}`)
  }
  const config = await loadConfig()
  const auth = credentialOf(config)
  if (!auth) throw new Error('Not logged in — run `inklingctl login` first, or set INKLING_TOKEN')
  const server = strFlag(flags, 'server') ?? config.server
  const ws = selectWorkspace(await listWorkspaces(server, auth), strFlag(flags, 'workspace'))
  const run = new SyncRun(root, new SyncApi(server, auth, ws.id), server, ws.id, boolFlag(flags, 'dry-run'))
  await run.run()
}

class SyncRun {
  private state!: SyncState
  private log: { action: Action; path: string; detail?: string }[] = []
  private conflicts: string[] = []
  /** things not synced on purpose or refused, reported after the summary (once per run) */
  private notices: string[] = []
  private attachments: Map<string, string> | null = null
  /** vault paths taken by notes in this run (for collision checks) */
  private taken = new Set<string>()
  /** vault dir → page id (folders, docs with children, collections) */
  private dirIndex = new Map<string, string>()

  constructor(
    private root: string,
    private api: SyncApi,
    private server: string,
    private workspaceId: string,
    private dry: boolean,
  ) {}

  // ---------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------

  private statePath(): string {
    return vaultPath(this.root, `${STATE_DIR}/sync-state.json`)
  }

  private async loadState(): Promise<void> {
    let raw: string | null = null
    try {
      raw = await readFile(this.statePath(), 'utf8')
    } catch {
      raw = null
    }
    if (raw) {
      const s = JSON.parse(raw) as SyncState
      if (s.workspaceId !== this.workspaceId) {
        throw new Error(`This vault is linked to workspace ${s.workspaceId}; refusing to sync it with ${this.workspaceId}`)
      }
      this.state = { ...s, folders: s.folders ?? {}, assets: s.assets ?? {}, files: s.files ?? {} }
    } else {
      this.state = { version: 1, server: this.server, workspaceId: this.workspaceId, cursor: null, files: {}, folders: {}, assets: {} }
    }
  }

  private async saveState(): Promise<void> {
    if (this.dry) return
    await writeAtomic(this.root, `${STATE_DIR}/sync-state.json`, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  private baseRel(pid: string): string {
    return `${STATE_DIR}/base/${pid}.md`
  }

  private async readBase(pid: string): Promise<string> {
    return (await readText(this.root, this.baseRel(pid))) ?? ''
  }

  private note(action: Action, p: string, detail?: string): void {
    this.log.push({ action, path: p, detail })
  }

  private notice(msg: string): void {
    if (!this.notices.includes(msg)) this.notices.push(msg)
  }

  /** A write the server refused for this account (edit lock, read-only token, range): skip, report, go on. */
  private refused(err: unknown, rel: string): boolean {
    if (!(err instanceof ApiError) || err.status !== 403) return false
    this.note('skip', rel, `refused by the server: ${err.message}`)
    return true
  }

  // ---------------------------------------------------------------------------
  // server-form ⇄ local-form (attachments)
  // ---------------------------------------------------------------------------

  /** `/files/<id>` → relative link to assets/<id><ext> (downloading missing attachments). */
  private async toLocal(md: string, noteRel: string): Promise<string> {
    const ids = new Set<string>()
    for (const m of md.matchAll(FILES_URL_RE)) ids.add(m[1].toLowerCase())
    for (const id of ids) {
      const known = this.state.assets[id]
      if (known && (await readBytes(this.root, known.path))) continue
      if (this.dry) {
        this.state.assets[id] = { path: `${ASSET_DIR}/${id}`, hash: '' }
        continue
      }
      try {
        const { data, mime } = await this.api.download(id)
        const rel = `${ASSET_DIR}/${id}${extForMime(mime)}`
        await writeAtomic(this.root, rel, data)
        this.state.assets[id] = { path: rel, hash: sha256(data) }
      } catch (err) {
        process.stderr.write(`warning: attachment ${id} could not be downloaded (${(err as Error).message})\n`)
      }
    }
    return md.replace(FILES_URL_RE, (whole, id: string) => {
      const a = this.state.assets[id.toLowerCase()]
      return a ? `](${relLink(noteRel, a.path)})` : whole
    })
  }

  /** Local attachment links / `![[x.png]]` embeds → `/files/<id>` (uploading new files). */
  private async toServer(md: string, noteRel: string, pageId: string): Promise<string> {
    const byPath = new Map(Object.entries(this.state.assets).map(([id, a]) => [a.path, id]))
    const resolveFile = async (targetRel: string): Promise<string | null> => {
      const known = byPath.get(targetRel)
      if (known) return known
      const mime = mimeForPath(targetRel)
      if (!mime) {
        if (path.posix.extname(targetRel) && (await stat(vaultPath(this.root, targetRel)).catch(() => null))?.isFile()) {
          this.notice(`${targetRel}: this file type is not synced; the link in ${noteRel} stays as it is`)
        }
        return null
      }
      const data = await readBytes(this.root, targetRel)
      if (!data) return null
      const hash = sha256(data)
      // Identical bytes reuse a file uploaded for the same page only: a file belongs to its page and
      // goes with it when that page is purged from the trash.
      for (const [id, a] of Object.entries(this.state.assets)) if (a.hash === hash && a.page === pageId) return id
      if (this.dry) return null
      let id: string
      try {
        id = await this.api.upload(pageId, path.posix.basename(targetRel), mime, data)
      } catch (err) {
        // too large, type refused, uploads switched off for connections: the note still syncs
        if (err instanceof ApiError && [400, 403, 413, 415, 422].includes(err.status)) {
          this.notice(`${targetRel}: not uploaded (${err.message}); the link in ${noteRel} stays as it is`)
          return null
        }
        throw err
      }
      const rel = `${ASSET_DIR}/${id}${extForMime(mime)}`
      await writeAtomic(this.root, rel, data)
      this.state.assets[id] = { path: rel, hash, page: pageId }
      byPath.set(targetRel, id)
      return id
    }

    // (1) markdown links/images with a relative target
    const replacements = new Map<string, string>()
    for (const m of md.matchAll(LINK_TARGET_RE)) {
      const target = m[1]
      if (replacements.has(target)) continue
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) continue
      if (target.toLowerCase().endsWith('.md')) continue
      let decoded: string
      try {
        decoded = decodeURI(target.replace(/^<|>$/g, ''))
      } catch {
        continue
      }
      const rel = path.posix.normalize(path.posix.join(posixDir(noteRel), decoded))
      if (rel.startsWith('..')) continue
      const id = await resolveFile(rel)
      if (id) replacements.set(target, `/files/${id}`)
    }
    let out = md.replace(LINK_TARGET_RE, (whole, target: string) => {
      const r = replacements.get(target)
      return r ? `](${r})` : whole
    })

    // (2) Obsidian embeds of non-markdown files: ![[photo.png]] → ![photo.png](/files/<id>)
    const embeds = new Map<string, string>()
    for (const m of out.matchAll(EMBED_RE)) {
      const name = m[1].trim()
      if (!mimeForPath(name) || embeds.has(name)) continue
      this.attachments ??= await scanAttachments(this.root)
      const rel = name.includes('/') ? name : this.attachments.get(path.posix.basename(name).toLowerCase())
      if (!rel) continue
      const id = await resolveFile(rel)
      if (id) embeds.set(name, id)
    }
    if (embeds.size) {
      out = out.replace(EMBED_RE, (whole, raw: string) => {
        const id = embeds.get(raw.trim())
        return id ? `![${raw.trim()}](/files/${id})` : whole
      })
    }
    return out
  }

  // ---------------------------------------------------------------------------
  // server tree → vault paths (same naming rule as the zip export)
  // ---------------------------------------------------------------------------

  private computeServerPaths(pages: SyncPage[]): Map<string, string> {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const children = new Map<string | null, SyncPage[]>()
    for (const p of pages) {
      const key = p.parentId && byId.has(p.parentId) ? p.parentId : null
      const arr = children.get(key) ?? []
      arr.push(p)
      children.set(key, arr)
    }
    const filePaths = new Map<string, string>()
    const walk = (parent: string | null, dir: string, depth: number) => {
      if (depth > 64) return
      const used = new Set<string>()
      for (const p of children.get(parent) ?? []) {
        const raw = sanitizeName(p.title)
        let name = raw
        let n = 2
        while (used.has(name.toLowerCase())) name = `${raw} (${n++})`
        used.add(name.toLowerCase())
        const childDir = dir ? `${dir}/${name}` : name
        if (p.kind === 'doc') filePaths.set(p.id, `${childDir}.md`)
        if (p.kind === 'canvas') this.notice(`canvas "${childDir}" is not synced; open it in Inkling`)
        if (p.kind === 'folder' || p.kind === 'collection' || children.has(p.id)) {
          this.dirIndex.set(childDir, p.id)
          if (p.kind === 'folder') this.state.folders[p.id] = childDir
        }
        walk(p.id, childDir, depth + 1)
      }
    }
    walk(null, '', 0)
    return filePaths
  }

  /** Page id for a vault directory, creating folder pages for missing segments. */
  private async ensureDir(dir: string): Promise<string | null> {
    if (!dir) return null
    const known = this.dirIndex.get(dir)
    if (known) return known
    // `Page.md` next to `Page/`: the directory holds the note's sub-pages (the layout sync itself
    // writes), not a folder page of the same name
    const note = Object.entries(this.state.files).find(([, st]) => st.path === `${dir}.md`)
    if (note) {
      this.dirIndex.set(dir, note[0])
      return note[0]
    }
    const parentId = await this.ensureDir(posixDir(dir))
    const title = dir.slice(dir.lastIndexOf('/') + 1)
    if (this.dry) {
      this.dirIndex.set(dir, `dry:${dir}`)
      return `dry:${dir}`
    }
    const key = `dir:${dir}`
    this.state.pending ??= {}
    if (!this.state.pending[key]) {
      this.state.pending[key] = randomUUID()
      await this.saveState()
    }
    const r = await this.api.create({ parentId, title, kind: 'folder', clientKey: this.state.pending[key] })
    delete this.state.pending[key]
    this.dirIndex.set(dir, r.page.id)
    this.state.folders[r.page.id] = dir
    this.note('create-server', `${dir}/`, 'folder')
    return r.page.id
  }

  // ---------------------------------------------------------------------------
  // page operations
  // ---------------------------------------------------------------------------

  private async record(pid: string, rel: string, localText: string, server: PageMarkdown, keep?: string[]): Promise<void> {
    this.state.files[pid] = {
      path: rel,
      localHash: sha256(Buffer.from(localText, 'utf8')),
      serverHash: server.contentHash,
      revision: server.revision,
      ...(keep?.length ? { keep } : {}),
    }
    if (!this.dry) await writeAtomic(this.root, this.baseRel(pid), localText)
  }

  /**
   * Writes the server version to the vault and records it as the new base. Frontmatter the server
   * does not store (docs/adr/2168-*) is carried over from the note on disk.
   */
  private async download(pid: string, rel: string, server: PageMarkdown): Promise<void> {
    const keep = this.state.files[pid]?.keep
    const onDisk = keep?.length ? await readText(this.root, rel) : null
    const local = keepFrontmatterKeys(await this.toLocal(server.markdown, rel), onDisk ?? '', keep)
    if (!this.dry) await writeAtomic(this.root, rel, local)
    await this.record(pid, rel, local, server, keep)
  }

  /** Reports frontmatter the server did not store; it stays in the note (docs/adr/2168-*). */
  private keptKeys(rel: string, server: PageMarkdown): string[] | undefined {
    const keys = server.droppedFrontmatterKeys?.filter(Boolean)
    if (!keys?.length) return undefined
    this.notice(`${rel}: frontmatter kept only in the vault (Inkling does not store it): ${keys.join(', ')}`)
    return keys
  }

  /**
   * Uploads `localText` (already merged if needed). After a successful write the vault file is
   * replaced by the server's canonical rendering — unless the user edited it meanwhile.
   */
  private async upload(pid: string, rel: string, localText: string, expectedRevision: string): Promise<PageMarkdown> {
    const serverMd = await this.toServer(localText, rel, pid)
    if (this.dry) return { revision: expectedRevision, contentHash: '', markdown: serverMd }
    const result = await this.api.write(pid, serverMd, expectedRevision)
    const keep = this.keptKeys(rel, result)
    const canonical = keepFrontmatterKeys(await this.toLocal(result.markdown, rel), localText, keep)
    const onDisk = await readText(this.root, rel)
    if (onDisk === localText || onDisk === null) {
      await writeAtomic(this.root, rel, canonical)
      await this.record(pid, rel, canonical, result, keep)
    } else {
      // edited during sync: keep the user's bytes; next run sees them as a local change
      await this.record(pid, rel, localText, result, keep)
    }
    return result
  }

  private async mergeBoth(pid: string, rel: string, localText: string, server: PageMarkdown): Promise<void> {
    const serverLocal = keepFrontmatterKeys(await this.toLocal(server.markdown, rel), localText, this.state.files[pid]?.keep)
    if (serverLocal === localText) {
      await this.record(pid, rel, localText, server)
      this.note('keep', rel, 'identical on both sides')
      return
    }
    const base = await this.readBase(pid)
    const m = merge3(base, localText, serverLocal)
    if (m.conflicts.length === 0) {
      const merged = joinLines(m.lines)
      if (!this.dry) await writeAtomic(this.root, rel, merged)
      try {
        await this.upload(pid, rel, merged, server.revision)
        this.note('merge', rel)
      } catch (err) {
        if (err instanceof RevisionMismatch) {
          // server moved again while we merged — the merged file stays local; next run merges again
          this.state.files[pid] = { ...this.state.files[pid], path: rel }
          this.note('skip', rel, 'server changed during merge; run sync again')
          return
        }
        throw err
      }
      return
    }
    // conflict: never overwrite the note; write a sibling copy with markers
    const dir = posixDir(rel)
    const conflictRel = uniquePath(
      (p) => this.taken.has(p) || existsSync(vaultPath(this.root, p)),
      dir,
      baseTitle(rel),
      `conflict ${localDateStamp()}`,
    )
    const header =
      m.gaveUp
        ? '<!-- inkling sync: files too different to merge line by line -->\n'
        : ''
    if (!this.dry) {
      await writeAtomic(this.root, conflictRel, header + joinLines(m.lines))
      // the server version becomes the merge base once the user resolves the conflict
      await writeAtomic(this.root, this.baseRel(pid), serverLocal)
    }
    const prev = this.state.files[pid]
    this.state.files[pid] = {
      path: rel,
      localHash: prev?.localHash ?? '',
      serverHash: server.contentHash,
      revision: server.revision,
      conflict: conflictRel,
      ...(prev?.keep ? { keep: prev.keep } : {}),
    }
    this.taken.add(conflictRel)
    const where = m.conflicts.map((c) => (c.baseEnd > c.baseStart ? `${c.baseStart}-${c.baseEnd}` : `${c.baseStart}`))
    this.conflicts.push(`${rel} -> ${conflictRel} (${m.conflicts.length} hunk(s) at base line ${where.join(', ')})`)
    this.note('conflict', rel, conflictRel)
  }

  // ---------------------------------------------------------------------------
  // main
  // ---------------------------------------------------------------------------

  async run(): Promise<void> {
    await this.loadState()
    try {
      await this.syncAll()
    } catch (err) {
      // keep per-page progress (each entry is only recorded after its operation succeeded);
      // the cursor is not advanced, so the next run re-examines everything not yet recorded
      await this.saveState()
      this.printSummary()
      throw err
    }
  }

  private async syncAll(): Promise<void> {
    const changes = await this.api.changes(this.state.cursor)
    const serverById = new Map(changes.pages.map((p) => [p.id, p]))
    // Directories as the last completed run left them (docs/adr/2167-*); a state from before 0.17
    // has only the folder pages. Kept as they are in saves made during this run.
    const prevDirs: Record<string, string> = { ...(this.state.dirs ?? this.state.folders) }
    // A state without `dirs` comes from a CLI that also saved `folders` from its error handler, before
    // it made those directories: that first run trashes no folder page.
    const dirsKnown = !!this.state.dirs
    const prevFilled = new Set(this.state.filled ?? [])
    this.state.dirs = { ...prevDirs }
    this.state.folders = {}
    const serverPaths = this.computeServerPaths(changes.pages)
    const { notes, dirs: localDirs, canvases } = await scanVault(this.root)
    if (canvases.length) {
      const more = canvases.length > 5 ? `, … (${canvases.length} in all)` : ''
      this.notice(`canvas files are not synced: ${canvases.slice(0, 5).join(', ')}${more}`)
    }
    const localByPath = new Map(notes.map((n) => [n.rel, n]))
    for (const n of notes) this.taken.add(n.rel)

    // --- match vault notes to tracked pages ------------------------------------
    const claimed = new Set<string>()
    const matched = new Map<string, LocalFile>()
    const tracked = Object.keys(this.state.files)
    for (const pid of tracked) {
      const f = localByPath.get(this.state.files[pid].path)
      if (f && (!f.id || f.id === pid || !this.state.files[f.id])) {
        matched.set(pid, f)
        claimed.add(f.rel)
      }
    }
    for (const pid of tracked) {
      if (matched.has(pid)) continue
      const f = notes.find((n) => !claimed.has(n.rel) && n.id === pid)
      if (f) {
        matched.set(pid, f)
        claimed.add(f.rel)
      }
    }
    for (const pid of tracked) {
      if (matched.has(pid)) continue
      const f = notes.find((n) => !claimed.has(n.rel) && !n.id && n.hash === this.state.files[pid].localHash)
      if (f) {
        matched.set(pid, f)
        claimed.add(f.rel)
      }
    }
    // untracked notes carrying the id of a live server page (e.g. a vault made by `inklingctl pull`)
    const adopted = new Map<string, LocalFile>()
    const newLocal: LocalFile[] = []
    for (const n of notes) {
      if (claimed.has(n.rel)) continue
      if (n.id && serverById.get(n.id)?.kind === 'doc' && !this.state.files[n.id] && !adopted.has(n.id)) {
        adopted.set(n.id, n)
        claimed.add(n.rel)
      } else newLocal.push(n)
    }

    // --- pages a cut-off run created but never recorded (docs/adr/2166-*) --------
    // Their ids follow from the retry keys saved before the creates went out.
    const resumed = new Map<string, LocalFile>()
    const abandoned: string[] = []
    for (const [key, clientKey] of Object.entries(this.state.pending ?? {})) {
      if (key.startsWith('dir:')) continue
      const pid = syncCreateId(this.workspaceId, clientKey)
      if (serverById.get(pid)?.kind !== 'doc' || this.state.files[pid] || adopted.has(pid)) continue
      const i = newLocal.findIndex((n) => n.rel === key)
      if (i >= 0) {
        resumed.set(pid, newLocal[i])
        newLocal.splice(i, 1)
      } else abandoned.push(pid) // the note is gone since: the page it made goes to the trash
    }

    // --- decide which server versions to fetch ---------------------------------
    const need = new Set<string>()
    for (const pid of tracked) {
      const st = this.state.files[pid]
      const sp = serverById.get(pid)
      if (!sp || sp.kind !== 'doc') continue
      if (sp.revision && sp.revision !== st.revision) {
        if (sp.contentHash && sp.contentHash === st.serverHash) st.revision = sp.revision
        else need.add(pid)
      }
    }
    const newServer = changes.pages.filter((p) => p.kind === 'doc' && !this.state.files[p.id])
    for (const p of newServer) need.add(p.id)
    const fetched = need.size ? await this.api.read([...need]) : new Map<string, PageMarkdown>()
    const serverChanged = (pid: string): PageMarkdown | null => {
      const got = fetched.get(pid)
      if (!got) return null
      const st = this.state.files[pid]
      if (st && got.contentHash === st.serverHash) {
        st.revision = got.revision
        return null
      }
      return got
    }

    // --- directories renamed or moved in the vault (docs/adr/2167-*) ------------
    // A directory the last run left whose tracked notes all reappear under one new directory (same
    // relative paths) was renamed or moved as a whole: a folder page follows it (same page, so its
    // locks, grants and comments stay); a note's sub-page directory follows when the note moved the
    // same way. Outer directories first; inner ones then already sit where they should.
    const depth = (p: string) => p.split('/').length
    const serverDirOf = () => new Map([...this.dirIndex].map(([d, id]) => [id, d]))
    for (const [pid, oldDir] of Object.entries(prevDirs).sort((a, b) => depth(a[1]) - depth(b[1]))) {
      const sp = serverById.get(pid)
      if (!sp || localDirs.has(oldDir) || serverDirOf().get(pid) !== oldDir) continue
      let newDir: string | undefined
      let consistent = true
      for (const fpid of tracked) {
        const st = this.state.files[fpid]
        const local = matched.get(fpid)
        if (!local || !st.path.startsWith(`${oldDir}/`)) continue
        const suffix = st.path.slice(oldDir.length)
        const nd = local.rel.endsWith(suffix) ? local.rel.slice(0, local.rel.length - suffix.length) : ''
        if (!nd || (newDir !== undefined && nd !== newDir)) {
          consistent = false
          break
        }
        newDir = nd
      }
      if (!consistent || newDir === undefined || this.dirIndex.has(newDir) || !localDirs.has(newDir)) continue
      if (sp.kind === 'folder') {
        const parentId = await this.ensureDir(posixDir(newDir))
        const title = newDir.slice(newDir.lastIndexOf('/') + 1)
        const body: { title?: string; parentId?: string | null } = {}
        if (title !== oldDir.slice(oldDir.lastIndexOf('/') + 1)) body.title = title
        if ((sp.parentId ?? null) !== parentId) body.parentId = parentId
        if (!this.dry && !String(parentId).startsWith('dry:') && Object.keys(body).length) {
          try {
            await this.api.patch(pid, body)
          } catch (err) {
            if (this.refused(err, `${newDir}/`)) continue
            throw err
          }
        }
        this.note('rename-server', `${newDir}/`, `was ${oldDir}/`)
      } else if (sp.kind !== 'doc' || matched.get(pid)?.rel !== `${newDir}.md`) continue
      this.remapDir(oldDir, newDir, serverPaths)
    }

    // --- pass 1: renames / moves (before content, so uploads of notes whose links Obsidian
    //     rewrote to a new title resolve against the already-renamed page) ----------------
    for (const pid of tracked) {
      const st = this.state.files[pid]
      const local = matched.get(pid)
      const sp = serverById.get(pid)
      if (!local || !sp || sp.kind !== 'doc') continue
      if (st.conflict && (await readBytes(this.root, st.conflict))) continue
      const serverPath = serverPaths.get(pid) ?? st.path
      if (local.rel !== st.path) {
        // moved/renamed in the vault → rename/move the page. The title changes only when the file
        // name did: a page whose title has characters a file name cannot hold keeps it on a move.
        const title = baseTitle(local.rel)
        try {
          const parentId = await this.ensureDir(posixDir(local.rel))
          const body: { title?: string; parentId?: string | null } = {}
          if (title !== baseTitle(st.path)) body.title = title
          if ((sp.parentId ?? null) !== parentId) body.parentId = parentId
          if (!this.dry && !String(parentId).startsWith('dry:') && Object.keys(body).length) {
            await this.api.patch(pid, body)
          }
        } catch (err) {
          if (this.refused(err, local.rel)) continue
          throw err
        }
        this.note('rename-server', local.rel, `was ${st.path}`)
        st.path = local.rel
      } else if (serverPath !== st.path) {
        if (this.taken.has(serverPath)) {
          this.note('keep', st.path, `renamed on server to ${serverPath}, but that path is taken`)
        } else {
          // (the merge base is keyed by page id, so only the note itself moves)
          if (!this.dry) await moveFile(this.root, st.path, serverPath)
          this.taken.delete(st.path)
          this.taken.add(serverPath)
          matched.set(pid, { ...local, rel: serverPath })
          this.note('move-local', serverPath, `was ${st.path}`)
          st.path = serverPath
        }
      }
    }

    // --- pass 2: content ---------------------------------------------------------
    const orphaned: LocalFile[] = []
    const toTrash: string[] = []
    for (const pid of tracked.sort((a, b) => this.state.files[a].path.localeCompare(this.state.files[b].path))) {
      const st = this.state.files[pid]
      const local = matched.get(pid) ?? null
      const sp = serverById.get(pid)
      const rel = local?.rel ?? st.path

      if (st.conflict) {
        if (await readBytes(this.root, st.conflict)) {
          this.note('skip', rel, `unresolved conflict — edit the note, then delete ${st.conflict}`)
          continue
        }
        delete st.conflict // resolved: the local file wins against the recorded server base
      }

      // server side gone (trashed, purged or no longer visible)
      if (!sp || sp.kind !== 'doc') {
        if (!local) {
          delete this.state.files[pid]
          continue
        }
        if (local.hash === st.localHash) {
          if (!this.dry) {
            await moveFile(this.root, local.rel, `${STATE_DIR}/trash/${localDateStamp()}/${local.rel}`)
            await removeFile(this.root, this.baseRel(pid))
          }
          delete this.state.files[pid]
          this.note('trash-local', local.rel, 'deleted on server; moved to .inkling/trash')
        } else {
          delete this.state.files[pid]
          orphaned.push(local)
          this.note('keep', local.rel, 'deleted on server but edited locally — re-creating it')
        }
        continue
      }

      const remote = serverChanged(pid)
      // local side gone
      if (!local) {
        if (remote) {
          await this.download(pid, serverPaths.get(pid) ?? st.path, remote)
          this.note('download', st.path, 'deleted locally but changed on server — restored')
          continue
        }
        toTrash.push(pid) // below, sub-pages before their page
        continue
      }

      const localChanged = local.hash !== st.localHash
      try {
        if (localChanged && remote) {
          // Our own write whose answer was lost (a cut-off run) looks like this too. The server takes
          // a write with a stale revision only when the page already holds exactly this note
          // (docs/adr/2166-*); otherwise it answers 412 with its version, which is merged as before.
          try {
            await this.upload(pid, rel, local.text, st.revision)
            this.note('upload', rel)
          } catch (err) {
            if (!(err instanceof RevisionMismatch)) throw err
            await this.mergeBoth(pid, rel, local.text, err.current)
          }
        } else if (localChanged) {
          try {
            await this.upload(pid, rel, local.text, st.revision)
            this.note('upload', rel)
          } catch (err) {
            if (!(err instanceof RevisionMismatch)) throw err
            await this.mergeBoth(pid, rel, local.text, err.current)
          }
        } else if (remote) {
          await this.download(pid, rel, remote)
          this.note('download', rel)
        }
      } catch (err) {
        if (!this.refused(err, rel)) throw err
      }
    }

    // --- deletes in the vault: deepest first, so a page deleted with its sub-pages folder is a leaf
    //     by the time it goes to the trash -----------------------------------------------------
    for (const pid of toTrash.sort((a, b) => depth(this.state.files[b].path) - depth(this.state.files[a].path))) {
      const st = this.state.files[pid]
      let res: Awaited<ReturnType<SyncApi['trash']>>
      try {
        res = this.dry ? 'ok' : await this.api.trash(pid, st.revision)
      } catch (err) {
        if (this.refused(err, st.path)) continue
        throw err
      }
      if (res === 'ok' || res === 'gone') {
        delete this.state.files[pid]
        if (!this.dry) await removeFile(this.root, this.baseRel(pid))
        this.note('trash-server', st.path)
      } else {
        const cur = (await this.api.read([pid])).get(pid)
        if (cur) await this.download(pid, st.path, cur)
        this.note('download', st.path, res === 'has-children' ? 'has sub-pages on server — restored' : 'changed on server — restored')
      }
    }

    // --- adopted notes (id known to the server, no sync base) -------------------
    for (const [pid, f] of adopted) {
      const remote = fetched.get(pid)
      if (!remote) continue
      const serverLocal = await this.toLocal(remote.markdown, f.rel)
      if (serverLocal === f.text || stripFm(serverLocal) === stripFm(f.text)) {
        if (serverLocal !== f.text && !this.dry) await writeAtomic(this.root, f.rel, serverLocal)
        await this.record(pid, f.rel, serverLocal, remote)
        this.note('keep', f.rel, 'linked to existing page')
      } else {
        // no common ancestor — treat as a conflict against an empty base
        this.state.files[pid] = { path: f.rel, localHash: '', serverHash: '', revision: '' }
        await this.mergeBoth(pid, f.rel, f.text, remote)
      }
    }

    // --- pages a cut-off run created whose note is gone since ----------------------
    for (const pid of abandoned) {
      const res = this.dry ? 'ok' : await this.api.trash(pid, fetched.get(pid)?.revision ?? null).catch(() => 'changed' as const)
      if (res === 'ok' || res === 'gone') this.note('trash-server', serverPaths.get(pid) ?? pid, 'created by an interrupted run; the note is gone')
    }

    // --- new server pages -------------------------------------------------------
    for (const p of newServer) {
      if (adopted.has(p.id) || this.state.files[p.id] || resumed.has(p.id) || abandoned.includes(p.id)) continue
      const remote = fetched.get(p.id)
      if (!remote) continue
      let rel = serverPaths.get(p.id) ?? `${sanitizeName(p.title)}.md`
      const existing = localByPath.get(rel)
      if (existing && !claimed.has(existing.rel)) {
        const serverLocal = await this.toLocal(remote.markdown, rel)
        if (stripFm(serverLocal) === stripFm(existing.text)) {
          // same note created on both sides — link instead of duplicating
          claimed.add(existing.rel)
          const idx = newLocal.indexOf(existing)
          if (idx >= 0) newLocal.splice(idx, 1)
          if (!this.dry) await writeAtomic(this.root, rel, serverLocal)
          await this.record(p.id, rel, serverLocal, remote)
          this.note('keep', rel, 'same note on both sides — linked')
          continue
        }
      }
      if (this.taken.has(rel)) rel = uniquePath((x) => this.taken.has(x), posixDir(rel), baseTitle(rel))
      this.taken.add(rel)
      await this.download(p.id, rel, remote)
      this.note('create-local', rel)
    }

    // --- new local notes --------------------------------------------------------
    // Notes with attachments or [[links]] are created empty first and filled in a second
    // phase: uploads need the page id, and links must resolve to notes created in this run.
    // Every create carries a retry key saved beforehand, so a run cut off after the server made
    // the page finds that page again instead of making a second one (docs/adr/2166-*).
    const deferred: { f: LocalFile; pid: string; revision: string }[] = []
    for (const [pid, f] of resumed) {
      const revision = fetched.get(pid)?.revision ?? ''
      this.state.files[pid] = { path: f.rel, localHash: '', serverHash: '', revision }
      deferred.push({ f: { ...f, text: stripForeignId(f.text) }, pid, revision })
      for (const [k, v] of Object.entries(this.state.pending ?? {})) if (syncCreateId(this.workspaceId, v) === pid) delete this.state.pending![k]
    }
    const creating = [...newLocal, ...orphaned]
    if (!this.dry && creating.length) {
      this.state.pending ??= {}
      let added = false
      for (const f of creating) {
        if (this.state.pending[f.rel]) continue
        this.state.pending[f.rel] = randomUUID()
        added = true
      }
      if (added) await this.saveState()
    }
    for (const f of creating) {
      if (this.dry) {
        await this.ensureDir(posixDir(f.rel))
        this.note('create-server', f.rel)
        continue
      }
      const title = baseTitle(f.rel)
      const text = stripForeignId(f.text)
      const twoPhase = text.includes('[[') || /\]\((?!<?(?:https?:|\/files\/))(?:<[^<>\n]+>|[^()\s]+)\)/i.test(text)
      const clientKey = this.state.pending?.[f.rel]
      try {
        const parentId = await this.ensureDir(posixDir(f.rel))
        const realParent = parentId && !parentId.startsWith('dry:') ? parentId : null
        const r = await this.api.create({ parentId: realParent, title, kind: 'doc', clientKey, ...(twoPhase ? {} : { markdown: text }) })
        if (twoPhase || r.replayed) {
          // recorded now, filled below: a run cut off before the fill uploads the note next time
          this.state.files[r.page.id] = { path: f.rel, localHash: '', serverHash: r.contentHash ?? '', revision: r.revision ?? '' }
          deferred.push({ f: { ...f, text }, pid: r.page.id, revision: r.revision ?? '' })
        } else {
          const result = r as unknown as PageMarkdown
          const keep = this.keptKeys(f.rel, result)
          const canonical = keepFrontmatterKeys(await this.toLocal(result.markdown, f.rel), text, keep)
          await writeAtomic(this.root, f.rel, canonical)
          await this.record(r.page.id, f.rel, canonical, result, keep)
        }
      } catch (err) {
        if (this.refused(err, f.rel)) continue
        throw err
      }
      if (clientKey) delete this.state.pending![f.rel]
      this.note('create-server', f.rel)
    }
    for (const d of deferred) {
      try {
        await this.upload(d.pid, d.f.rel, d.f.text, d.revision)
      } catch (err) {
        if (err instanceof RevisionMismatch) await this.mergeBoth(d.pid, d.f.rel, d.f.text, err.current)
        else if (!this.refused(err, d.f.rel)) throw err
      }
    }

    // --- folder pages whose directory is gone from the vault (docs/adr/2167-*) -------------------
    // Deleted with its notes, or emptied by moves: the folder page goes to the trash too, deepest
    // first. The server keeps it (409) while it still holds pages, then the directory comes back.
    // Only a folder that held notes at the end of the last completed run: an empty directory can go
    // missing without anyone deleting it (a copy of the vault made by git or a zip); it is re-made.
    const serverDir = serverDirOf()
    const goneFolders = Object.entries(prevDirs)
      .filter(([pid, dir]) => dirsKnown && serverById.get(pid)?.kind === 'folder' && serverDir.get(pid) === dir)
      .filter(([pid]) => prevFilled.has(pid))
      .sort((a, b) => depth(b[1]) - depth(a[1]))
    for (const [pid, dir] of goneFolders) {
      if (await stat(vaultPath(this.root, dir)).catch(() => null)) continue
      let res: Awaited<ReturnType<SyncApi['trash']>> = 'ok'
      try {
        if (!this.dry) res = await this.api.trash(pid, null)
      } catch (err) {
        if (this.refused(err, `${dir}/`)) continue
        throw err
      }
      if (res === 'ok' || res === 'gone') {
        delete this.state.folders[pid]
        this.dirIndex.delete(dir)
        this.note('trash-server', `${dir}/`, 'folder')
      } else this.note('keep', `${dir}/`, 'folder still holds pages on the server — directory restored')
    }

    // --- folders: make sure server folders exist as directories -----------------
    if (!this.dry) {
      for (const dir of Object.values(this.state.folders)) await mkdir(vaultPath(this.root, dir), { recursive: true })
    }

    // --- directories this run left empty behind (moved, renamed or trashed pages) --------------
    const nowDirs = new Map([...this.dirIndex].filter(([, id]) => !id.startsWith('dry:')).map(([d, id]) => [id, d]))
    if (!this.dry) {
      const keep = new Set(nowDirs.values())
      const left = Object.values(prevDirs).filter((d) => !keep.has(d)).sort((a, b) => depth(b) - depth(a))
      for (const d of left) await rmdir(vaultPath(this.root, d)).catch(() => undefined) // only if empty
    }

    this.state.dirs = Object.fromEntries(nowDirs)
    const holding = new Set<string>()
    for (const f of Object.values(this.state.files)) for (let d = posixDir(f.path); d && !holding.has(d); d = posixDir(d)) holding.add(d)
    this.state.filled = [...nowDirs].filter(([, d]) => holding.has(d)).map(([id]) => id)
    this.state.pending = {}
    this.state.cursor = changes.cursor
    await this.saveState()
    this.printSummary()
  }

  /** A vault directory renamed/moved as a whole: later lookups use the new path. */
  private remapDir(from: string, to: string, serverPaths: Map<string, string>): void {
    const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p)
    this.dirIndex = new Map([...this.dirIndex].map(([d, id]) => [move(d), id]))
    for (const [id, d] of Object.entries(this.state.folders)) this.state.folders[id] = move(d)
    for (const [id, p] of serverPaths) serverPaths.set(id, move(p))
  }

  private printSummary(): void {
    const counts = new Map<string, number>()
    for (const e of this.log) {
      counts.set(e.action, (counts.get(e.action) ?? 0) + 1)
      process.stdout.write(`${e.action.padEnd(14)} ${e.path}${e.detail ? `  (${e.detail})` : ''}\n`)
    }
    const parts = [...counts.entries()].map(([k, v]) => `${k}=${v}`)
    process.stdout.write(`${this.dry ? '[dry run] ' : ''}sync done: ${parts.length ? parts.join(' ') : 'nothing to do'}\n`)
    if (this.conflicts.length) {
      process.stdout.write(`\n${this.conflicts.length} conflict(s) — your note was left untouched; resolve, then delete the conflict copy:\n`)
      for (const c of this.conflicts) process.stdout.write(`  ${c}\n`)
    }
    for (const n of this.notices) process.stdout.write(`note: ${n}\n`)
  }
}

/** Frontmatter-insensitive comparison helper. */
function stripFm(text: string): string {
  const t = text.replace(/\r\n?/g, '\n')
  if (!t.startsWith('---\n')) return t.trim()
  const end = t.indexOf('\n---', 3)
  if (end < 0) return t.trim()
  const nl = t.indexOf('\n', end + 4)
  return (nl < 0 ? '' : t.slice(nl + 1)).trim()
}

/** A brand-new local note must not claim another page's id (copied frontmatter). */
function stripForeignId(text: string): string {
  return text.replace(/^(---\r?\n(?:(?!---)[^\n]*\n)*?)inkling-id:[^\n]*\n/, '$1')
}
