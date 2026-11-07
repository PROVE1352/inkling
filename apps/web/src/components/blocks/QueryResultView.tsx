import type { QueryResultDTO, QueryRowDTO } from '@inkling/shared'
import { fmtDateTime, t } from '../../i18n'

// Result rendering of the query block (QueryBlock.tsx). Kept free of BlockNote imports so it can
// be rendered in a plain Node test (QueryResultView.test.ts).

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map(formatValue).join(', ')
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return fmtDateTime(d)
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function PageLink({ wsId, row }: { wsId: string; row: QueryRowDTO }) {
  return (
    <a href={`/w/${wsId}/p/${row.pageId}`} className="text-accent hover:underline">
      {row.title || t('common.untitled')}
    </a>
  )
}

/**
 * Footer line under the results. "Showing the first N" depends only on the server's `truncated`
 * flag (the server fetches LIMIT + 1 rows to know); a result that exactly fills LIMIT is complete.
 */
export function resultFooterText(data: Pick<QueryResultDTO, 'rows' | 'truncated' | 'elapsedMs'>): string {
  const params = { count: data.rows.length, ms: data.elapsedMs }
  return data.truncated ? t('queryBlock.truncated', params) : t('queryBlock.footer', params)
}

/** TABLE column tracks, shared by the header and every row (rows use `subgrid`). */
export function tableColumnTemplate(columnCount: number): string {
  return `repeat(${Math.max(1, columnCount)}, minmax(6rem, auto))`
}

export function ResultView({ data, wsId }: { data: QueryResultDTO & { cached?: boolean }; wsId: string }) {
  const footer = <p className="mt-1.5 text-[11px] text-sub">{resultFooterText(data)}</p>
  if (data.rows.length === 0) {
    return <p className="text-xs text-sub">{t('queryBlock.noResults')}</p>
  }
  if (data.type === 'TABLE') {
    // ARIA table made of divs: a real <table> inside the editor DOM is picked up by BlockNote's
    // table-handle plugin, which assumes every table there is a table block.
    // One grid on the table element owns the column tracks; each row spans all columns and lays
    // its cells on those tracks with `subgrid`, so the widest cell of a column sizes it for every
    // row and the header (separate grids per row let each row size its own columns).
    const cols = (data.withoutId ? 0 : 1) + data.columns.length
    const table = { display: 'grid', gridTemplateColumns: tableColumnTemplate(cols) }
    const row = { display: 'grid', gridTemplateColumns: 'subgrid', gridColumn: '1 / -1' }
    const cell = 'border-b border-line/60 py-1 pr-3 align-top'
    return (
      <div>
        <div className="max-h-[480px] overflow-auto text-sm" role="table" style={table}>
          <div role="row" style={row} className="text-xs text-sub">
            {!data.withoutId && (
              <div role="columnheader" className="border-b border-line py-1 pr-3 font-medium">
                {t('common.page')}
              </div>
            )}
            {data.columns.map((c, i) => (
              <div key={i} role="columnheader" className="border-b border-line py-1 pr-3 font-medium">
                {c}
              </div>
            ))}
          </div>
          {data.rows.map((r) => (
            <div key={r.pageId} role="row" style={row}>
              {!data.withoutId && (
                <div role="cell" className={cell}>
                  <PageLink wsId={wsId} row={r} />
                </div>
              )}
              {r.cells.map((v, i) => (
                <div key={i} role="cell" className={cell}>
                  {formatValue(v)}
                </div>
              ))}
            </div>
          ))}
        </div>
        {footer}
      </div>
    )
  }
  if (data.type === 'TASK') {
    return (
      <div>
        <ul className="space-y-0.5">
          {data.rows.map((r) => (
            <li key={`${r.pageId}:${r.task?.blockId}`} className="flex items-baseline gap-2">
              <input type="checkbox" checked={!!r.task?.checked} readOnly disabled className="translate-y-px" />
              <span className={r.task?.checked ? 'text-sub line-through' : ''}>{r.task?.text}</span>
              <span className="text-xs text-sub">{r.task?.due}</span>
              <span className="text-xs">
                <PageLink wsId={wsId} row={r} />
              </span>
            </li>
          ))}
        </ul>
        {footer}
      </div>
    )
  }
  return (
    <div>
      <ul className="list-disc space-y-0.5 pl-5">
        {data.rows.map((r) => (
          <li key={r.pageId}>
            <PageLink wsId={wsId} row={r} />
            {r.cells.length > 0 && <span className="text-sub">: {formatValue(r.cells[0])}</span>}
          </li>
        ))}
      </ul>
      {footer}
    </div>
  )
}
