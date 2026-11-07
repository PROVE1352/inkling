import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { boolFlag, strFlag } from '../args'
import { listWorkspaces, selectWorkspace } from '../api'
import { loadConfig } from '../config'
import { joinLines, merge3 } from '../sync/diff3'
import type { PageMarkdown, SyncPage } from '../sync/syncApi'
import { RevisionMismatch, SyncApi } from '../sync/syncApi'
import {
  ASSET_DIR,
  baseTitle,
  extForMime,
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
 * docs/adr/0200-vault-sync-protocol.md, 0202-vault-sync-merge-and-deletes.md.
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
}

interface SyncState {
  version: 1
  server: string
  workspaceId: string
  cursor: string | null
  files: Record<string, FileState>
  /** folder pages (and doc pages with children) → vault directory */
  folders: Record<string, string>
  /** attachment fileId → vault path + sha256 */
  assets: Record<string, { path: string; hash: string }>
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
const LINK_TARGET_RE = /\]\(([^()\s]+)\)/g
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
  if (!config.cookie) throw new Error('Not logged in — run `inklingctl login` first')
  const server = strFlag(flags, 'server') ?? config.server
  const ws = selectWorkspace(await listWorkspaces(server, config.cookie), strFlag(flags, 'workspace'))
  const run = new SyncRun(root, new SyncApi(server, config.cookie, ws.id), server, ws.id, boolFlag(flags, 'dry-run'))
  await run.run()
}

class SyncRun {
  private state!: SyncState
  private log: { action: Action; path: string; detail?: string }[] = []
  private conflicts: string[] = []
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
      if (!mime) return null
      const data = await readBytes(this.root, targetRel)
      if (!data) return null
      const hash = sha256(data)
      // dedupe by content hash: identical bytes reuse the uploaded file
      for (const [id, a] of Object.entries(this.state.assets)) if (a.hash === hash) return id
      if (this.dry) return null
      const id = await this.api.upload(pageId, path.posix.basename(targetRel), mime, data)
      const rel = `${ASSET_DIR}/${id}${extForMime(mime)}`
      await writeAtomic(this.root, rel, data)
      this.state.assets[id] = { path: rel, hash }
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
    const parentId = await this.ensureDir(posixDir(dir))
    const title = dir.slice(dir.lastIndexOf('/') + 1)
    if (this.dry) {
      this.dirIndex.set(dir, `dry:${dir}`)
      return `dry:${dir}`
    }
    const r = await this.api.create({ parentId, title, kind: 'folder' })
    this.dirIndex.set(dir, r.page.id)
    this.state.folders[r.page.id] = dir
    this.note('create-server', `${dir}/`, 'folder')
    return r.page.id
  }

  // ---------------------------------------------------------------------------
  // page operations
  // ---------------------------------------------------------------------------

  private async record(pid: string, rel: string, localText: string, server: PageMarkdown): Promise<void> {
    this.state.files[pid] = {
      path: rel,
      localHash: sha256(Buffer.from(localText, 'utf8')),
      serverHash: server.contentHash,
      revision: server.revision,
    }
    if (!this.dry) await writeAtomic(this.root, this.baseRel(pid), localText)
  }

  /** Writes the server version to the vault and records it as the new base. */
  private async download(pid: string, rel: string, server: PageMarkdown): Promise<void> {
    const local = await this.toLocal(server.markdown, rel)
    if (!this.dry) await writeAtomic(this.root, rel, local)
    await this.record(pid, rel, local, server)
  }

  /**
   * Uploads `localText` (already merged if needed). After a successful write the vault file is
   * replaced by the server's canonical rendering — unless the user edited it meanwhile.
   */
  private async upload(pid: string, rel: string, localText: string, expectedRevision: string): Promise<PageMarkdown> {
    const serverMd = await this.toServer(localText, rel, pid)
    if (this.dry) return { revision: expectedRevision, contentHash: '', markdown: serverMd }
    const result = await this.api.write(pid, serverMd, expectedRevision)
    const canonical = await this.toLocal(result.markdown, rel)
    const onDisk = await readText(this.root, rel)
    if (onDisk === localText || onDisk === null) {
      await writeAtomic(this.root, rel, canonical)
      await this.record(pid, rel, canonical, result)
    } else {
      // edited during sync: keep the user's bytes; next run sees them as a local change
      await this.record(pid, rel, localText, result)
    }
    return result
  }

  private async mergeBoth(pid: string, rel: string, localText: string, server: PageMarkdown): Promise<void> {
    const serverLocal = await this.toLocal(server.markdown, rel)
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
    this.state.folders = {}
    const serverPaths = this.computeServerPaths(changes.pages)
    const { notes } = await scanVault(this.root)
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
        // moved/renamed in the vault → rename/move the page
        const title = baseTitle(local.rel)
        const parentId = await this.ensureDir(posixDir(local.rel))
        const sameParent = (sp.parentId ?? null) === parentId
        if (!this.dry && !String(parentId).startsWith('dry:')) {
          await this.api.patch(pid, sameParent ? { title } : { title, parentId })
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
        const res = this.dry ? 'ok' : await this.api.trash(pid, st.revision)
        if (res === 'ok' || res === 'gone') {
          delete this.state.files[pid]
          if (!this.dry) await removeFile(this.root, this.baseRel(pid))
          this.note('trash-server', st.path)
        } else {
          const cur = (await this.api.read([pid])).get(pid)
          if (cur) await this.download(pid, st.path, cur)
          this.note('download', st.path, res === 'has-children' ? 'has sub-pages on server — restored' : 'changed on server — restored')
        }
        continue
      }

      const localChanged = local.hash !== st.localHash
      if (localChanged && remote) {
        await this.mergeBoth(pid, rel, local.text, remote)
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

    // --- new server pages -------------------------------------------------------
    for (const p of newServer) {
      if (adopted.has(p.id) || this.state.files[p.id]) continue
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
    const deferred: { f: LocalFile; pid: string; revision: string }[] = []
    for (const f of [...newLocal, ...orphaned]) {
      const parentId = await this.ensureDir(posixDir(f.rel))
      const title = baseTitle(f.rel)
      if (this.dry) {
        this.note('create-server', f.rel)
        continue
      }
      const realParent = parentId && !parentId.startsWith('dry:') ? parentId : null
      const text = stripForeignId(f.text)
      const twoPhase = text.includes('[[') || /\]\((?!https?:|\/files\/)[^()\s]+\)/i.test(text)
      if (!twoPhase) {
        const r = await this.api.create({ parentId: realParent, title, kind: 'doc', markdown: text })
        const result = r as unknown as PageMarkdown
        const canonical = await this.toLocal(result.markdown, f.rel)
        await writeAtomic(this.root, f.rel, canonical)
        await this.record(r.page.id, f.rel, canonical, result)
      } else {
        const r = await this.api.create({ parentId: realParent, title, kind: 'doc' })
        deferred.push({ f: { ...f, text }, pid: r.page.id, revision: r.revision ?? '' })
      }
      this.note('create-server', f.rel)
    }
    for (const d of deferred) await this.upload(d.pid, d.f.rel, d.f.text, d.revision)

    // --- folders: make sure server folders exist as directories -----------------
    if (!this.dry) {
      for (const dir of Object.values(this.state.folders)) await mkdir(vaultPath(this.root, dir), { recursive: true })
    }

    this.state.cursor = changes.cursor
    await this.saveState()
    this.printSummary()
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
