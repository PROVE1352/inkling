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
import type { PageMetaDTO } from '@inkling/shared'
import { useMe, usePages } from '../../api'
import { openCollab, readStatus } from '../../lib/collabSocket'
import { PageIconGlyph } from '../PageIconGlyph'
import { useTheme } from '../../lib/theme'
import { LinkIcon, LockIcon } from '../Icons'
import { getLocale, useT } from '../../i18n'
import { inlineMathSpec, mathBlockSpec } from './Math'

// pageEmbed custom block (`![[transclusion]]`).
// - prop: pageId. content 'none' (no inline content) → not a PM cursor/edit target.
// - full variant (main schema): title card + read-only render of the target body via a 2nd HocuspocusProvider.
// - shallow variant (embedSchema): card only — the read-only viewer uses the shallow schema so an
//   embed inside an embed cannot spawn providers endlessly (recursion guard).

type ConnStatus = 'connected' | 'connecting' | 'disconnected'

const pageEmbedConfig = {
  type: 'pageEmbed' as const,
  propSchema: { pageId: { default: '' } },
  content: 'none' as const,
}

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

  // Wikilink (/w/...) clicks inside the embed body → SPA navigation. stopPropagation prevents the
  // outer editor from handling it twice.
  const onClickCapture = (e: React.MouseEvent) => {
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
    if (href && href.startsWith('/w/')) {
      e.preventDefault()
      e.stopPropagation()
      navigate(href)
    }
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

// Full variant — card + read-only body (when accessible).
function PageEmbedFull({ pageId }: { pageId: string }) {
  const { wsId } = useParams()
  const pages = usePages(wsId ?? '')
  const target = (pages.data ?? []).find((p) => p.id === pageId)
  const loaded = !!pages.data

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

// Schema for the read-only embed viewer — pageEmbed is shallow (card only), so nested embeds do
// not create new providers. Code block highlighting is injected the same way in the viewer.
const pageEmbedShallowSpec = createReactBlockSpec(pageEmbedConfig, {
  render: ({ block }) => <PageEmbedShallow pageId={block.props.pageId} />,
})()

// Math nodes are registered here too: the viewer is bound to the live Yjs doc, and y-prosemirror
// deletes nodes its schema does not know (docs/adr/0995-*).
const embedSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    pageEmbed: pageEmbedShallowSpec,
    math: mathBlockSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineMath: inlineMathSpec,
  },
})

// Full-variant BlockSpec that joins the main editor schema.
export const pageEmbedSpec = createReactBlockSpec(pageEmbedConfig, {
  render: ({ block }) => <PageEmbedFull pageId={block.props.pageId} />,
})()
