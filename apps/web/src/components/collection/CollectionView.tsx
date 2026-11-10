import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { CollectionField, RowDTO, RowTemplateDTO, ViewConfig, ViewType } from '@inkling/shared'
import {
  ApiError,
  qk,
  usePages,
  useCollection,
  useCreateView,
  useDeletePage,
  useDeleteView,
  useMe,
  useMembers,
  useUpdateFields,
  useUpdatePage,
  useUpdateProps,
  useUpdateView,
  type CollectionBundle,
} from '../../api'
import { applyView, membersWithPeople, orderedFields } from '../../lib/collection'
import {
  useCreateRow,
  useCreateRowTemplate,
  useDeleteRowTemplate,
  useRowTemplates,
  useUpdateRowTemplate,
} from '../../lib/rowTemplatesApi'
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
import { AutomationsModal } from './AutomationsModal'
import { GalleryView } from './GalleryView'
import { ImportModal } from './ImportModal'
import { NewRowButton, RowInputsModal, RowTemplatesModal } from './RowTemplateMenus'
import { RowTemplateEditor } from './RowTemplateEditor'
import { useIsGuest } from '../../lib/useGuest'
import { CollectionReadOnlyContext } from './readOnlyContext'
import { CollectionRefsContext } from './refsContext'
import { SheetSyncModal } from './SheetSyncModal'
import { S } from './strings'
import { TableView } from './TableView'
import { TimelineView } from './TimelineView'
import { ChartView } from './ChartView'
import { FormView } from './FormView'
import { withFormulas } from '../../lib/formulas'
import { defaultFormSettings, subItemsField } from '@inkling/shared'
import { ListView } from './ListView'
import { ViewSettings } from './ViewSettings'
import { ViewTabs } from './ViewTabs'

