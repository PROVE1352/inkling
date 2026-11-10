import type { ClipMode } from '@inkling/shared'

// Where the clipper saves, kept in this browser (docs/adr/2263-*): the last location used, an
// optional default the person picked ("Always start here"), and the last save mode. Storage may be
// missing or throw (private windows, blocked site data); the clipper then starts at the first workspace.

export interface ClipLocation {
  workspaceId: string
  parentId: string | null
}

const LAST = 'inkling.clip.last'
const DEFAULT = 'inkling.clip.default'
const MODE = 'inkling.clip.mode'
/** The /clip query kept across the sign-in when it is too long for ?next= (sessionStorage). */
export const CLIP_STASH = 'inkling.clip.stash'

function read(key: string): ClipLocation | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ClipLocation>
    if (typeof v.workspaceId !== 'string') return null
    return { workspaceId: v.workspaceId, parentId: typeof v.parentId === 'string' ? v.parentId : null }
  } catch {
    return null
  }
}

function write(key: string, v: ClipLocation | null): void {
  try {
    if (v) window.localStorage.setItem(key, JSON.stringify(v))
    else window.localStorage.removeItem(key)
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

export const readLastClipLocation = () => read(LAST)
export const writeLastClipLocation = (v: ClipLocation) => write(LAST, v)
export const readDefaultClipLocation = () => read(DEFAULT)
export const writeDefaultClipLocation = (v: ClipLocation | null) => write(DEFAULT, v)

export function readClipMode(): ClipMode {
  try {
    return window.localStorage.getItem(MODE) === 'article' ? 'article' : 'link'
  } catch {
    return 'link'
  }
}

export function writeClipMode(mode: ClipMode): void {
  try {
    window.localStorage.setItem(MODE, mode)
  } catch {
    /* ignore */
  }
}
