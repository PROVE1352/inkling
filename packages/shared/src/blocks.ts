// Custom block and inline node configs shared by the web editor and the server's BlockNote schema
// (docs/adr/1500-agent-markdown-notation-for-custom-nodes.md, following docs/adr/0995-*).
//
// y-prosemirror deletes the Yjs items of nodes the reading schema does not know, so the server must
// know every node the web editor writes, with the same name, props and defaults. Both sides build
// their specs from these objects; the web adds React renders, the server plain DOM renders.
// A different name, prop or default makes the schemas disagree and a server read would drop the node.

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

/** Page embed (`pageId` of the embedded page; content none). */
export const pageEmbedConfig = {
  type: 'pageEmbed' as const,
  propSchema: { pageId: { default: '' } },
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
