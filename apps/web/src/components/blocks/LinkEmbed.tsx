import { useState } from 'react'
import type { BlockNoteEditor, PartialBlock } from '@blocknote/core'
import { createReactBlockSpec } from '@blocknote/react'
import type { DefaultReactSuggestionItem } from '@blocknote/react'
import { EMBED_PROVIDER_LABELS, linkEmbedConfig, parseHttpUrl, toEmbed, type LinkEmbedDisplay } from '@inkling/shared'
import { useLinkPreview } from '../../api'
import { featureOffNow, useFeatureOff } from '../quota/features'
import { GlobeIcon, LinkIcon } from '../Icons'
import { t } from '../../i18n'
import { insertFromSlash, type SlashEditor } from '../../lib/slashInsert'

// Link embed block — one block type, two presentations:
//  - display 'embed': provider iframe (YouTube, Figma, …) built by toEmbed() at render time.
//    Only the user's original URL is stored; the iframe src is never read from block props,
//    so a collaborator cannot point the frame at an arbitrary origin.
//  - display 'card':  link preview card (GET /api/link-preview, server-side safeFetch).
// The toolbar under the block switches Embed / Card / plain Link — this is the "embed or link"
// choice offered right after pasting a URL into an empty line.
// Like pageEmbed/callout, the server's default schema does not know this block, so public
// share HTML and markdown export drop it (v1 limitation). See docs/adr/0501-*, 0502-*.

// UI strings — getters over the i18n dictionary, so nothing is frozen at import time.
const T = {
  get placeholder() { return t('linkEmbed.placeholder') },
  get invalid() { return t('linkEmbed.invalid') },
  get supported() { return t('linkEmbed.supported', { providers: EMBED_PROVIDER_LABELS.join(', ') }) },
  get embed() { return t('linkEmbed.embed') },
  get card() { return t('linkEmbed.card') },
  get link() { return t('linkEmbed.link') },
  get open() { return t('common.open') },
  get asEmbed() { return t('linkEmbed.asEmbed') },
  get asCard() { return t('linkEmbed.asCard') },
  get asLink() { return t('linkEmbed.asLink') },
  get openNew() { return t('linkEmbed.openNew') },
  get loading() { return t('linkEmbed.loading') },
  frameTitle: (label: string) => t('linkEmbed.frameTitle', { label }),
  get slashTitle() { return t('linkEmbed.slashTitle') },
  get slashSubtext() { return t('linkEmbed.slashSubtext') },
  get slashGroup() { return t('linkEmbed.slashGroup') },
}

export type { LinkEmbedDisplay }

function hostOf(url: string): string {
  return parseHttpUrl(url)?.hostname.replace(/^www\./, '') ?? url
}

function UrlInput({ onSubmit }: { onSubmit: (url: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  return (
    <form
      contentEditable={false}
      className="flex flex-col gap-1 rounded-md border border-line bg-hover/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        const u = parseHttpUrl(value)
        if (!u) return setError(true)
        onSubmit(u.href)
      }}
    >
      <div className="flex items-center gap-2">
        <LinkIcon size={15} className="shrink-0 text-sub" />
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(false)
          }}
          placeholder={T.placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-sub"
        />
      </div>
      <p className={`text-xs ${error ? 'text-red-600' : 'text-sub'}`}>{error ? T.invalid : T.supported}</p>
    </form>
  )
}

