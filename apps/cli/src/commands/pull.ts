import JSZip from 'jszip'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { boolFlag, strFlag } from '../args'
import { exportWorkspaceZip, listWorkspaces, selectWorkspace } from '../api'
import { credentialOf, DEFAULT_SUBDIR, loadConfig, saveConfig } from '../config'
import { ApiError } from '../http'
import { isInside, resolveTarget } from '../paths'

interface ZipEntry {
  /** Relative path inside the zip (always '/'-separated). */
  name: string
  data: Buffer
}

interface Classified {
  pages: number
  assets: number
  others: number
}

function classify(entries: ZipEntry[]): Classified {
  let pages = 0
  let assets = 0
  let others = 0
  for (const e of entries) {
    if (e.name.startsWith('assets/')) assets++
    else if (e.name.endsWith('.md') || e.name.endsWith('.canvas')) pages++
    else others++
  }
  return { pages, assets, others }
}

/** zip buffer → list of file entries (directories skipped, zip-slip guarded). */
async function readZipEntries(buffer: Buffer, stagingRef: string): Promise<ZipEntry[]> {
  const zip = await JSZip.loadAsync(buffer)
  const entries: ZipEntry[] = []
  const names = Object.keys(zip.files)
  for (const name of names) {
    const file = zip.files[name]
    if (file.dir) continue
    // zip-slip: skip paths that escape the staging directory.
    const dest = path.join(stagingRef, name)
    if (!isInside(stagingRef, dest)) {
      process.stderr.write(`Warning: skipping unsafe path: ${name}\n`)
      continue
    }
    const data = await file.async('nodebuffer')
    entries.push({ name, data })
  }
  // sort paths for stable output
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Number of files in a directory (recursive) — used to show the dry-run deletion size. */
async function countFiles(dir: string): Promise<number> {
  let n = 0
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const it of items) {
    if (it.isDirectory()) n += await countFiles(path.join(dir, it.name))
    else n++
  }
  return n
}

/** inklingctl pull [--workspace X] [--vault P] [--subdir S] [--dry-run] */
export async function cmdPull(flags: Record<string, string | boolean>): Promise<void> {
  const config = await loadConfig()
  const auth = credentialOf(config)
  if (!auth) {
    throw new Error('Not logged in. Run `inklingctl login` first, or set INKLING_TOKEN')
  }

  const vault = strFlag(flags, 'vault') ?? config.vault
  if (!vault) {
    throw new Error('A vault path is required. Pass --vault <path> or save one in the config')
  }
  const subdir = strFlag(flags, 'subdir') ?? config.subdir ?? DEFAULT_SUBDIR
  const dryRun = boolFlag(flags, 'dry-run')

  // 1) Pick the workspace
  let workspaces
  try {
    workspaces = await listWorkspaces(config.server, auth)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw new Error('Session expired or token revoked. Run `inklingctl login` again (or check INKLING_TOKEN)')
    }
    throw err
  }
  const ws = selectWorkspace(workspaces, strFlag(flags, 'workspace'))

  // 2) Compute the target directory + safety checks (inside the vault, no symlink escapes)
  const { vaultReal, subdirAbs, targetDir, safeName } = await resolveTarget(vault, subdir, ws.name)

  process.stderr.write(`Workspace: ${ws.name} (${ws.id})\n`)
  process.stderr.write(`Vault: ${vaultReal}\n`)
  process.stderr.write(`Target: ${targetDir}\n`)

  // 3) Download the export zip
  const buffer = await exportWorkspaceZip(config.server, auth, ws.id)

  // The staging path is a hidden name under subdir (always inside the vault).
  const token = randomBytes(6).toString('hex')
  const stagingDir = path.join(subdirAbs, `.${safeName}.tmp-${token}`)
  const oldDir = path.join(subdirAbs, `.${safeName}.old-${token}`)

  const entries = await readZipEntries(buffer, stagingDir)
  const counts = classify(entries)

  // 4) DRY-RUN: print only the delete/write plan
  if (dryRun) {
    const existing = await countFiles(targetDir)
    process.stdout.write('\n[DRY-RUN] Showing the plan only; nothing is changed\n')
    if (existing > 0) {
      process.stdout.write(`Will delete: ${targetDir} (${existing} existing files)\n`)
    } else {
      process.stdout.write(`Will delete: nothing (target directory does not exist yet)\n`)
    }
    process.stdout.write(`Will write (${entries.length} files):\n`)
    for (const e of entries) {
      process.stdout.write(`  + ${path.join(safeName, e.name)}\n`)
    }
    process.stdout.write(
      `\nSummary: ${counts.pages} pages, ${counts.assets} assets` +
        (counts.others > 0 ? `, ${counts.others} other` : '') +
        '\n',
    )
    process.stdout.write('Other files in the vault are left untouched\n')
    return
  }

  // 5) Real replace: write to staging first → atomic swap → remove the old directory
  await mkdir(subdirAbs, { recursive: true })
  // clean up leftover staging (from an earlier failed run)
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  try {
    for (const e of entries) {
      const dest = path.join(stagingDir, e.name)
      // double safety: never write outside staging
      if (!isInside(stagingDir, dest)) continue
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, e.data)
    }

    // Swap: move an existing target to old, then staging becomes the target.
    let hadOld = false
    try {
      await rename(targetDir, oldDir)
      hadOld = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    try {
      await rename(stagingDir, targetDir)
    } catch (err) {
      // if the target is still there (race), force-remove it and retry
      await rm(targetDir, { recursive: true, force: true })
      await rename(stagingDir, targetDir)
      void err
    }

    if (hadOld) {
      await rm(oldDir, { recursive: true, force: true })
    }
  } catch (err) {
    // on failure, clean up staging (the target may have been kept as old, so try to restore it)
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  // 6) Remember vault/subdir in the config (for the next pull)
  if (config.vault !== vaultReal || config.subdir !== subdir) {
    await saveConfig({ ...config, vault: vaultReal, subdir })
  }

  process.stdout.write(`\nDone: ${targetDir}\n`)
  process.stdout.write(
    `Summary: ${counts.pages} pages, ${counts.assets} assets` +
      (counts.others > 0 ? `, ${counts.others} other` : '') +
      '\n',
  )
}
