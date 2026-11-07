import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { CollectionField, RowDTO, ViewConfig, ViewType } from '@inkling/shared'
import {
  qk,
  usePages,
  useCollection,
  useCreatePage,
  useCreateView,
  useDeletePage,
  useDeleteView,
  useMembers,
  useUpdateFields,
  useUpdatePage,
  useUpdateProps,
  useUpdateView,
  type CollectionBundle,
} from '../../api'
import { applyView, orderedFields } from '../../lib/collection'
import { useExperimental } from '../../lib/collectionApi'
import { applyGridPaste } from '../../lib/collectionPaste'
import { OPTION_COLORS } from '../../lib/optionColors'
import { exportCsv, exportXlsx, toHtmlTable, toTsv, viewGrid } from '../../lib/spreadsheet'
import { toast } from '../../lib/toast'
import { useT } from '../../i18n'
import { Spinner } from '../Spinner'
import { BoardView } from './BoardView'
import { CalendarView } from './CalendarView'
import { CollectionMenu } from './CollectionMenu'
import { FieldsModal } from './FieldsModal'
import { GalleryView } from './GalleryView'
import { ImportModal } from './ImportModal'
import { CollectionRefsContext } from './refsContext'
import { SheetSyncModal } from './SheetSyncModal'
import { S } from './strings'
import { TableView } from './TableView'
import { TimelineView } from './TimelineView'
import { ViewSettings } from './ViewSettings'
import { ViewTabs } from './ViewTabs'

