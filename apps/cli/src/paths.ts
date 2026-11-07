import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

// Reserved characters stripped from file names (/ \ : * ? " < > |) — same rule as the server's sanitizeName.
const RESERVED_CHARS = /[/\\:*?"<>|]/g
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]', 'g')

/**
 * Workspace name → a single directory name. Strips path separators, reserved and control characters.
 * Dangerous names such as '.' and '..' become 'Untitled' (blocks escaping to the parent).
 */
export function sanitizeDirName(name: string): string {
  const cleaned = name.replace(RESERVED_CHARS, '').replace(CONTROL_CHARS, '').trim()
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return 'Untitled'
  return cleaned
}

/** Whether child is inside (or equal to) parent — checked on the path strings. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface ResolvedTarget {
  /** Absolute vault path, normalized with realpath. */
  vaultReal: string
  /** Absolute vault/subdir path (may not exist yet). */
  subdirAbs: string
  /** Absolute path of the directory to replace: vault/subdir/<ws>. */
  targetDir: string
  /** Directory name used on the file system (sanitized). */
  safeName: string
}

/**
 * Compute the pull target directory and strictly verify that it lies inside the vault.
 *  - vault must be an existing directory (symlinks resolved via realpath).
 *  - targetDir must be a real descendant of vault and cannot be the vault itself or the subdir root.
 *  - If targetDir already exists, re-check with realpath to catch symlink escapes.
 * Throws an error on failure.
 */
export async function resolveTarget(
  vault: string,
  subdir: string,
  workspaceName: string,
): Promise<ResolvedTarget> {
  // 1) Vault exists and is a directory + realpath normalization
  let vaultReal: string
  try {
    vaultReal = await realpath(path.resolve(vault))
  } catch {
    throw new Error(`Vault path does not exist: ${vault}`)
  }
  const vstat = await stat(vaultReal)
  if (!vstat.isDirectory()) {
    throw new Error(`Vault path is not a directory: ${vault}`)
  }

  // 2) Normalize subdir — it must be inside the vault (blocks escapes via '..' in subdir)
  const subdirAbs = path.resolve(vaultReal, subdir)
  if (!isInside(vaultReal, subdirAbs) || subdirAbs === vaultReal) {
    throw new Error(`subdir must be a valid path inside the vault: ${subdir}`)
  }

  // 3) Sanitize the workspace name, then compute the final target
  const safeName = sanitizeDirName(workspaceName)
  const targetDir = path.resolve(subdirAbs, safeName)

  // 4) Strict check: targetDir is a direct child of subdir, inside the vault, and not subdir/vault itself
  if (path.dirname(targetDir) !== subdirAbs) {
    throw new Error('Target path computed incorrectly (unexpected parent path)')
  }
  if (targetDir === subdirAbs || targetDir === vaultReal || !isInside(vaultReal, targetDir)) {
    throw new Error('Target path is not inside the vault — aborting for safety')
  }

  // 5) If it already exists, re-check for symlink escapes (reject if realpath lands outside the vault)
  try {
    const real = await realpath(targetDir)
    if (!isInside(vaultReal, real)) {
      throw new Error(
        `Target directory is a symlink pointing outside the vault (${real}) — refusing to delete it`,
      )
    }
  } catch (err) {
    // ENOENT (does not exist yet) is fine. Anything else propagates.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  return { vaultReal, subdirAbs, targetDir, safeName }
}
