import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from '@blocknote/core'
import { en as bnEn, ko as bnKo } from '@blocknote/core/locales'
import { codeBlockOptions } from '../../lib/codeBlockOptions'
import { createReactBlockSpec, useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import {
  pageEmbedConfig,
  type CustomBlockType,
  type CustomInlineContentType,
  type PageMetaDTO,
} from '@inkling/shared'
import { useMe, usePages } from '../../api'
import { openCollab, readStatus } from '../../lib/collabSocket'
import { internalLinkClick } from '../../lib/internalLinks'
import { PageIconGlyph } from '../PageIconGlyph'
import { useTheme } from '../../lib/theme'
import { LinkIcon, LockIcon } from '../Icons'
import { getLocale, useT } from '../../i18n'
import { inlineMathSpec, mathBlockSpec } from './Math'
import { calloutSpec } from './Callout'
import { linkEmbedSpec } from './LinkEmbed'
import { chartBlockSpec } from './ChartBlock'
import { buttonBlockSpec } from './ButtonBlock'
import { columnListSpec, columnSpec } from './Columns'
import { mentionSpec } from './Mention'
import { pluginBlockSpec } from '../../plugins/PluginBlock'
import { DbViewEmbed, DbViewSetup, DbViewUnavailable } from './DbViewEmbed'

// pageEmbed custom block (`![[transclusion]]`).
// - prop: pageId. content 'none' (no inline content) → not a PM cursor/edit target.
// - full variant (main schema): title card + read-only render of the target body via a 2nd HocuspocusProvider.
// - shallow variant (embedSchema): card only — the read-only viewer uses the shallow schema so an
//   embed inside an embed cannot spawn providers endlessly (recursion guard).

type ConnStatus = 'connected' | 'connecting' | 'disconnected'

// Card header — icon + title; click navigates (SPA) to the target page. Shared by full/shallow.
function PageEmbedHeader({
  pageId,
  target,
  loaded,
}: {
  pageId: string
  target: PageMetaDTO | undefined
  loaded: boolean
}) {
  const { wsId } = useParams()
  const navigate = useNavigate()
  const t = useT()

  if (!pageId) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-sub">
        {t('pageEmbed.noPage')}
      </div>
    )
  }
  if (loaded && !target) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-sub">
        <LockIcon size={13} /> {t('pageEmbed.noAccess')}
      </div>
    )
  }
  return (
    <button
      type="button"
      contentEditable={false}
      onClick={() => wsId && navigate(`/w/${wsId}/p/${pageId}`)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
    >
      <span className="shrink-0 text-base leading-none">
        <PageIconGlyph page={target ?? { icon: null, kind: 'doc' }} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        {target?.title || (loaded ? t('common.untitled') : t('common.loading'))}
      </span>
      <LinkIcon size={13} className="shrink-0 text-sub" />
    </button>
  )
}

// Read-only render of the target page body. Mounted only once access is confirmed. The provider is created in
// an effect on the tab-wide socket (lib/collabSocket.ts, docs/adr/0702-*) and released on unmount —
// an embed no longer opens its own WebSocket.
function PageEmbedBody({ pageId }: { pageId: string }) {
  const me = useMe()
  const userKey = me.data?.id ?? ''
  const [doc] = useState(() => new Y.Doc())
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
  const [synced, setSynced] = useState(false)
  const [status, setStatus] = useState<ConnStatus>('connecting')

  useEffect(() => {
    if (!userKey) return
    const handle = openCollab({ name: pageId, document: doc, userKey })
    const p = handle.provider
    // On the shared socket the socket status says nothing about *this* document: a denied
    // (or revoked) document must still show as disconnected.
    let denied = false
    const onStatus = () => setStatus(denied ? 'disconnected' : readStatus(p))
    const onDenied = () => {
      denied = true
      setStatus('disconnected')
    }
    p.on('authenticationFailed', onDenied)
    const onSynced = (e: { state: boolean }) => setSynced(e.state)
    p.on('status', onStatus)
    p.on('synced', onSynced)
    setSynced(p.isSynced)
    onStatus()
    setProvider(p)
    return () => {
      p.off('status', onStatus)
      p.off('authenticationFailed', onDenied)
      p.off('synced', onSynced)
      handle.release()
    }
  }, [doc, pageId, userKey])

  useEffect(() => () => doc.destroy(), [doc])

  return <PageEmbedViewer doc={doc} provider={provider} synced={synced} status={status} />
}

