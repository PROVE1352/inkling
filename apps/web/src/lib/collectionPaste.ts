// Paste a spreadsheet range (TSV/HTML grid) into a collection table at an anchor cell.
// Existing rows are updated with one batch PATCH, overflow rows are created with batch POSTs,
// missing select options are added first (one fields PUT).
import type { CollectionField, MemberDTO, RowDTO, SelectOption } from '@inkling/shared'
import { coerceCellValue } from '@inkling/shared'
import { api } from '../api'
import { batchCreateRows, batchUpdateRows } from './collectionApi'
import { OPTION_COLORS } from './optionColors'

export interface PasteResult {
  updated: number
  created: number
}

export async function applyGridPaste(opts: {
  pageId: string
  fields: CollectionField[]
  /** visible columns in table order (col 0 of the table = title, col k = cols[k-1]) */
  cols: CollectionField[]
  /** displayed rows (filters/sorts applied) */
  rows: RowDTO[]
  grid: string[][]
  anchorRow: number
  anchorCol: number
  members?: MemberDTO[]
}): Promise<PasteResult> {
  const { pageId, cols, rows, grid, anchorRow, anchorCol, members } = opts
  const fields = opts.fields.map((f) => (f.options ? { ...f, options: [...f.options] } : { ...f }))
  const byId = new Map(fields.map((f) => [f.id, f]))
  let fieldsChanged = false

  const resolveOption = (field: CollectionField, name: string): string | null => {
    const f = byId.get(field.id)
    if (!f) return null
    const opts2 = (f.options ??= [])
    const hit = opts2.find((o) => o.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    if (opts2.length >= 50) return null
    const o: SelectOption = {
      id: crypto.randomUUID().slice(0, 8),
      name: name.slice(0, 60),
      color: OPTION_COLORS[opts2.length % OPTION_COLORS.length],
    }
    opts2.push(o)
    fieldsChanged = true
    return o.id
  }
  const resolvePerson = (name: string): string | null => {
    const n = name.toLowerCase()
    return members?.find((m) => m.name.toLowerCase() === n || m.email?.toLowerCase() === n)?.id ?? null
  }

  const updates: { id: string; title?: string; props?: Record<string, unknown> }[] = []
  const creates: { title?: string; props?: Record<string, unknown> }[] = []
  grid.forEach((line, i) => {
    let title: string | undefined
    const props: Record<string, unknown> = {}
    line.forEach((raw, j) => {
      const c = anchorCol + j
      if (c === 0) {
        title = raw.trim().slice(0, 500)
        return
      }
      const f = cols[c - 1]
      if (!f) return
      const v = coerceCellValue(byId.get(f.id) ?? f, raw, { resolveOption, resolvePerson })
      if (v !== undefined) props[f.id] = v
    })
    const target = rows[anchorRow + i]
    if (target) {
      if (title !== undefined || Object.keys(props).length) updates.push({ id: target.id, title, props })
    } else {
      for (const k of Object.keys(props)) if (props[k] === null) delete props[k]
      creates.push({ title, props })
    }
  })

  if (fieldsChanged) {
    await api(`/api/pages/${pageId}/collection/fields`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    })
  }
  const updated = updates.length ? await batchUpdateRows(pageId, updates) : 0
  const created = creates.length ? (await batchCreateRows(pageId, creates)).length : 0
  return { updated, created }
}