function LinkCard({ url }: { url: string }) {
  // DISABLED_FEATURES=link-preview (docs/adr/2507-*): no request, the card is the address alone
  const previewOff = useFeatureOff('link-preview')
  const q = useLinkPreview(previewOff ? undefined : url)
  const p = q.data
  const host = hostOf(p?.url ?? url)
  const href = parseHttpUrl(p?.url ?? url)?.href ?? parseHttpUrl(url)?.href
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      contentEditable={false}
      className="flex overflow-hidden rounded-md border border-line no-underline transition-colors duration-150 hover:bg-hover"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5">
        <span className="truncate text-sm font-medium text-ink">
          {p?.title ?? (q.isLoading ? T.loading : host)}
        </span>
        {p?.description && <span className="line-clamp-2 text-xs text-sub">{p.description}</span>}
        <span className="mt-auto flex items-center gap-1.5 text-xs text-sub">
          {p?.favicon ? (
            <img
              src={p.favicon}
              alt=""
              width={14}
              height={14}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="shrink-0 rounded-sm"
              onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
            />
          ) : (
            <GlobeIcon size={13} className="shrink-0" />
          )}
          <span className="truncate">{p?.siteName ?? host}</span>
        </span>
      </div>
      {p?.image && (
        <img
          src={p.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="hidden w-40 shrink-0 object-cover sm:block"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
        />
      )}
    </a>
  )
}

function EmbedFrame({ url }: { url: string }) {
  // DISABLED_FEATURES=embeds: the app's CSP allows no outside frame, so a blank frame would be all
  // there is; the block shows its link card instead (the stored block is unchanged)
  const embedsOff = useFeatureOff('embeds')
  if (embedsOff) return <LinkCard url={url} />
  return <EmbedFrameOn url={url} />
}

function EmbedFrameOn({ url }: { url: string }) {
  const info = toEmbed(url)
  if (!info) return <LinkCard url={url} />
  return (
    <div
      contentEditable={false}
      className="overflow-hidden rounded-md border border-line bg-hover/40"
      style={info.aspect ? { aspectRatio: String(info.aspect) } : { height: info.height }}
    >
      <iframe
        src={info.src}
        title={T.frameTitle(info.label)}
        sandbox={info.sandbox}
        allow={info.allow || undefined}
        allowFullScreen={info.allow.includes('fullscreen')}
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
        className="h-full w-full border-0"
      />
    </div>
  )
}

type AnyEditor = BlockNoteEditor<any, any, any>

/** A linkEmbed block for an editor whose schema includes linkEmbedSpec (checked by callers). */
function linkEmbedBlock(url: string, display: LinkEmbedDisplay): PartialBlock<any, any, any> {
  return { type: 'linkEmbed', props: { url, display } }
}

/** "Link" toolbar action: the block becomes a default-schema paragraph holding one link. */
function plainLinkParagraph(url: string): PartialBlock {
  return { type: 'paragraph', content: [{ type: 'link', href: url, content: url }] }
}

function Toolbar({
  url,
  display,
  onDisplay,
  onLink,
}: {
  url: string
  display: LinkEmbedDisplay
  onDisplay: (d: LinkEmbedDisplay) => void
  onLink: () => void
}) {
  const embedsOff = useFeatureOff('embeds')
  const canEmbed = !!toEmbed(url) && !embedsOff
  const btn = (active: boolean) =>
    `rounded px-1.5 py-0.5 transition-colors duration-150 hover:bg-hover hover:text-ink ${active ? 'text-ink' : ''}`
  return (
    <div contentEditable={false} className="mt-1 flex items-center gap-1 text-xs text-sub">
      <span className="mr-1 min-w-0 truncate">{hostOf(url)}</span>
      {canEmbed && (
        <button type="button" title={T.asEmbed} className={btn(display === 'embed')} onClick={() => onDisplay('embed')}>
          {T.embed}
        </button>
      )}
      <button type="button" title={T.asCard} className={btn(display === 'card' || !canEmbed)} onClick={() => onDisplay('card')}>
        {T.card}
      </button>
      <button type="button" title={T.asLink} className={btn(false)} onClick={onLink}>
        {T.link}
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" title={T.openNew} className={btn(false)}>
        {T.open}
      </a>
    </div>
  )
}

