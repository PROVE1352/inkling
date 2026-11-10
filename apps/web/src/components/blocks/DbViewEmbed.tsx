// Inline database view (docs/adr/2120-*): a page embed whose page is a collection shows one of the
// collection's views inside the document, like Notion's linked database view.
//
// Stored: the page embed's `pageId` (the collection) and `viewId` ('' = the first view). Never rows:
// each reader's rows come from GET /pages/:id/collection as for the database page itself (the same
// React Query key, so edits there and the 15 s poll refresh the block too).
//
// Read-only here: the views are rendered under CollectionReadOnlyContext (no cell edits, no drag,
// no new rows); a row opens its page and "Open database" goes to the full view. Editing inside the
// block would need CollectionView's whole handler set (props, options, titles, paste, templates),
// which belongs to the database page; the block reuses the views without forking that.
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { BlockNoteEditor } from '@blocknote/core'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import type { CollectionViewDTO, PageMetaDTO } from '@inkling/shared'
import { useCollection, useMembers, usePages } from '../../api'
import { membersWithPeople } from '../../lib/collection'
import { withFormulas } from '../../lib/formulas'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'
import { t, useT } from '../../i18n'
import { DatabaseIcon, ExternalLinkIcon, LockIcon } from '../Icons'
import { Spinner } from '../Spinner'
import { BoardView } from '../collection/BoardView'
import { CalendarView } from '../collection/CalendarView'
import { ChartView } from '../collection/ChartView'
import { GalleryView } from '../collection/GalleryView'
import { ListView } from '../collection/ListView'
import { TableView } from '../collection/TableView'
import { TimelineView } from '../collection/TimelineView'
import { CollectionReadOnlyContext } from '../collection/readOnlyContext'
import { CollectionRefsContext } from '../collection/refsContext'

type AnyEditor = BlockNoteEditor<any, any, any>

const noop = () => {}
const noOption = () => ''

/** "Not available": the same words for a private, trashed or unknown database (no existence oracle). */
export function DbViewUnavailable() {
  const tr = useT()
  return (
    <div contentEditable={false} className="flex items-start gap-2 px-3 py-2 text-xs text-sub" data-dbview-unavailable>
      <LockIcon size={13} className="mt-0.5 shrink-0" />
      <div>
        <div className="font-medium text-ink">{tr('dbView.unavailable')}</div>
        <div>{tr('dbView.unavailableHint')}</div>
      </div>
    </div>
  )
}

function ViewBody({ wsId, collectionId, view }: { wsId: string; collectionId: string; view: CollectionViewDTO }) {
  const collection = useCollection(collectionId)
  const members = useMembers(wsId)
  const raw = collection.data
  const fields = raw?.collection.fields ?? []
  const rows = useMemo(() => (raw ? withFormulas(raw.rows, raw.collection.fields) : []), [raw])
  // a page guest gets no member list; its response names the people in its rows (docs/adr/2146-*)
  const people = raw?.people
  const memberNames = useMemo(() => membersWithPeople(members.data, people), [members.data, people])
  if (!raw) return null
  const common = { view, fields, rows, wsId }
  switch (view.type) {
    case 'chart':
      return <ChartView view={view} wsId={wsId} collectionId={collectionId} onUpdateConfig={noop} />
    case 'board':
      return (
        <BoardView {...common} members={memberNames} onCommitProps={noop} onUpdateConfig={noop} onCreateRowInColumn={noop} onReorderRow={noop} />
      )
    case 'gallery':
      return <GalleryView {...common} members={memberNames} pageId={collectionId} onCreateRow={noop} />
    case 'calendar':
      return <CalendarView {...common} members={memberNames} onCommitProps={noop} onUpdateConfig={noop} onCreateRowOnDate={noop} />
    case 'timeline':
      return <TimelineView {...common} onCommitProps={noop} onUpdateConfig={noop} />
    case 'list':
      // no onCreateRow: no new-row button in the block (read-only, docs/adr/2120-*)
      return <ListView {...common} members={memberNames} collectionId={collectionId} />
    default:
      // table, and a form view (its rows; the form builder belongs to the database page)
      return (
        <TableView
          {...common}
          view={view.type === 'table' ? view : { ...view, type: 'table' }}
          handlers={{
            wsId,
            members: memberNames,
            onCommitProps: noop,
            onAddOption: noOption,
            onUpdateTitle: noop,
            onDeleteRow: noop,
            refs: raw.refs ?? null,
          }}
          onUpdateConfig={noop}
          onOpenFields={noop}
          onCreateRow={noop}
          collectionId={collectionId}
        />
      )
  }
}

