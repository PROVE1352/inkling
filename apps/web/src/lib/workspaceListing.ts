import type { WorkspaceDTO, WorkspaceGroupDTO } from '@inkling/shared'

// A person's own arrangement of the workspace switcher (docs/adr/2300-*): ungrouped workspaces first
// (as before), then each group in the person's order, then "Archived". Inside each part: the stored
// position, then the server's order (created first) for workspaces never moved. Pure, so the
// switcher, the command palette and the start page agree on one order.

export interface ArrangedGroup {
  group: WorkspaceGroupDTO
  items: WorkspaceDTO[]
}

export interface ArrangedWorkspaces {
  ungrouped: WorkspaceDTO[]
  groups: ArrangedGroup[]
  archived: WorkspaceDTO[]
}

/** Stable order inside one part: stored position first, unpositioned after them in list order. */
function byPosition(list: WorkspaceDTO[], index: Map<string, number>): WorkspaceDTO[] {
  return [...list].sort((a, b) => {
    const pa = a.listing?.position
    const pb = b.listing?.position
    if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb
    if (pa !== undefined && pb === undefined) return -1
    if (pa === undefined && pb !== undefined) return 1
    return (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0)
  })
}

export function arrangeWorkspaces(workspaces: readonly WorkspaceDTO[], groups: readonly WorkspaceGroupDTO[]): ArrangedWorkspaces {
  const index = new Map(workspaces.map((w, i) => [w.id, i]))
  const known = new Set(groups.map((g) => g.id))
  const live = workspaces.filter((w) => !w.listing?.archived)
  // a group id we do not know (deleted in another tab) counts as no group
  const groupOf = (w: WorkspaceDTO) => (w.listing?.groupId && known.has(w.listing.groupId) ? w.listing.groupId : null)
  return {
    ungrouped: byPosition(live.filter((w) => !groupOf(w)), index),
    groups: groups.map((group) => ({ group, items: byPosition(live.filter((w) => groupOf(w) === group.id), index) })),
    // archived: by name, so a long tail of old contests is easy to scan
    archived: workspaces
      .filter((w) => w.listing?.archived)
      .sort((a, b) => a.name.localeCompare(b.name) || (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0)),
  }
}

/** Every workspace in switcher order (archived last): the command palette and "where to land". */
export function switcherOrder(workspaces: readonly WorkspaceDTO[], groups: readonly WorkspaceGroupDTO[]): WorkspaceDTO[] {
  const a = arrangeWorkspaces(workspaces, groups)
  return [...a.ungrouped, ...a.groups.flatMap((g) => g.items), ...a.archived]
}

/** True once the person made a group or archived something: only then does the switcher change shape. */
export function hasArrangement(workspaces: readonly WorkspaceDTO[], groups: readonly WorkspaceGroupDTO[]): boolean {
  return groups.length > 0 || workspaces.some((w) => w.listing?.archived)
}

/** The workspace to open when none is named: the last one used, else the first not archived. */
export function landingWorkspace(
  workspaces: readonly WorkspaceDTO[],
  groups: readonly WorkspaceGroupDTO[],
  last: string | null,
): WorkspaceDTO | undefined {
  const lastWs = workspaces.find((w) => w.id === last)
  if (lastWs) return lastWs
  const order = switcherOrder(workspaces, groups)
  return order.find((w) => !w.listing?.archived) ?? order[0]
}

/** Moves one id inside an ordered id list (↑/↓ and drag), returning a new list. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return [...ids]
  const next = [...ids]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
