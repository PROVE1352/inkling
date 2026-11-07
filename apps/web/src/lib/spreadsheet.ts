// Spreadsheet import/export/clipboard helpers for collections (docs/adr/0305).
// exceljs is ONLY loaded through dynamic import() so it never lands in the initial bundle.
import type { CollectionField, MemberDTO, RowDTO, RowRefDTO } from '@inkling/shared'
import {
  escapeFormula,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_COLS,
  IMPORT_MAX_ROWS,
  parseCsv,
  toCsv,
} from '@inkling/shared'
import { t } from '../i18n'
import { formatValue } from './collection'

export class SheetError extends Error {}

export interface ParsedSheet {
  name: string
  rows: string[][]
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[]
}

type ExcelModule = typeof import('exceljs')

async function loadExcel(): Promise<ExcelModule> {
  const m = (await import('exceljs')) as unknown as ExcelModule & { default?: ExcelModule }
  return m.default ?? m
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** exceljs cell value → plain string (dates as YYYY-MM-DD, formulas as their cached result). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return ''
    return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('result' in o) return cellText(o.result)
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('')
    if ('text' in o) return cellText(o.text)
    if ('error' in o) return ''
  }
  return String(v)
}

function checkShape(rows: string[][]): void {
  if (rows.length === 0) throw new SheetError('empty')
  if (rows.length - 1 > IMPORT_MAX_ROWS) throw new SheetError('rows')
  let maxCols = 0
  for (const r of rows) if (r.length > maxCols) maxCols = r.length
  if (maxCols > IMPORT_MAX_COLS) throw new SheetError('cols')
}

/** Read a dropped .csv/.tsv/.xlsx file. Throws SheetError('size'|'rows'|'cols'|'empty'|'type'). */
export async function readSpreadsheet(file: File): Promise<ParsedWorkbook> {
  if (file.size > IMPORT_MAX_BYTES) throw new SheetError('size')
  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt') || file.type === 'text/csv') {
    const text = await file.text()
    const parsed = parseCsv(text, {
      delimiter: name.endsWith('.tsv') ? '\t' : undefined,
      maxRows: IMPORT_MAX_ROWS + 2,
    })
    if (parsed.truncated || parsed.rows.length - 1 > IMPORT_MAX_ROWS) throw new SheetError('rows')
    checkShape(parsed.rows)
    return { sheets: [{ name: file.name.replace(/\.[^.]+$/, ''), rows: parsed.rows }] }
  }
  if (name.endsWith('.xlsx')) {
    const ExcelJS = await loadExcel()
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await file.arrayBuffer()) as never)
    const sheets: ParsedSheet[] = []
    wb.eachSheet((ws) => {
      if (ws.rowCount - 1 > IMPORT_MAX_ROWS) throw new SheetError('rows')
      if (ws.columnCount > IMPORT_MAX_COLS) throw new SheetError('cols')
      const rows: string[][] = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = row.values as unknown[] // 1-based
        const out: string[] = []
        for (let c = 1; c < vals.length; c++) out.push(cellText(vals[c]))
        rows.push(out)
      })
      if (rows.length) sheets.push({ name: ws.name, rows })
    })
    if (sheets.length === 0) throw new SheetError('empty')
    for (const s of sheets) checkShape(s.rows)
    return { sheets }
  }
  throw new SheetError('type')
}

// ---------------------------------------------------------------------------
// Export (current view: filters/sorts/visible columns already applied by the caller)
// ---------------------------------------------------------------------------

export interface ExportContext {
  fields: CollectionField[]
  rows: RowDTO[]
  members?: MemberDTO[]
  refs?: Record<string, RowRefDTO> | null
  titleHeader?: string
}

/** Display grid: header + one string per cell (same text the UI shows). */
export function viewGrid(ctx: ExportContext): string[][] {
  const memberName = (id: string) => ctx.members?.find((m) => m.id === id)?.name
  const refTitle = (id: string) => ctx.refs?.[id]?.title
  const header = [ctx.titleHeader ?? t('lib.titleColumn'), ...ctx.fields.map((f) => f.name)]
  const body = ctx.rows.map((r) => [
    r.title,
    ...ctx.fields.map((f) =>
      f.type === 'checkbox'
        ? r.props[f.id]
          ? 'TRUE'
          : 'FALSE'
        : formatValue(f, r.props[f.id], memberName, refTitle),
    ),
  ])
  return [header, ...body]
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function safeName(title: string): string {
  return (title.trim() || 'collection').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}

/** CSV with UTF-8 BOM (Excel-friendly) and formula-injection escaping. */
export function exportCsv(ctx: ExportContext, title: string): void {
  const csv = toCsv(viewGrid(ctx))
  download(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), `${safeName(title)}.csv`)
}

export async function exportXlsx(ctx: ExportContext, title: string): Promise<void> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(safeName(title).slice(0, 31))
  const grid = viewGrid(ctx)
  ws.addRow(grid[0])
  ws.getRow(1).font = { bold: true }
  ctx.rows.forEach((r, i) => {
    const typed: unknown[] = [escapeFormula(r.title)]
    ctx.fields.forEach((f, j) => {
      const v = r.props[f.id]
      if ((f.type === 'number' || f.type === 'rollup') && typeof v === 'number') typed.push(v)
      else if (f.type === 'checkbox') typed.push(!!v)
      else if (f.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
        typed.push(new Date(`${v}T00:00:00Z`))
      // strings are written as text cells (never formulas); still neutralize leading =,+,-,@
      // because users often re-save as CSV
      else typed.push(escapeFormula(grid[i + 1][j + 1]))
    })
    ws.addRow(typed)
  })
  ctx.fields.forEach((f, j) => {
    if (f.type === 'date') ws.getColumn(j + 2).numFmt = 'yyyy-mm-dd'
  })
  const buf = await wb.xlsx.writeBuffer()
  download(
    new Blob([buf as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `${safeName(title)}.xlsx`,
  )
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/** TSV for spreadsheets: tabs/newlines inside a cell are quoted like Excel/Sheets do. */
export function toTsv(grid: string[][]): string {
  return grid
    .map((r) =>
      r
        .map((v) => {
          const s = escapeFormula(v)
          return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join('\t'),
    )
    .join('\n')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function toHtmlTable(grid: string[][]): string {
  return `<table>${grid
    .map((r) => `<tr>${r.map((v) => `<td>${escHtml(v)}</td>`).join('')}</tr>`)
    .join('')}</table>`
}

/** Clipboard → 2D grid. Prefers an HTML <table> (Sheets/Excel/Inkling), falls back to TSV. */
export function parseClipboardGrid(data: DataTransfer): string[][] | null {
  const html = data.getData('text/html')
  if (html && /<table[\s>]/i.test(html)) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const table = doc.querySelector('table')
    if (table) {
      const grid: string[][] = []
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const row: string[] = []
        for (const cell of Array.from(tr.querySelectorAll('td,th'))) {
          const text = (cell as HTMLElement).innerText ?? cell.textContent ?? ''
          row.push(text.replace(/ /g, ' ').trim())
          const span = Number(cell.getAttribute('colspan') ?? 1)
          for (let k = 1; k < span && k < 50; k++) row.push('')
        }
        grid.push(row)
      }
      if (grid.length) return grid
    }
  }
  const text = data.getData('text/plain')
  if (!text) return null
  if (!text.includes('\t') && !text.includes('\n')) return [[text]]
  const parsed = parseCsv(text.replace(/\r?\n$/, ''), { delimiter: '\t', maxRows: IMPORT_MAX_ROWS })
  return parsed.rows
}
