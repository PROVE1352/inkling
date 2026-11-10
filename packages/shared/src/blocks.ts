// Custom block and inline node configs shared by the web editor and the server's BlockNote schema
// (docs/adr/1500-agent-markdown-notation-for-custom-nodes.md, following docs/adr/0995-*).
//
// y-prosemirror deletes the Yjs items of nodes the reading schema does not know, so the server must
// know every node the web editor writes, with the same name, props and defaults. Both sides build
// their specs from these objects; the web adds React renders, the server plain DOM renders.
// A different name, prop or default makes the schemas disagree and a server read would drop the node.

import { inlineMathConfig, mathBlockConfig } from './math'

/** Callout types (the `type` prop); also the `> [!type]` words of the Markdown notation. */
export type CalloutType = 'note' | 'tip' | 'warning' | 'danger' | 'info'
export const CALLOUT_TYPES: CalloutType[] = ['note', 'tip', 'warning', 'danger', 'info']

export const calloutConfig = {
  type: 'callout' as const,
  propSchema: {
    type: { default: 'note' as const, values: CALLOUT_TYPES },
  },
  content: 'inline' as const,
} as const

/**
 * Page embed (`pageId` of the embedded page; content none). When `pageId` is a collection the block
 * is an inline database view (docs/adr/2120-*): `viewId` names one of its views ('' = the first),
 * and the rows are read for each viewer, never stored. `viewId` is a prop of the node every client
 * since 0.1 knows, so an older client keeps the block (it shows a page card) instead of dropping an
 * unknown node (CHART-2).
 */
export const pageEmbedConfig = {
  type: 'pageEmbed' as const,
  propSchema: { pageId: { default: '' }, viewId: { default: '' } },
  content: 'none' as const,
}

export type LinkEmbedDisplay = 'embed' | 'card'

/** Link embed / preview card (docs/adr/0501-*). */
export const linkEmbedConfig = {
  type: 'linkEmbed' as const,
  propSchema: {
    url: { default: '' },
    display: { default: 'embed' as LinkEmbedDisplay, values: ['embed', 'card'] as LinkEmbedDisplay[] },
  },
  content: 'none' as const,
}

/** Plugin API v0 block: `data` is a JSON string (≤ 16 KB) the plugin renders. */
export const pluginBlockConfig = {
  type: 'pluginBlock' as const,
  propSchema: {
    pluginId: { default: '' },
    blockType: { default: '' },
    data: { default: '{}' },
  },
  content: 'none' as const,
} as const

/**
 * Chart block (docs/adr/1600-*): `config` is the canonical JSON of a ChartBlockConfig (charts.ts),
 * '' while the block is being set up. Data is never stored: it is aggregated for each viewer.
 */
export const chartBlockConfig = {
  type: 'chart' as const,
  propSchema: {
    config: { default: '' },
  },
  content: 'none' as const,
} as const

/** @mention chip (inline atom): kind 'user' | 'page', the target id and the label shown. */
export const mentionConfig = {
  type: 'mention' as const,
  propSchema: {
    kind: { default: 'user' },
    id: { default: '' },
    label: { default: '' },
  },
  content: 'none',
} as const

/**
 * Every custom block and inline node type the web editor writes. Each schema that reads a page's
 * Yjs doc must know all of them, or y-prosemirror deletes the unknown nodes from the doc it reads:
 * the web editor, the read-only page-embed viewer (bound to the embedded page's live doc,
 * docs/adr/1539-*) and the server schema. The web builds both of its schemas from one spec map
 * that `satisfies` these lists, so a type added here and not registered there fails typecheck.
 */
export const CUSTOM_BLOCK_TYPES = [
  calloutConfig.type,
  pageEmbedConfig.type,
  linkEmbedConfig.type,
  pluginBlockConfig.type,
  mathBlockConfig.type,
  chartBlockConfig.type,
] as const
export type CustomBlockType = (typeof CUSTOM_BLOCK_TYPES)[number]

export const CUSTOM_INLINE_CONTENT_TYPES = [mentionConfig.type, inlineMathConfig.type] as const
export type CustomInlineContentType = (typeof CUSTOM_INLINE_CONTENT_TYPES)[number]