function PageEmbedViewer({
  doc,
  provider,
  synced,
  status,
}: {
  doc: Y.Doc
  provider: HocuspocusProvider | null
  synced: boolean
  status: ConnStatus
}) {
  const { resolved } = useTheme()
  const navigate = useNavigate()
  const t = useT()

  // Read-only viewer — no awareness (viewing an embed must not pollute the target page's online list).
  // The editor binds to the doc's fragment only, so it does not depend on the provider.
  const editor = useCreateBlockNote(
    {
      schema: embedSchema,
      collaboration: {
        fragment: doc.getXmlFragment('document'),
        user: { name: '', color: '#888888' },
        provider: { awareness: undefined },
      },
      // Same rule as CollabEditor: BlockNote strings follow the app locale (the app remounts on change).
      dictionary: getLocale() === 'ko' ? bnKo : bnEn,
    },
    [doc],
  )

  // A plain click on an internal link (/w/...) inside the embed body → SPA navigation (once: the outer
  // editor's capture handler runs first and marks the click handled). Modified and middle clicks are
  // the browser's: the body is read-only, so it follows the link itself (lib/internalLinks.ts).
  const onClickCapture = (e: React.MouseEvent) => {
    if (internalLinkClick(e, navigate)) e.stopPropagation()
  }

  return (
    <div
      contentEditable={false}
      onClickCapture={onClickCapture}
      className="nd-embed-body max-h-[420px] overflow-y-auto border-t border-line bg-app/40 py-1"
    >
      {provider && status === 'disconnected' && !synced ? (
        <p className="px-3 py-2 text-xs text-sub">{t('pageEmbed.loadFailed')}</p>
      ) : !synced ? (
        <p className="px-3 py-2 text-xs text-sub">{t('pageEmbed.loadingBody')}</p>
      ) : (
        <BlockNoteView editor={editor} editable={false} theme={resolved} />
      )}
    </div>
  )
}

type EmbedEditor = { isEditable: boolean; updateBlock: (id: string, update: { props: Record<string, string> }) => unknown }

// Full variant — card + read-only body (when accessible). A collection target is an inline database
// view (DbViewEmbed.tsx, docs/adr/2120-*); an empty block from the slash menu asks for one.
function PageEmbedFull({ pageId, viewId, blockId, editor }: { pageId: string; viewId: string; blockId: string; editor: EmbedEditor }) {
  const { wsId } = useParams()
  const pages = usePages(wsId ?? '')
  const target = (pages.data ?? []).find((p) => p.id === pageId)
  const loaded = !!pages.data

  if (!pageId && editor.isEditable && wsId) {
    return <DbViewSetup wsId={wsId} onPick={(collectionId, view) => editor.updateBlock(blockId, { props: { pageId: collectionId, viewId: view } })} />
  }
  if (target?.kind === 'collection' && wsId) {
    return (
      <DbViewEmbed
        wsId={wsId}
        target={target}
        viewId={viewId}
        editable={editor.isEditable}
        onSetView={(id) => editor.updateBlock(blockId, { props: { viewId: id } })}
      />
    )
  }
  // a database view whose database this reader cannot see (or that is in the trash)
  if (loaded && !target && pageId && viewId) {
    return (
      <div contentEditable={false} className="my-1.5 overflow-hidden rounded-lg border border-line">
        <DbViewUnavailable />
      </div>
    )
  }

  return (
    <div
      contentEditable={false}
      className="my-1.5 overflow-hidden rounded-lg border border-line"
    >
      <PageEmbedHeader pageId={pageId} target={target} loaded={loaded} />
      {!!pageId && loaded && !!target && <PageEmbedBody pageId={pageId} />}
    </div>
  )
}

// Shallow variant — card only (recursion guard). Used for pageEmbeds met inside an embed.
function PageEmbedShallow({ pageId }: { pageId: string }) {
  const { wsId } = useParams()
  const pages = usePages(wsId ?? '')
  const target = (pages.data ?? []).find((p) => p.id === pageId)
  const loaded = !!pages.data

  return (
    <div
      contentEditable={false}
      className="my-1 overflow-hidden rounded-lg border border-line"
    >
      <PageEmbedHeader pageId={pageId} target={target} loaded={loaded} />
    </div>
  )
}