export function CollectionView({ wsId, pageId }: { wsId: string; pageId: string }) {
  const t = useT()
  const qc = useQueryClient()
  const collection = useCollection(pageId)
  const members = useMembers(wsId)

  const updateFields = useUpdateFields(pageId)
  const createView = useCreateView(pageId)
  const updateView = useUpdateView(pageId)
  const deleteView = useDeleteView(pageId)
  const updateProps = useUpdateProps(pageId)
  const createPage = useCreatePage(wsId)
  const updatePage = useUpdatePage(wsId)
  const deletePage = useDeletePage(wsId)

  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const sheetsSync = useExperimental('sheets-sync')
  const pages = usePages(wsId)
  const pageMeta = useMemo(() => pages.data?.find((p) => p.id === pageId), [pages.data, pageId])

  const data = collection.data
  const views = data?.collection.views ?? []
  const fields = data?.collection.fields ?? []

  // Keep the active view valid: fall back to the first view when missing or deleted
  useEffect(() => {
    if (!views.length) return
    if (!activeViewId || !views.some((v) => v.id === activeViewId)) {
      setActiveViewId(views[0].id)
    }
  }, [views, activeViewId])

  if (collection.isLoading || !data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={22} />
      </div>
    )
  }

  if (collection.isError) {
    return (
      <div className="px-2 py-10 text-center text-sm text-sub">
        {t('collection.loadFailed')}
      </div>
    )
  }

  const view = views.find((v) => v.id === activeViewId) ?? views[0]
  const refs = data.refs ?? null

  // ---- spreadsheet: export / copy (current view: filters, sorts, visible columns) ----
  const exportCtx = () => {
    const cfg = view?.config ?? {}
    return {
      fields: orderedFields(fields, cfg),
      rows: applyView(data.rows, fields, cfg),
      members: members.data,
      refs,
    }
  }
  const title = pageMeta?.title ?? t('collection.exportFileName')
  const onExportCsv = () => exportCsv(exportCtx(), title)
  const onExportXlsx = () =>
    void exportXlsx(exportCtx(), title).catch((e: Error) => toast({ message: e.message }))
  const onCopyTsv = async () => {
    const grid = viewGrid(exportCtx())
    try {
      const tsv = toTsv(grid)
      if ('ClipboardItem' in window && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([toHtmlTable(grid)], { type: 'text/html' }),
          }),
        ])
      } else await navigator.clipboard.writeText(tsv)
      toast({ message: S.copied })
    } catch (e) {
      toast({ message: (e as Error).message })
    }
  }
  const onPasteGrid = (
    grid: string[][],
    rowsShown: RowDTO[],
    cols: CollectionField[],
    anchorRow: number,
    anchorCol: number,
  ) =>
    void applyGridPaste({
      pageId,
      fields,
      cols,
      rows: rowsShown,
      grid,
      anchorRow,
      anchorCol,
      members: members.data,
    })
      .then((r) => toast({ message: S.pasteRows(r.updated + r.created) }))
      .catch((e: Error) => toast({ message: `${S.pasteFailed}: ${e.message}` }))
      .finally(() => {
        qc.invalidateQueries({ queryKey: qk.collection(pageId) })
        qc.invalidateQueries({ queryKey: ['pages'] })
      })

  // ---- handlers ----
  const onCommitProps = (rowId: string, patch: Record<string, unknown>) =>
    updateProps.mutate({ id: rowId, props: patch })

  const onAddOption = (fieldId: string, name: string): string => {
    const id = crypto.randomUUID().slice(0, 8)
    const target = fields.find((f) => f.id === fieldId)
    const color = OPTION_COLORS[(target?.options?.length ?? 0) % OPTION_COLORS.length]
    const next: CollectionField[] = fields.map((f) =>
      f.id === fieldId
        ? { ...f, options: [...(f.options ?? []), { id, name, color }] }
        : f,
    )
    updateFields.mutate(next)
    return id
  }

  const onUpdateTitle = (rowId: string, title: string) =>
    updatePage.mutate({ id: rowId, input: { title } })

  const onDeleteRow = (rowId: string) =>
    deletePage.mutate(rowId, {
      onSuccess: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }),
    })

  const onCreateRow = () =>
    createPage.mutate(
      { workspaceId: wsId, parentId: pageId, kind: 'doc', title: '' },
      { onSuccess: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }) },
    )

  const onCreateRowInColumn = (optionId: string | null) => {
    if (!view || view.type !== 'board') return
    const groupId = view.config.groupByFieldId
    createPage.mutate(
      { workspaceId: wsId, parentId: pageId, kind: 'doc', title: '' },
      {
        onSuccess: (row) => {
          if (optionId && groupId) {
            updateProps.mutate({ id: row.id, props: { [groupId]: optionId } })
          } else {
            qc.invalidateQueries({ queryKey: qk.collection(pageId) })
          }
        },
      },
    )
  }

  // Calendar: [＋] on a date cell creates a row, then stores that date in the date field.
  // (updateProps' onSettled invalidates the collection so the new row shows up; same pattern as onCreateRowInColumn)
  const onCreateRowOnDate = (dateFieldId: string, date: string) =>
    createPage.mutate(
      { workspaceId: wsId, parentId: pageId, kind: 'doc', title: '' },
      {
        onSuccess: (row) => {
          updateProps.mutate({ id: row.id, props: { [dateFieldId]: date } })
        },
      },
    )

  const onReorderRow = async (rowId: string, sortOrder: number) => {
    // Optimistically update sortOrder in the cached collection rows (so board reordering doesn't jump).
    // Cancel an in-flight poll first: it started before this write and would land after it,
    // snapping the card back until the next poll (docs/adr/0853-*).
    await qc.cancelQueries({ queryKey: qk.collection(pageId) })
    qc.setQueryData<CollectionBundle>(qk.collection(pageId), (old) =>
      old
        ? {
            ...old,
            rows: old.rows.map((r) => (r.id === rowId ? { ...r, sortOrder } : r)),
          }
        : old,
    )
    updatePage.mutate(
      { id: rowId, input: { sortOrder } },
      { onSettled: () => qc.invalidateQueries({ queryKey: qk.collection(pageId) }) },
    )
  }

  const onUpdateConfig = (config: ViewConfig) => {
    if (view) updateView.mutate({ viewId: view.id, input: { config } })
  }

  const onCreateView = (name: string, type: ViewType) =>
    createView.mutate(
      { name, type },
      { onSuccess: (v) => setActiveViewId(v.id) },
    )
  const onRenameView = (id: string, name: string) =>
    updateView.mutate({ viewId: id, input: { name } })
  const onDeleteView = (id: string) => {
    deleteView.mutate(id)
    if (activeViewId === id) {
      const rest = views.filter((v) => v.id !== id)
      setActiveViewId(rest[0]?.id ?? null)
    }
  }

  return (
    <CollectionRefsContext.Provider value={refs}>
    <div
      className="mt-2"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const f = e.dataTransfer.files?.[0]
        if (!f || !/\.(csv|tsv|xlsx)$/i.test(f.name)) return
        e.preventDefault()
        e.stopPropagation()
        setImportFile(f)
        setImportOpen(true)
      }}
    >
      <div className="flex items-center justify-between" data-print-hide>
        <ViewTabs
          views={views}
          activeViewId={view?.id ?? ''}
          onSelect={setActiveViewId}
          onCreate={onCreateView}
          onRename={onRenameView}
          onDelete={onDeleteView}
          creating={createView.isPending}
        />
        {view && (
          <div className="flex items-center gap-1 pl-2">
            <ViewSettings
              view={view}
              fields={fields}
              members={members.data}
              onUpdateConfig={onUpdateConfig}
            />
            <button
              type="button"
              onClick={() => setFieldsOpen(true)}
              className="rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
            >
              {t('collection.properties')}
            </button>
            <CollectionMenu
              onImport={() => {
                setImportFile(null)
                setImportOpen(true)
              }}
              onExportCsv={onExportCsv}
              onExportXlsx={onExportXlsx}
              onCopyTsv={() => void onCopyTsv()}
              onSheetSync={sheetsSync ? () => setSyncOpen(true) : undefined}
            />
          </div>
        )}
      </div>

      {view?.type === 'gallery' ? (
        <GalleryView
          view={view}
          fields={fields}
          rows={data.rows}
          members={members.data}
          wsId={wsId}
          pageId={pageId}
          onCreateRow={onCreateRow}
          creatingRow={createPage.isPending}
        />
      ) : view?.type === 'timeline' ? (
        <TimelineView
          view={view}
          fields={fields}
          rows={data.rows}
          wsId={wsId}
          onCommitProps={onCommitProps}
          onUpdateConfig={onUpdateConfig}
        />
      ) : view?.type === 'board' ? (
        <BoardView
          view={view}
          fields={fields}
          rows={data.rows}
          members={members.data}
          wsId={wsId}
          onCommitProps={onCommitProps}
          onUpdateConfig={onUpdateConfig}
          onCreateRowInColumn={onCreateRowInColumn}
          onReorderRow={onReorderRow}
        />
      ) : view?.type === 'calendar' ? (
        <CalendarView
          view={view}
          fields={fields}
          rows={data.rows}
          members={members.data}
          wsId={wsId}
          onCommitProps={onCommitProps}
          onUpdateConfig={onUpdateConfig}
          onCreateRowOnDate={onCreateRowOnDate}
        />
      ) : view ? (
        <TableView
          view={view}
          fields={fields}
          rows={data.rows}
          handlers={{
            wsId,
            members: members.data,
            onCommitProps,
            onAddOption,
            onUpdateTitle,
            onDeleteRow,
            onPasteGrid,
            refs,
          }}
          onUpdateConfig={onUpdateConfig}
          onOpenFields={() => setFieldsOpen(true)}
          onCreateRow={onCreateRow}
          creatingRow={createPage.isPending}
        />
      ) : null}

      <FieldsModal
        open={fieldsOpen}
        onClose={() => {
          updateFields.reset()
          setFieldsOpen(false)
        }}
        fields={fields}
        saving={updateFields.isPending}
        wsId={wsId}
        pageId={pageId}
        error={updateFields.error ? (updateFields.error as Error).message : null}
        onSave={(next) =>
          updateFields.mutate(next, {
            onSuccess: () => {
              setFieldsOpen(false)
              // two-way relations add a property to the target collection too
              qc.invalidateQueries({ queryKey: ['collection'] })
              qc.invalidateQueries({ queryKey: ['collectionDef'] })
            },
          })
        }
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        wsId={wsId}
        page={pageMeta}
        fields={fields}
        initialFile={importFile}
      />
      {sheetsSync && (
        <SheetSyncModal open={syncOpen} onClose={() => setSyncOpen(false)} pageId={pageId} />
      )}
    </div>
    </CollectionRefsContext.Provider>
  )
}
