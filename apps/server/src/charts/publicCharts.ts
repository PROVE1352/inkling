/**
 * Charts on public share pages (docs/adr/2440-*, amends 1605).
 *
 * A chart block becomes two ordinary blocks, a bold title (if it has one) and a table of its aggregate,
 * whose block ids are a per-render anchor (`anchor`, `anchor-t`), plus one `PublicChartDTO` (labels and
 * numbers only, `publicChartOf`) in the page response. The viewer draws the chart there and hides the
 * table from the screen; without the chart chunk (no script, a crawler, an old client) the table stays.
 * The config (source, collection / view / field ids, query text, options) never leaves the server, and
 * `md/convert.ts publicBlocks` still drops any chart block that is left.
 *
 * Where the numbers come from, per chart, first match:
 *  1. the link has "include charts" on and the manager who turned it on (`pages.share_charts_by`) is
 *     still a member of the workspace: `exportFor` as that person, the Markdown export's path (a
 *     collection of this workspace they can see and a view of it, or a query run as them);
 *  2. a folder link: `publicFor`, a collection inside the link (shared rows, no relation titles);
 *  3. nothing: the chart is left out, with no title.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { chartDataOfPublic, chartTableMarkdown, parseChartBlockConfig, publicChartOf } from '@inkling/shared'
import type { ChartBlockConfig, PublicChartDTO } from '@inkling/shared'
import { db } from '../db/index'
import { pageDocs, users, workspaceMembers } from '../db/schema'
import { markdownToBlocks, stateToBlocks } from '../md/convert'
import type { AnyBlock } from '../md/convert'
import { chartTitleMarkdown, exportFor, exportTarget, publicFor, publicTarget, replaceChartBlocks } from './render'
import type { ChartDataFn, SharedLookup } from './render'

/** The link's chart setting as stored on the shared page. */
export interface ShareChartsSetting {
  includeCharts: boolean
  chartsBy: string | null
}

/**
 * The account whose access public charts use: the manager who turned "include charts" on, while they
 * are a member of the workspace (a guest's page grants do not count). Null when off or no longer valid.
 * Checked on every request, before the render cache (docs/adr/2440-*).
 */
export async function chartsEnabler(workspaceId: string, setting: ShareChartsSetting): Promise<string | null> {
  if (!setting.includeCharts || !setting.chartsBy) return null
  const [m] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, setting.chartsBy)))
    .limit(1)
  return m ? m.userId : null
}

export interface PublicChartSources {
  workspaceId: string
  /** chart data as this member ("include charts" on and still a member) */
  enablerId?: string | null
  /** pages inside a folder link (its collections' charts show without the setting) */
  inside?: SharedLookup
}

/** Chart data for a public page, in the order above. */
export function publicChartData(src: PublicChartSources): ChartDataFn {
  const asEnabler = src.enablerId ? exportFor(src.enablerId, src.workspaceId) : null
  const inside = src.inside ? publicFor(src.workspaceId, src.inside) : null
  return async (cfg) => {
    if (asEnabler) {
      try {
        const d = await asEnabler(cfg)
        if (d) return d
      } catch {
        // fall through: an error is "not available" for this source
      }
    }
    return inside ? inside(cfg) : null
  }
}

/** Would the public page show this chart (its source resolves)? The share dialog's count; nothing is aggregated. */
async function publicChartShown(src: PublicChartSources, cfg: ChartBlockConfig): Promise<boolean> {
  if (src.enablerId) {
    try {
      if (await exportTarget(src.enablerId, src.workspaceId, cfg)) return true
    } catch {
      // two-step verification required of the enabler and the like: not shown that way
    }
  }
  return src.inside ? (await publicTarget(src.workspaceId, src.inside, cfg)) !== null : false
}

/** A chart's public stand-in: [title], table, with the anchor ids the viewer looks for. */
async function placeholderBlocks(chart: PublicChartDTO): Promise<AnyBlock[]> {
  const out: AnyBlock[] = []
  if (chart.title) {
    const [title] = await markdownToBlocks(chartTitleMarkdown(chart.title), () => null)
    if (title) out.push({ ...title, id: chart.anchor })
  }
  // the table is written from the public form, so it carries exactly what the chart does
  const table = await markdownToBlocks(chartTableMarkdown(chartDataOfPublic(chart), { empty: 'No value' }), () => null)
  table.forEach((b, i) => out.push(i === 0 ? { ...b, id: `${chart.anchor}-t` } : b))
  return out
}

/**
 * Replaces chart blocks with their public stand-ins and collects the charts into `out` (one list per
 * response, so anchors stay unique across embedded pages). Charts without data are left out.
 */
export function publicChartPlacer(dataFor: ChartDataFn, out: PublicChartDTO[]): (blocks: AnyBlock[]) => Promise<AnyBlock[]> {
  // anchors are new for every render: a block id written into a page cannot stand in for a chart
  const nonce = randomBytes(6).toString('hex')
  return (blocks) =>
    replaceChartBlocks(blocks, async (cfg) => {
      const data = await dataFor(cfg)
      if (!data) return null
      const chart = publicChartOf(`ic-${nonce}-${out.length}`, cfg, data)
      out.push(chart)
      return placeholderBlocks(chart)
    })
}

// ---------------------------------------------------------------------------
// Share dialog: how many charts the public page leaves out (docs/adr/2440-*)
// ---------------------------------------------------------------------------

/** At most this many pages of a folder link are read for the count. */
const COUNT_PAGE_CAP = 300

function chartConfigs(blocks: AnyBlock[], out: (ChartBlockConfig | null)[]): void {
  for (const b of blocks) {
    if (b.type === 'chart') out.push(parseChartBlockConfig(b.props?.config))
    if (Array.isArray(b.children) && b.children.length) chartConfigs(b.children, out)
  }
}

/**
 * Chart blocks on `docIds` (the page of a single-page link, the doc pages of a folder link) and how many
 * of them the public page leaves out. Undefined when there are none.
 */
export async function shareChartCounts(docIds: string[], src: PublicChartSources): Promise<{ total: number; hidden: number } | undefined> {
  const ids = docIds.slice(0, COUNT_PAGE_CAP)
  if (!ids.length) return undefined
  // only documents whose bytes hold the block name: the Yjs state stores it as plain UTF-8 (a page that
  // merely says "chart" in its text is decoded for nothing, which is still correct)
  const rows = await db
    .select({ state: pageDocs.state })
    .from(pageDocs)
    .where(and(inArray(pageDocs.pageId, ids), sql`position(convert_to('chart', 'UTF8') in ${pageDocs.state}) > 0`))
  const configs: (ChartBlockConfig | null)[] = []
  for (const r of rows) {
    try {
      chartConfigs(stateToBlocks(r.state), configs)
    } catch {
      // an unreadable document shows nothing publicly either
    }
  }
  if (!configs.length) return undefined
  let hidden = 0
  for (const cfg of configs) if (!cfg || !(await publicChartShown(src, cfg))) hidden++
  return { total: configs.length, hidden }
}

/** Display name of the member whose access a link's charts use (the share dialog), or null. */
export async function chartsByName(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
  return u?.name ?? null
}