// Shallow variant spec — card only, so a pageEmbed met inside an embed does not create a provider.
const pageEmbedShallowSpec = createReactBlockSpec(pageEmbedConfig, {
  render: ({ block }) => <PageEmbedShallow pageId={block.props.pageId} />,
})()

/**
 * Block and inline specs of the editor schema — the one list both schemas are built from: the main
 * editor (CollabEditor) and the read-only embed viewer below. The viewer is bound to the embedded
 * page's LIVE Yjs doc and y-prosemirror deletes the nodes its schema does not know, so it must know
 * every node the editor writes (docs/adr/1539-*, 0995-*). The callers differ only in renders of the
 * same node types: pageEmbed (full card + body vs. card only, the recursion guard), codeBlock
 * (with or without live query results, which need the editor's QueryBlockPortals) and image (the
 * editor's adds a "View larger" button, docs/adr/2386-*; same config and parsing as BlockNote's).
 *
 * The custom maps `satisfies` the shared type lists in @inkling/shared (CUSTOM_BLOCK_TYPES,
 * CUSTOM_INLINE_CONTENT_TYPES), so a node added there and not registered here fails typecheck.
 * Each custom spec shares its config (name, props, defaults) with the server schema (docs/adr/1500-*).
 */
export function editorSchemaSpecs(renders: {
  pageEmbed: typeof pageEmbedShallowSpec
  codeBlock: ReturnType<typeof createCodeBlockSpec>
  image?: typeof defaultBlockSpecs.image
  file?: typeof defaultBlockSpecs.file
}) {
  const customBlockSpecs = {
    // Page embed `![[...]]` (M12).
    pageEmbed: renders.pageEmbed,
    // Callout (M14). Markdown: `> [!type] text`.
    callout: calloutSpec,
    // Plugin API v0 placeholder block — always registered so plugin block data survives even
    // when plugins are off (renders an inert card). See apps/web/src/plugins/PluginBlock.tsx.
    pluginBlock: pluginBlockSpec,
    // Link embed / preview card (YouTube, Figma, … or OG card). docs/adr/0501-*, 0502-*
    linkEmbed: linkEmbedSpec,
    // Display equation (KaTeX); Markdown `$$…$$` (docs/adr/0995-*, 0996-*).
    math: mathBlockSpec,
    // Chart from a collection or a query (docs/adr/1600-*); data fetched per viewer, never stored.
    chart: chartBlockSpec,
    // Button: actions run by whoever presses it, through their own REST rights (docs/adr/2244-*).
    button: buttonBlockSpec,
    // Columns: a group of 2–4 columns of ordinary blocks (docs/adr/2420-*).
    columnList: columnListSpec,
    column: columnSpec,
  } satisfies Record<CustomBlockType, unknown>
  const customInlineContentSpecs = {
    // @mention chip (M13).
    mention: mentionSpec,
    // Inline equation `$…$`.
    inlineMath: inlineMathSpec,
  } satisfies Record<CustomInlineContentType, unknown>
  return {
    // Code block highlighting is injected via the schema, not an editor option (Appendix A).
    blockSpecs: { ...defaultBlockSpecs, codeBlock: renders.codeBlock, image: renders.image ?? defaultBlockSpecs.image, file: renders.file ?? defaultBlockSpecs.file, ...customBlockSpecs },
    inlineContentSpecs: { ...defaultInlineContentSpecs, ...customInlineContentSpecs },
  }
}

// Schema for the read-only embed viewer: every node of the main schema, pageEmbed shallow (nested
// embeds do not create new providers) and the plain highlighted code block (no query results).
export const embedSchema = BlockNoteSchema.create(
  editorSchemaSpecs({
    pageEmbed: pageEmbedShallowSpec,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  }),
)

// Full-variant BlockSpec that joins the main editor schema.
export const pageEmbedSpec = createReactBlockSpec(pageEmbedConfig, {
  render: ({ block, editor }) => (
    <PageEmbedFull
      pageId={block.props.pageId}
      viewId={block.props.viewId}
      blockId={block.id}
      editor={editor as unknown as EmbedEditor}
    />
  ),
})()