/** The block's render for a collection target (PageEmbed.tsx decides). */
export function DbViewEmbed({
  wsId,
  target,
  viewId,
  editable,
  onSetView,
}: {
  wsId: string
  target: PageMetaDTO
  viewId: string
  editable: boolean
  onSetView: (viewId: string) => void
}) {
  const tr = useT()
  const navigate = useNavigate()
  const collection = useCollection(target.id)
  const raw = collection.data
  const views = raw?.collection.views ?? []
  const view = views.find((v) => v.id === viewId) ?? views[0]
  const missing = !!raw && !!viewId && !views.some((v) => v.id === viewId)
  // a database outside a guest's share (404, docs/adr/2146-*) or another 403/404: the same "not available" as an unknown id
  const blocked = collection.isError || (!raw && collection.fetchStatus === 'idle' && !collection.isLoading)

  return (
    <div contentEditable={false} className="my-1.5 overflow-hidden rounded-lg border border-line" data-dbview-block>
      {blocked ? (
        <DbViewUnavailable />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <DatabaseIcon size={15} className="shrink-0 text-sub" />
            <span className="min-w-0 truncate text-sm font-medium text-ink">{target.title || tr('common.untitled')}</span>
            {view &&
              (editable && views.length > 1 ? (
                <select
                  aria-label={tr('dbView.changeView')}
                  value={view.id}
                  onChange={(e) => onSetView(e.target.value)}
                  className="rounded border border-line bg-app px-1.5 py-0.5 text-xs text-sub"
                  data-print-hide
                >
                  {views.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="truncate text-xs text-sub">{view.name}</span>
              ))}
            <button
              type="button"
              onClick={() => navigate(`/w/${wsId}/p/${target.id}`)}
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-sub hover:bg-hover hover:text-ink"
              data-print-hide
            >
              {tr('dbView.openFull')} <ExternalLinkIcon size={12} />
            </button>
          </div>
          {missing && view && <p className="px-3 pb-1 text-xs text-sub">{tr('dbView.viewDeleted', { name: view.name })}</p>}
          <div className="nd-dbview-body max-h-[480px] overflow-auto border-t border-line px-2 pb-2">
            {!raw ? (
              <div className="flex justify-center py-6">
                <Spinner size={18} />
              </div>
            ) : !view ? (
              <p className="px-1 py-4 text-sm text-sub">{tr('dbView.noViews')}</p>
            ) : (
              <CollectionRefsContext.Provider value={raw.refs ?? null}>
                <CollectionReadOnlyContext.Provider value={true}>
                  <ViewBody wsId={wsId} collectionId={target.id} view={view} />
                </CollectionReadOnlyContext.Provider>
              </CollectionRefsContext.Provider>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** An empty database-view block (from the slash menu): pick a database of this workspace and a view. */
export function DbViewSetup({ wsId, onPick }: { wsId: string; onPick: (collectionId: string, viewId: string) => void }) {
  const tr = useT()
  const pages = usePages(wsId)
  const databases = useMemo(
    () => (pages.data ?? []).filter((p) => p.kind === 'collection').sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [pages.data],
  )
  const [collectionId, setCollectionId] = useState('')
  const collection = useCollection(collectionId || undefined)
  const views = collection.data?.collection.views ?? []
  const [viewId, setViewId] = useState('')
  const chosenView = views.some((v) => v.id === viewId) ? viewId : ''

  return (
    <div contentEditable={false} className="my-1.5 w-full rounded-lg border border-dashed border-line px-3 py-3" data-dbview-setup>
      <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
        <DatabaseIcon size={15} /> {tr('dbView.setupTitle')} <span className="font-normal text-sub">— {tr('dbView.setupHint')}</span>
      </p>
      {pages.data && databases.length === 0 ? (
        <p className="text-xs text-sub">{tr('dbView.noDatabases')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-sub">
            {tr('dbView.database')}
            <select
              value={collectionId}
              onChange={(e) => {
                setCollectionId(e.target.value)
                setViewId('')
              }}
              className="rounded border border-line bg-app px-1.5 py-1 text-sm text-ink"
            >
              <option value="">{tr('dbView.choose')}</option>
              {databases.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || tr('common.untitled')}
                </option>
              ))}
            </select>
          </label>
          {collectionId && (
            <label className="flex items-center gap-1 text-xs text-sub">
              {tr('dbView.view')}
              <select value={chosenView} onChange={(e) => setViewId(e.target.value)} className="rounded border border-line bg-app px-1.5 py-1 text-sm text-ink">
                <option value="">{views[0] ? `${views[0].name} (${tr('dbView.firstView')})` : tr('dbView.firstView')}</option>
                {views.slice(1).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            disabled={!collectionId}
            onClick={() => onPick(collectionId, chosenView)}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {tr('dbView.insert')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Slash-menu entry: an empty page embed that asks for a database and a view. */
export function dbViewSlashItems(editor: AnyEditor): DefaultReactSuggestionItem[] {
  if (!('pageEmbed' in editor.schema.blockSchema)) return []
  return [
    {
      title: t('dbView.slashTitle'),
      subtext: t('dbView.slashSubtext'),
      // search data, not display text: English and Korean in every locale
      aliases: ['database', 'db', 'linked database', 'view', 'table view', 'board view', '데이터베이스', '디비', '보기', '표 보기', '보드', '링크된 데이터베이스'],
      group: t('linkEmbed.slashGroup'),
      icon: <DatabaseIcon size={16} />,
      onItemClick: () => {
        insertFromSlash(editor as unknown as SlashEditor, { type: 'pageEmbed', props: { pageId: '', viewId: '' } } as never, 'own')
      },
    },
  ]
}
