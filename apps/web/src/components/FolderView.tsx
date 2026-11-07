import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { PageMetaDTO } from '@inkling/shared'
import { useCreatePage, usePages } from '../api'
import { pageIcon } from '../lib/pageIcon'
import { relativeTime } from '../lib/time'
import { FolderPlusIcon, PlusIcon } from './Icons'
import { Spinner } from './Spinner'
import { useT } from '../i18n'

// Child list shown when a folder page is opened via a deep link (/w/:ws/p/:id).
export function FolderView({ wsId, page }: { wsId: string; page: PageMetaDTO }) {
  const navigate = useNavigate()
  const t = useT()
  const pages = usePages(wsId)
  const createPage = useCreatePage(wsId)

  const children = useMemo(
    () =>
      (pages.data ?? [])
        .filter((p) => p.parentId === page.id)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [pages.data, page.id],
  )

  const create = (kind: 'doc' | 'folder') => {
    createPage.mutate(
      { workspaceId: wsId, parentId: page.id, kind },
      {
        onSuccess: (created) => {
          if (kind === 'doc') navigate(`/w/${wsId}/p/${created.id}`)
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <h1 className="mb-1 flex items-center gap-2 text-3xl font-bold text-ink">
        <span className="text-[28px] leading-none">{pageIcon(page, true)}</span>
        {page.title || t('common.untitled')}
      </h1>
      <p className="mb-6 text-sm text-sub">{t('folder.summary', { count: children.length })}</p>

      <div className="mb-5 flex gap-2">
        <button
          type="button"
          onClick={() => create('doc')}
          disabled={createPage.isPending}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          <PlusIcon size={15} /> {t('folder.newPage')}
        </button>
        <button
          type="button"
          onClick={() => create('folder')}
          disabled={createPage.isPending}
          className="flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
        >
          <FolderPlusIcon size={15} /> {t('folder.newFolder')}
        </button>
      </div>

      {pages.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner size={20} />
        </div>
      ) : children.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-sub">
          {t('folder.empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {children.map((child) => (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => navigate(`/w/${wsId}/p/${child.id}`)}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-hover"
              >
                <span className="shrink-0 text-[17px] leading-none">
                  {pageIcon(child)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {child.title || t('common.untitled')}
                </span>
                <span className="shrink-0 text-xs text-sub">
                  {relativeTime(child.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