export const linkEmbedSpec = createReactBlockSpec(linkEmbedConfig, {
  render: ({ block, editor }) => {
    const url = parseHttpUrl(block.props.url)?.href ?? ''
    const display = (block.props.display === 'card' ? 'card' : 'embed') as LinkEmbedDisplay
    const ed = editor as unknown as AnyEditor
    if (!url) {
      return (
        <div className="w-full">
          <UrlInput
            onSubmit={(u) =>
              ed.updateBlock(block, { type: 'linkEmbed', props: { url: u, display: toEmbed(u) && !featureOffNow('embeds') ? 'embed' : 'card' } })
            }
          />
        </div>
      )
    }
    const showEmbed = display === 'embed' && !!toEmbed(url)
    return (
      <div className="w-full">
        {showEmbed ? <EmbedFrame url={url} /> : <LinkCard url={url} />}
        <Toolbar
          url={url}
          display={display}
          onDisplay={(d) => ed.updateBlock(block, { type: 'linkEmbed', props: { display: d } })}
          onLink={() => ed.updateBlock(block, plainLinkParagraph(url))}
        />
      </div>
    )
  },
  // Outside the editor (copy / client HTML export) fall back to a plain link so the URL survives.
  toExternalHTML: ({ block }) => {
    const url = parseHttpUrl(block.props.url)?.href
    return url ? (
      <p>
        <a href={url}>{url}</a>
      </p>
    ) : (
      <p />
    )
  },
})()

/**
 * Paste handler hook-in: when a single bare http(s) URL is pasted into an EMPTY paragraph with
 * a collapsed selection, turn that paragraph into a linkEmbed block (embed if the provider is
 * supported, otherwise a preview card). Returns true when handled. Everything else — URLs
 * pasted into text, selections (link-ify), code blocks — falls through to the default handler.
 */
export function handleUrlPaste(event: ClipboardEvent, editor: AnyEditor): boolean {
  try {
    const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
    const u = parseHttpUrl(text)
    if (!u) return false
    if (!('linkEmbed' in editor.schema.blockSchema)) return false
    const pm = (editor as unknown as { prosemirrorState?: { selection: { empty: boolean } } }).prosemirrorState
    if (pm && !pm.selection.empty) return false
    const cur = editor.getTextCursorPosition().block
    const empty =
      cur.type === 'paragraph' &&
      (!Array.isArray(cur.content) || cur.content.length === 0) &&
      (!Array.isArray(cur.children) || cur.children.length === 0)
    if (!empty) return false
    // with embeds and link previews both off on this server, a pasted address stays a plain link
    if (embedsAndPreviewsOff()) return false
    const block = linkEmbedBlock(u.href, toEmbed(u.href) && !featureOffNow('embeds') ? 'embed' : 'card')
    const [inserted] = editor.replaceBlocks([cur], [block]).insertedBlocks
    // Leave an empty line after the embed so typing can continue.
    if (inserted) {
      const [para] = editor.insertBlocks([{ type: 'paragraph' }], inserted, 'after')
      if (para) editor.setTextCursorPosition(para, 'start')
    }
    event.preventDefault()
    return true
  } catch {
    return false
  }
}

/** DISABLED_FEATURES has both `embeds` and `link-preview` (the demo preset). */
function embedsAndPreviewsOff(): boolean {
  return featureOffNow('embeds') && featureOffNow('link-preview')
}

/** Slash-menu entry: inserts an empty linkEmbed block that asks for a URL. */
export function linkEmbedSlashItems(editor: AnyEditor): DefaultReactSuggestionItem[] {
  if (!('linkEmbed' in editor.schema.blockSchema)) return []
  // nothing to embed and no preview to show: the menu has no entry (a link stays a link)
  if (embedsAndPreviewsOff()) return []
  return [
    {
      title: T.slashTitle,
      subtext: T.slashSubtext,
      // Aliases are search data, not display text: English and Korean are kept in every locale.
      aliases: ['embed', 'link', 'bookmark', 'youtube', 'figma', 'video', 'iframe', 'card', '임베드', '링크', '북마크', '유튜브', '피그마', '동영상', '카드'],
      // Own "Embeds" group (BlockNote has no matching built-in group).
      group: T.slashGroup,
      icon: <GlobeIcon size={16} />,
      // the empty embed focuses its own URL field
      onItemClick: () => {
        insertFromSlash(editor as unknown as SlashEditor, linkEmbedBlock('', 'embed'), 'own')
      },
    },
  ]
}
