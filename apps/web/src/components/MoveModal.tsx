import { useMemo, useState } from 'react'
import type { PageMetaDTO, PageScope, UpdatePageInput } from '@inkling/shared'
import { ApiError, usePages, useUpdatePage } from '../api'
import { PageIconGlyph } from './PageIconGlyph'
import { LockIcon, UsersIcon } from './Icons'
import { Modal } from './Modal'
import { buildTree, type TreeNode } from './PageTree'
import { useT } from '../i18n'

function collectSubtree(pages: PageMetaDTO[], rootId: string): Set<string> {
  const childrenOf = new Map<string | null, PageMetaDTO[]>()
  for (const p of pages) {
    const arr = childrenOf.get(p.parentId) ?? []
    arr.push(p)
    childrenOf.set(p.parentId, arr)
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    for (const c of childrenOf.get(id) ?? []) {
      if (!out.has(c.id)) {
        out.add(c.id)
        stack.push(c.id)
      }
    }
  }
  return out
}

function Row({
  node,
  depth,
  disabledIds,
  onPick,
}: {
  node: TreeNode
  depth: number
  disabledIds: Set<string>
  // Move under the target page — inherits the target's scope.
  onPick: (parentId: string, scope: PageScope) => void
}) {
  const t = useT()
  const disabled = disabledIds.has(node.page.id)
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onPick(node.page.id, node.page.scope)}
        style={{ paddingLeft: 8 + depth * 16 }}
        className="flex w-full items-center gap-2 py-1.5 pr-2 text-left text-sm text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="shrink-0 text-[15px] leading-none"><PageIconGlyph page={node.page} size={15} /></span>
        <span className="min-w-0 flex-1 truncate">{node.page.title || t('common.untitled')}</span>
      </button>
      {node.children.map((c) => (
        <Row
          key={c.page.id}
          node={c}
          depth={depth + 1}
          disabledIds={disabledIds}
          onPick={onPick}
        />
      ))}
    </div>
  )
}

// One section (shared/private): label + "to root" item + the root tree of that scope.
function SectionGroup({
  scope,
  label,
  locked,
  roots,
  disabledIds,
  onPickParent,
  onPickRoot,
}: {
  scope: PageScope
  label: string
  locked: boolean
  roots: TreeNode[]
  disabledIds: Set<string>
  onPickParent: (parentId: string, scope: PageScope) => void
  onPickRoot: (scope: PageScope) => void
}) {
  const t = useT()
  return (
    <div>
      <div className="flex items-center gap-1.5 border-b border-line bg-hover/40 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-sub">
        {locked ? <LockIcon size={11} /> : <UsersIcon size={11} />}
        {label}
      </div>
      <button
        type="button"
        onClick={() => onPickRoot(scope)}
        className="flex w-full items-center gap-2 border-b border-line px-2 py-1.5 text-left text-sm text-sub hover:bg-hover hover:text-ink"
      >
        <span className="text-[15px] leading-none">🏠</span> {t('move.toRoot', { section: label })}
      </button>
      {roots.map((node) => (
        <Row
          key={node.page.id}
          node={node}
          depth={0}
          disabledIds={disabledIds}
          onPick={onPickParent}
        />
      ))}
    </div>
  )
}

export function MoveModal({
  open,
  onClose,
  wsId,
  pageId,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  pageId: string
}) {
  const t = useT()
  const pages = usePages(wsId)
  const updatePage = useUpdatePage(wsId)
  const [error, setError] = useState<string | null>(null)

  const data = pages.data ?? []
  const tree = useMemo(() => buildTree(data), [data])
  const disabledIds = useMemo(() => collectSubtree(data, pageId), [data, pageId])
  const sharedRoots = useMemo(() => tree.filter((n) => n.page.scope !== 'private'), [tree])
  const privateRoots = useMemo(() => tree.filter((n) => n.page.scope === 'private'), [tree])
  const current = data.find((p) => p.id === pageId)

  const move = (parentId: string | null, scope: PageScope) => {
    setError(null)
    const input: UpdatePageInput = { parentId }
    // Crossing sections sends scope too (changes all descendants recursively). Same section → parentId only.
    if (current && current.scope !== scope) input.scope = scope
    updatePage.mutate(
      { id: pageId, input },
      {
        onSuccess: () => onClose(),
        onError: (err) =>
          setError(err instanceof ApiError ? err.message : t('move.failed')),
      },
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={t('move.title')}>
      <div className="max-h-[55dvh] overflow-y-auto rounded-md border border-line">
        <SectionGroup
          scope="shared"
          label={t('move.shared')}
          locked={false}
          roots={sharedRoots}
          disabledIds={disabledIds}
          onPickParent={(parentId, scope) => move(parentId, scope)}
          onPickRoot={(scope) => move(null, scope)}
        />
        <SectionGroup
          scope="private"
          label={t('move.private')}
          locked
          roots={privateRoots}
          disabledIds={disabledIds}
          onPickParent={(parentId, scope) => move(parentId, scope)}
          onPickRoot={(scope) => move(null, scope)}
        />
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <p className="mt-2 text-xs text-sub">
        {t('move.hint')}
      </p>
    </Modal>
  )
}