export function CollectionView({
  wsId,
  pageId,
  readOnly = false,
}: {
  wsId: string
  pageId: string
  /** Page edit lock denies editing (docs/adr/0970-*): display only, no writes from this view. */
  readOnly?: boolean
}) {
  const t = useT()
  const qc = useQueryClient()
  const collection = useCollection(pageId)
  const members = useMembers(wsId)
  // a page guest edits cells and rows at most; properties, views, import and paste are member-only (docs/adr/2146-*)
  const guest = useIsGuest(wsId)
  const schemaLocked = readOnly || guest

  const updateFields = useUpdateFields(pageId)
  const createView = useCreateView(pageId)
  const updateView = useUpdateView(pageId)
  const deleteView = useDeleteView(pageId)
  const updateProps = useUpdateProps(pageId)
  const updatePage = useUpdatePage(wsId)
  // Row templates (docs/adr/1180-*): every "new row" goes through one create call.
  const me = useMe()
  const navigate = useNavigate()
  const rowTemplates = useRowTemplates(pageId)
  const createRow = useCreateRow(wsId, pageId)
  const createTemplate = useCreateRowTemplate(pageId)
  const updateTemplate = useUpdateRowTemplate(pageId)
  const deleteTemplate = useDeleteRowTemplate(pageId)
  const [manageOpen, setManageOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null)
  const [askInputs, setAskInputs] = useState<{
    template: RowTemplateDTO
    props?: Record<string, unknown>
    open?: boolean
  } | null>(null)
  const deletePage = useDeletePage(wsId)

  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [automationsOpen, setAutomationsOpen] = useState(false)
  const sheetsSync = useExperimental('sheets-sync')
  const pages = usePages(wsId)
  const pageMeta = useMemo(() => pages.data?.find((p) => p.id === pageId), [pages.data, pageId])

  const raw = collection.data
  const views = raw?.collection.views ?? []
  const fields = raw?.collection.fields ?? []
  // A guest's response names the people in its rows (`people`: user id → name), because guests
  // cannot read the member list. Display only: pickers and paste keep the real member list.
  const people = (raw as (CollectionBundle & { people?: Record<string, string> }) | undefined)?.people
  const memberNames = useMemo(() => membersWithPeople(members.data, people), [members.data, people])
  const parentField = subItemsField(fields, pageId)
  // Formulas recomputed from the rows' current props (after optimistic edits too), with the same
  // engine as the server (docs/adr/1825-*).
  const rowsWithFormulas = useMemo(() => (raw ? withFormulas(raw.rows, raw.collection.fields) : []), [raw])
  const data = raw ? { ...raw, rows: rowsWithFormulas } : raw

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
      members: memberNames,
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
    updateProps.mutate(
      { id: rowId, props: patch },
      {
        // the edit is reverted by the mutation; say why when the server refused a sub-item loop
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'SUBITEM_CYCLE') toast({ message: e.message || t('errors.SUBITEM_CYCLE') })
        },
      },
    )

  // Sub-items on/off (docs/adr/2144-*): on adds a "Parent item" relation to this collection itself;
  // off keeps that field as a plain relation.
  const onToggleSubItems = () => {
    const next: CollectionField[] = parentField
      ? fields.map((f) => {
          if (f.id !== parentField.id || !f.relation) return f
          const { subItems: _drop, ...relation } = f.relation
          void _drop
          return { ...f, relation }
        })
      : [
          ...fields,
          {
            id: crypto.randomUUID().slice(0, 8),
            name: t('subItems.parentFieldName'),
            type: 'relation',
            relation: { targetPageId: pageId, subItems: true },
          },
        ]
    updateFields.mutate(next, {
      onError: (e) => toast({ message: (e as Error).message }),
    })
  }

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

  const templates = rowTemplates.data?.templates ?? []
  const runCreate = (
    template: RowTemplateDTO | null,
    props?: Record<string, unknown>,
    open?: boolean,
    inputs?: Record<string, string>,
  ) =>
    createRow.mutate(
      { template: template ? template.id : null, ...(props ? { props } : {}), ...(inputs ? { inputs } : {}) },
      {
        onSuccess: (r) => {
          setAskInputs(null)
          if (open) navigate(`/w/${wsId}/p/${r.row.id}`)
        },
      },
    )
  /** undefined = the default template (none → empty row), null = empty row. Prompts for inputs first. */
  const requestCreate = (templateId: string | null | undefined, props?: Record<string, unknown>, open?: boolean) => {
    const tpl =
      templateId === null
        ? null
        : templateId === undefined
          ? (templates.find((x) => x.isDefault) ?? null)
          : (templates.find((x) => x.id === templateId) ?? null)
    if (tpl && tpl.inputs.length > 0) setAskInputs({ template: tpl, props, open })
    else runCreate(tpl, props, open)
  }

  const onCreateRow = () => requestCreate(undefined)

  // "Add sub-item": a new row (through the default template like any new row) with this parent
  const onCreateSubItem = (parentRowId: string) => {
    if (parentField) requestCreate(undefined, { [parentField.id]: [parentRowId] })
  }

  // Board column "+": the column's option over the template's values, in the same request.
  const onCreateRowInColumn = (optionId: string | null) => {
    if (!view || view.type !== 'board') return
    const groupId = view.config.groupByFieldId
    requestCreate(undefined, optionId && groupId ? { [groupId]: optionId } : undefined)
  }

  // Calendar: [＋] on a date cell creates a row with that date (over the template's values).
  const onCreateRowOnDate = (dateFieldId: string, date: string) =>
    requestCreate(undefined, { [dateFieldId]: date })

  const onNewTemplate = () =>
    createTemplate.mutate({ name: t('rowTpl.newTemplateName') }, { onSuccess: (tpl) => setEditingTemplate(tpl.id) })

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
      // a new form asks for the title and the first properties (docs/adr/1820-*)
      { name, type, ...(type === 'form' ? { config: { form: defaultFormSettings(fields) } } : {}) },
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
    <CollectionReadOnlyContext.Provider value={readOnly}>
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
        if (schemaLocked) return
        setImportFile(f)
        setImportOpen(true)
      }}
    >
      {/* Narrow panes (375 px): the actions wrap under the view tabs instead of running off the
          right edge; on a wide pane both still share one line (docs/adr/1354-*). */}
      <div className="flex flex-wrap items-center justify-between gap-y-1" data-print-hide>
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
          <div className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap pl-2">
            {/* Read-only: filters/sorts/fields are saved on the server (writes the lock denies).
                Guests edit cells and rows only, never properties or views (docs/adr/2146-*). */}
            {!schemaLocked && (
              <>
                <ViewSettings
                  view={view}
                  fields={fields}
                  members={memberNames}
                  onUpdateConfig={onUpdateConfig}
                />
                <button
                  type="button"
                  onClick={() => setFieldsOpen(true)}
                  className="rounded-md px-2 py-1 text-xs text-sub hover:bg-hover hover:text-ink"
                >
                  {t('collection.properties')}
                </button>
              </>
            )}
            {!readOnly && (
              <NewRowButton
                templates={templates}
                busy={createRow.isPending}
                onCreate={(id, o) => requestCreate(id, undefined, o?.open)}
                onNewTemplate={onNewTemplate}
                onManage={() => setManageOpen(true)}
              />
            )}
            <CollectionMenu
              onRowTemplates={() => setManageOpen(true)}
              onAutomations={guest ? undefined : () => setAutomationsOpen(true)}
              onImport={
                schemaLocked
                  ? undefined
                  : () => {
                      setImportFile(null)
                      setImportOpen(true)
                    }
              }
              onExportCsv={onExportCsv}
              onExportXlsx={onExportXlsx}
              onCopyTsv={() => void onCopyTsv()}
              onSheetSync={sheetsSync && !schemaLocked ? () => setSyncOpen(true) : undefined}
              subItems={!!parentField}
              onToggleSubItems={schemaLocked ? undefined : onToggleSubItems}
            />
          </div>
        )}
      </div>

      {view?.type === 'form' ? (
        <FormView
          view={view}
          fields={fields}
          members={members.data}
          wsId={wsId}
          pageId={pageId}
          onUpdateConfig={onUpdateConfig}
        />
      ) : view?.type === 'chart' ? (
        <ChartView view={view} wsId={wsId} collectionId={pageId} onUpdateConfig={onUpdateConfig} />
      ) : view?.type === 'list' ? (
        <ListView
          view={view}
          fields={fields}
          rows={data.rows}
          members={memberNames}
          wsId={wsId}
          onCreateRow={onCreateRow}
          creatingRow={createRow.isPending}
          collectionId={pageId}
        />
      ) : view?.type === 'gallery' ? (
        <GalleryView
          view={view}
          fields={fields}
          rows={data.rows}
          members={memberNames}
          wsId={wsId}
          pageId={pageId}
          onCreateRow={onCreateRow}
          creatingRow={createRow.isPending}
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
          members={memberNames}
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
          members={memberNames}
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
            members: memberNames,
            onCommitProps,
            onAddOption,
            onUpdateTitle,
            onDeleteRow,
            onPasteGrid: schemaLocked ? undefined : onPasteGrid,
            refs,
          }}
          onUpdateConfig={onUpdateConfig}
          onOpenFields={() => setFieldsOpen(true)}
          onCreateRow={onCreateRow}
          creatingRow={createRow.isPending}
          collectionId={pageId}
          onCreateSubItem={parentField && !readOnly ? onCreateSubItem : undefined}
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
      <RowTemplatesModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        templates={templates}
        readOnly={schemaLocked}
        onEdit={(id) => {
          setManageOpen(false)
          setEditingTemplate(id)
        }}
        onNew={() => {
          setManageOpen(false)
          onNewTemplate()
        }}
        onSetDefault={(id, isDefault) => updateTemplate.mutate({ id, input: { isDefault } })}
        onDelete={(id) => deleteTemplate.mutate(id)}
      />
      <AutomationsModal
        open={automationsOpen}
        onClose={() => setAutomationsOpen(false)}
        wsId={wsId}
        collectionId={pageId}
        fields={fields}
        members={members.data}
      />
      <RowInputsModal
        template={askInputs?.template ?? null}
        busy={createRow.isPending}
        onCancel={() => setAskInputs(null)}
        onCreate={(inputs) => askInputs && runCreate(askInputs.template, askInputs.props, askInputs.open, inputs)}
      />
      {editingTemplate && me.data && (
        <RowTemplateEditor
          templateId={editingTemplate}
          collectionId={pageId}
          collectionTitle={pageMeta?.title ?? ''}
          wsId={wsId}
          fields={fields}
          members={members.data}
          me={me.data}
          readOnly={readOnly}
          onClose={() => setEditingTemplate(null)}
        />
      )}
    </div>
    </CollectionReadOnlyContext.Provider>
    </CollectionRefsContext.Provider>
  )
}
