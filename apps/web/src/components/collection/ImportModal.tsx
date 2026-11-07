import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { CollectionField, FieldType, PageMetaDTO, SelectOption } from '@inkling/shared'
import {
  coerceCellValue,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_COLS,
  IMPORT_MAX_ROWS,
  inferColumnType,
} from '@inkling/shared'
import { api, qk } from '../../api'
import { batchCreateRows } from '../../lib/collectionApi'
import { OPTION_COLORS } from '../../lib/optionColors'
import { readSpreadsheet, SheetError } from '../../lib/spreadsheet'
import type { ParsedWorkbook } from '../../lib/spreadsheet'
import { toast } from '../../lib/toast'
import { UploadIcon, XIcon } from '../Icons'
import { FIELD_TYPE_LABEL, S } from './strings'

type ColType = Exclude<FieldType, 'person' | 'relation' | 'rollup'>
const COL_TYPES: ColType[] = ['text', 'number', 'date', 'select', 'multiSelect', 'checkbox', 'url']
const TYPE_LABEL: Record<ColType, string> = FIELD_TYPE_LABEL
const MAX_OPTIONS = 50

interface ColPlan {
  index: number
  name: string
  type: ColType
  include: boolean
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function errorText(err: unknown): string {
  if (err instanceof SheetError) {
    switch (err.message) {
      case 'size':
        return S.errTooBig(IMPORT_MAX_BYTES / 1024 / 1024)
      case 'rows':
        return S.errTooManyRows(IMPORT_MAX_ROWS)
      case 'cols':
        return S.errTooManyCols(IMPORT_MAX_COLS)
      case 'type':
        return S.errUnsupported
      case 'empty':
        return S.errEmpty
    }
  }
  return err instanceof Error && err.message ? err.message : S.errRead
}

/** Build field definitions for the chosen columns (select options from distinct values). */
function buildFields(
  plan: ColPlan[],
  body: string[][],
  existing: CollectionField[],
): { fields: CollectionField[]; byCol: Map<number, CollectionField> } {
  const fields = existing.map((f) => (f.options ? { ...f, options: [...f.options] } : { ...f }))
  const byCol = new Map<number, CollectionField>()
  for (const c of plan) {
    if (!c.include) continue
    let f = fields.find(
      (x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase() && x.type !== 'relation' && x.type !== 'rollup',
    )
    if (!f) {
      let type: FieldType = c.type
      let options: SelectOption[] | undefined
      if (type === 'select' || type === 'multiSelect') {
        const names = new Set<string>()
        for (const r of body) {
          const v = (r[c.index] ?? '').trim()
          if (!v) continue
          if (type === 'multiSelect') for (const p of v.split(/\s*[,;]\s*/)) p && names.add(p)
          else names.add(v)
          if (names.size > MAX_OPTIONS) break
        }
        if (names.size > MAX_OPTIONS) type = 'text'
        else
          options = [...names].map((name, i) => ({
            id: newId(),
            name: name.slice(0, 60),
            color: OPTION_COLORS[i % OPTION_COLORS.length],
          }))
      }
      f = { id: newId(), name: c.name.trim().slice(0, 60) || S.importColumnN(c.index + 1), type, ...(options ? { options } : {}) }
      fields.push(f)
    }
    byCol.set(c.index, f)
  }
  return { fields: fields.slice(0, 200), byCol }
}

export function ImportModal({
  open,
  onClose,
  wsId,
  page,
  fields,
  initialFile,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  /** the collection page the import was started from */
  page: PageMetaDTO | undefined
  fields: CollectionField[]
  initialFile?: File | null
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [wb, setWb] = useState<ParsedWorkbook | null>(null)
  const [sheetIdx, setSheetIdx] = useState(0)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [target, setTarget] = useState<'new' | 'append'>('new')
  const [name, setName] = useState('')
  const [titleCol, setTitleCol] = useState(0)
  const [plan, setPlan] = useState<ColPlan[]>([])

  const sheet = wb?.sheets[sheetIdx]
  const header = sheet?.rows[0] ?? []
  const body = useMemo(() => sheet?.rows.slice(1) ?? [], [sheet])

  // (re)build the column plan whenever the sheet changes
  useEffect(() => {
    if (!sheet) return
    const width = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
    const cols: ColPlan[] = []
    for (let i = 0; i < width; i++) {
      const values = body.map((r) => r[i] ?? '')
      const inferred = inferColumnType(values)
      cols.push({ index: i, name: (header[i] ?? '').trim() || S.importColumnN(i + 1), type: inferred, include: true })
    }
    setPlan(cols)
    setTitleCol(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet])

  const load = async (file: File) => {
    setError(null)
    setWb(null)
    setBusy(S.importParsing)
    try {
      const parsed = await readSpreadsheet(file)
      setWb(parsed)
      setSheetIdx(0)
      setFileName(file.name)
      setName(file.name.replace(/\.[^.]+$/, '').slice(0, 300))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (open && initialFile) void load(initialFile)
    if (!open) {
      setWb(null)
      setError(null)
      setBusy(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  // preview of the first rows as they will be stored
  const preview = useMemo(() => {
    if (!sheet) return []
    const { byCol } = buildFields(plan, body.slice(0, 200), target === 'append' ? fields : [])
    return body.slice(0, 5).map((r) => {
      const out = new Map<number, string>()
      for (const c of plan) {
        const f = c.include && c.index !== titleCol ? byCol.get(c.index) : undefined
        if (!f) continue
        // preview shows option names, so "resolve" a name to itself
        const v = coerceCellValue(f, r[c.index] ?? '', {
          resolveOption: (ff, n) => ff.options?.find((o) => o.name.toLowerCase() === n.toLowerCase())?.name ?? null,
        })
        out.set(c.index, v === undefined ? '⚠' : v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v))
      }
      return out
    })
  }, [sheet, body, plan, titleCol, target, fields])

  const run = async () => {
    if (!sheet || !page) return
    setError(null)
    const cols = plan.map((c) => (c.index === titleCol ? { ...c, include: false } : c))
    try {
      let collectionId = page.id
      let base: CollectionField[] = fields
      if (target === 'new') {
        setBusy(S.importProgress(0, body.length))
        const created = await api<{ page: PageMetaDTO }>('/api/pages', {
          method: 'POST',
          body: JSON.stringify({
            workspaceId: wsId,
            parentId: page.parentId,
            kind: 'collection',
            title: name.trim() || fileName,
            ...(page.parentId ? {} : { scope: page.scope }),
          }),
        })
        collectionId = created.page.id
        base = []
      }
      const { fields: nextFields, byCol } = buildFields(cols, body, base)
      await api(`/api/pages/${collectionId}/collection/fields`, {
        method: 'PUT',
        body: JSON.stringify({ fields: nextFields }),
      })
      const optionId = (f: CollectionField, n: string) =>
        f.options?.find((o) => o.name.toLowerCase() === n.toLowerCase())?.id ?? null
      const rows = body.map((r) => {
        const props: Record<string, unknown> = {}
        for (const [ci, f] of byCol) {
          const v = coerceCellValue(f, r[ci] ?? '', { resolveOption: optionId })
          if (v !== undefined && v !== null) props[f.id] = v
        }
        return { title: (r[titleCol] ?? '').trim().slice(0, 500), props }
      })
      await batchCreateRows(collectionId, rows, (d, t) => setBusy(S.importProgress(d, t)))
      qc.invalidateQueries({ queryKey: qk.collection(collectionId) })
      qc.invalidateQueries({ queryKey: qk.pages(wsId) })
      toast({ message: S.importDone(rows.length) })
      onClose()
      if (target === 'new') navigate(`/w/${wsId}/p/${collectionId}`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="nd-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="nd-pop flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-lg border border-line bg-app shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{S.importTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={!!busy}
            aria-label={S.close}
            className="rounded-md p-1 text-sub hover:bg-hover hover:text-ink"
          >
            <XIcon size={17} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!wb && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) void load(f)
              }}
              className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed border-line px-4 py-12 text-sm text-sub hover:bg-hover"
            >
              <UploadIcon size={22} />
              {busy ?? S.importDrop}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void load(f)
              e.target.value = ''
            }}
          />

          {wb && sheet && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="truncate font-medium text-ink">{fileName}</span>
                <span className="text-sub">{S.importRows(body.length)}</span>
                {wb.sheets.length > 1 && (
                  <label className="flex items-center gap-1.5 text-xs text-sub">
                    {S.importSheet}
                    <select
                      value={sheetIdx}
                      onChange={(e) => setSheetIdx(Number(e.target.value))}
                      className="rounded border border-line bg-app px-1.5 py-1 text-xs text-ink"
                    >
                      {wb.sheets.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4 text-xs text-sub">
                <span>{S.importTarget}</span>
                <label className="flex items-center gap-1.5 text-ink">
                  <input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />
                  {S.importNew}
                </label>
                <label className="flex items-center gap-1.5 text-ink">
                  <input type="radio" checked={target === 'append'} onChange={() => setTarget('append')} />
                  {S.importAppend}
                </label>
              </div>
              {target === 'new' && (
                <label className="flex items-center gap-2 text-xs text-sub">
                  <span className="w-28 shrink-0">{S.importName}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-line bg-app px-2 py-1 text-sm text-ink outline-none focus-visible:border-accent"
                  />
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-sub">
                <span className="w-28 shrink-0">{S.importTitleCol}</span>
                <select
                  value={titleCol}
                  onChange={(e) => setTitleCol(Number(e.target.value))}
                  className="rounded border border-line bg-app px-1.5 py-1 text-sm text-ink"
                >
                  {plan.map((c) => (
                    <option key={c.index} value={c.index}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-side/50 text-sub">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">{S.importColumn}</th>
                      <th className="px-2 py-1.5 text-left font-medium">{S.importType}</th>
                      {preview.map((_, i) => (
                        <th key={i} className="px-2 py-1.5 text-left font-medium">
                          #{i + 1}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {plan
                      .filter((c) => c.index !== titleCol)
                      .map((c) => (
                        <tr key={c.index} className="border-t border-line">
                          <td className="px-2 py-1">
                            <label className="flex items-center gap-1.5 text-ink">
                              <input
                                type="checkbox"
                                checked={c.include}
                                onChange={(e) =>
                                  setPlan((p) => p.map((x) => (x.index === c.index ? { ...x, include: e.target.checked } : x)))
                                }
                              />
                              <input
                                value={c.name}
                                onChange={(e) =>
                                  setPlan((p) => p.map((x) => (x.index === c.index ? { ...x, name: e.target.value } : x)))
                                }
                                className="w-36 rounded border border-transparent bg-transparent px-1 py-0.5 text-ink hover:border-line focus-visible:border-accent focus-visible:outline-none"
                              />
                            </label>
                          </td>
                          <td className="px-2 py-1">
                            <select
                              value={c.type}
                              disabled={!c.include}
                              onChange={(e) =>
                                setPlan((p) =>
                                  p.map((x) => (x.index === c.index ? { ...x, type: e.target.value as ColType } : x)),
                                )
                              }
                              className="rounded border border-line bg-app px-1 py-0.5 text-xs text-ink"
                            >
                              {COL_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {TYPE_LABEL[t]}
                                </option>
                              ))}
                            </select>
                          </td>
                          {preview.map((row, ri) => (
                            <td key={ri} className="max-w-[140px] truncate px-2 py-1 text-ink">
                              {c.include ? row.get(c.index) : <span className="text-sub/60">{S.importSkip}</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {busy && wb && <span className="mr-auto text-xs text-sub">{busy}</span>}
          <button
            type="button"
            onClick={onClose}
            disabled={!!busy}
            className="rounded-md px-3 py-1.5 text-sm text-sub hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            {S.cancel}
          </button>
          <button
            type="button"
            onClick={run}
            disabled={!wb || !!busy || !page}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-60"
          >
            {S.importStart}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
