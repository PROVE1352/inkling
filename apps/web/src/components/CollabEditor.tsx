import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { BlockNoteSchema, type BlockNoteEditor } from '@blocknote/core'
import { en as bnEn, ko as bnKo } from '@blocknote/core/locales'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import type { UserDTO } from '@inkling/shared'
import { qk, uploadFile } from '../api'
import { userColor } from '../lib/colors'
import { openCollab, readStatus, readUsers, sameUsers } from '../lib/collabSocket'
import { capUndoHistory } from '../lib/undoCap'
import { pinAnchor } from '../lib/pinAnchor'
import { revealBlock } from '../lib/headingFolds'
import { inklingShortcuts, useEditorPaletteCommands } from '../lib/shortcuts/editorKeys'
import { useTheme } from '../lib/theme'
import { editorSchemaSpecs, pageEmbedSpec } from './blocks/PageEmbed'
import { QueryBlockPortals, queryCodeBlockSpec } from './blocks/QueryBlock'
import { handleUrlPaste } from './blocks/LinkEmbed'
import type { CollabUser } from './OnlineUsers'
import { WikilinkMenu } from './WikilinkMenu'
import { MentionMenu } from './MentionMenu'
import { SlashMenu } from './SlashMenu'
import { getLocale, t, useT } from '../i18n'

/** BlockNote's dictionary for the app locale, with our own empty-block hint (BlockNote's Korean one
 *  repeats "입력" three times). Block-type hints (heading, list) stay BlockNote's. */
function editorDictionary() {
  const base = getLocale() === 'ko' ? bnKo : bnEn
  return { ...base, placeholders: { ...base.placeholders, default: t('editor.placeholder') } }
}

// Loose type so parents (PageView etc.) can share the editor instance
export type InklingEditor = BlockNoteEditor<any, any, any>

export type ConnStatus = 'connected' | 'connecting' | 'disconnected'

export type CollabState = {
  status: ConnStatus
  synced: boolean
  users: CollabUser[]
  /**
   * Scope the server granted this connection ('read-write' by default; 'readonly' e.g. on a page
   * locked for the caller). Undefined until authenticated. Edits on a read-only connection are
   * dropped by the server, so the editor must not be editable then.
   */
  scope?: string
}

// One spec list for this schema and the page-embed viewer's (editorSchemaSpecs, docs/adr/1539-*):
// the custom nodes share their configs with the server schema (@inkling/shared, docs/adr/1500-*),
// so server reads keep them. Here pageEmbed renders the target body and code blocks in language
// `dataview` render live query results (docs/QUERY.md).
const schema = BlockNoteSchema.create(
  editorSchemaSpecs({ pageEmbed: pageEmbedSpec, codeBlock: queryCodeBlockSpec }),
)

export function CollabEditor({
  pageId,
  wsId,
  me,
  onCollabChange,
  onEditorReady,
  readOnly = false,
}: {
  pageId: string
  wsId: string
  me: UserDTO
  onCollabChange?: (state: CollabState) => void
  onEditorReady?: (editor: InklingEditor | null) => void
  /** Ink mode or an edit lock — the body is not editable */
  readOnly?: boolean
}) {
  // M16: on a stateless broadcast ({t:'comments'}) invalidate the comments cache so it shows at once.
  const queryClient = useQueryClient()
  const t = useT()

  // The component is fully remounted per pageId (key), so there is one doc per mount.
  const [doc] = useState(() => new Y.Doc())
  // The provider is created in an effect on the tab-wide socket (lib/collabSocket.ts,
  // docs/adr/0702-*): never during render, so a discarded render cannot leak a live provider.
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null)
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [synced, setSynced] = useState(false)
  const [users, setUsers] = useState<CollabUser[]>([])
  const [scope, setScope] = useState<string | undefined>(undefined)

  useEffect(() => {
    const handle = openCollab({
      name: pageId,
      document: doc,
      userKey: me.id,
      // Stateless notices the server sends on this page's channel. On a comment change, refetch
      // immediately instead of waiting for the poll. Parse failures are ignored.
      onStateless: ({ payload }) => {
        try {
          if (JSON.parse(payload)?.t === 'comments') {
            queryClient.invalidateQueries({ queryKey: qk.comments(pageId) })
          }
        } catch {
          // ignore malformed payloads
        }
      },
    })
    const p = handle.provider
    // Subscribe in the same tick as construction (network events are async, so nothing is
    // missed), then read the current state defensively.
    // On the shared socket the socket status says nothing about *this* document: a denied
    // (or revoked) document must still show as disconnected.
    let denied = false
    const onStatus = () => setStatus(denied ? 'disconnected' : readStatus(p))
    const onDenied = () => {
      denied = true
      setStatus('disconnected')
    }
    p.on('authenticationFailed', onDenied)
    // Every (re)authentication carries the granted scope: the server closes live sockets when a
    // lock changes, so the reconnect brings the new scope. Not reset on disconnect.
    const onAuthenticated = () => setScope(p.authorizedScope)
    p.on('authenticated', onAuthenticated)
    // In 2.15 the 'synced' payload is onSyncedParameters = { state: boolean }
    const onSynced = (e: { state: boolean }) => setSynced(e.state)
    p.on('status', onStatus)
    p.on('synced', onSynced)
    // Awareness 'change' fires on every remote cursor move; only push a new users array when
    // the list really changed (docs/adr/0700-*) — otherwise PageView re-renders per keystroke.
    let last: CollabUser[] = []
    const onAwareness = () => {
      const next = readUsers(p)
      if (!sameUsers(last, next)) {
        last = next
        setUsers(next)
      }
    }
    p.awareness?.on('change', onAwareness)
    onAwareness()
    setSynced(p.isSynced)
    onStatus()
    if (p.isAuthenticated) onAuthenticated()
    setProvider(p)
    return () => {
      p.off('status', onStatus)
      p.off('authenticationFailed', onDenied)
      p.off('authenticated', onAuthenticated)
      p.off('synced', onSynced)
      p.awareness?.off('change', onAwareness)
      handle.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageId, me.id])

  useEffect(() => () => doc.destroy(), [doc])

  // Report collab state to the parent (PageView) — for the top-bar connection dot / online users
  useEffect(() => {
    onCollabChange?.({ status, synced, users, scope })
  }, [status, synced, users, scope, onCollabChange])

  // The "Connecting…" pill fades in only when the connection takes longer than 400 ms (`nd-late`),
  // so a normal page open does not flash it for one frame (docs/adr/1222-*).
  if (!provider) {
    return (
      <div className="relative">
        <div className="nd-late pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-app/90 px-3 py-1 text-xs text-sub shadow-sm backdrop-blur">
          {t('editor.connecting')}
        </div>
      </div>
    )
  }
  return (
    <CollabEditorBody
      pageId={pageId}
      wsId={wsId}
      me={me}
      doc={doc}
      provider={provider}
      synced={synced}
      onEditorReady={onEditorReady}
      readOnly={readOnly}
    />
  )
}

function CollabEditorBody({
  pageId,
  wsId,
  me,
  doc,
  provider,
  synced,
  onEditorReady,
  readOnly,
}: {
  pageId: string
  wsId: string
  me: UserDTO
  doc: Y.Doc
  provider: HocuspocusProvider
  synced: boolean
  onEditorReady?: (editor: InklingEditor | null) => void
  readOnly: boolean
}) {
  const { resolved } = useTheme()
  const navigate = useNavigate()
  const t = useT()

  const editor = useCreateBlockNote(
    {
      schema,
      collaboration: {
        fragment: doc.getXmlFragment('document'),
        user: { name: me.name, color: userColor(me.id) },
        provider: { awareness: provider.awareness ?? undefined },
        showCursorLabels: 'activity',
      },
      // BlockNote's own UI strings follow the app locale. The app remounts on a language change,
      // so choosing the dictionary once at editor creation is enough.
      dictionary: editorDictionary(),
      uploadFile: (file: File) => uploadFile(wsId, file, pageId),
      // A bare URL pasted on an empty line becomes an embed/card block (switchable to a link).
      pasteHandler: ({ event, editor, defaultPasteHandler }) =>
        handleUrlPaste(event, editor as InklingEditor) || defaultPasteHandler(),
      // The registry's editor keys (⌘L, ⌘Enter, ⌘D, ⌘⇧D, ⌘., ⌘⇧E — docs/adr/1400-*)
      extensions: [inklingShortcuts()],
    },
    [provider],
  )
  // The command palette runs editor commands (headings, move, duplicate, …) on this body.
  useEditorPaletteCommands(editor, readOnly)

  // Cap the Yjs undo history (docs/adr/0701-*): y-prosemirror's UndoManager keeps every
  // capture forever (and keeps deleted structs from GC) — long typing sessions grow without bound.
  useEffect(() => capUndoHistory(editor), [editor])

  // For a never-edited document (empty fragment), materialize the initial paragraph in the real
  // Yjs doc. In collaboration mode BlockNote creates the initial paragraph only on the PM side
  // (id: "initialBlockId" placeholder), so the empty paragraph on screen is a ghost missing from
  // Yjs, and the side menu's + button has no real block to target until the first keystroke.
  useEffect(() => {
    // A read-only (locked) connection cannot write; the server would drop the seed anyway.
    if (!synced || readOnly) return
    try {
      const frag = doc.getXmlFragment('document')
      if (frag.length === 0 && editor.isEmpty && editor.document.length > 0) {
        editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
      }
    } catch {
      // seeding failure is not fatal — the first keystroke creates the block anyway
    }
  }, [synced, readOnly, doc, editor])

  // Block anchor (?block=<id>) — opening a task from the calendar/deadlines scrolls to that block
  // and flashes it. Retries briefly until rendering catches up after sync, then removes the param.
  const [searchParams, setSearchParams] = useSearchParams()
  const anchorBlock = searchParams.get('block')
  useEffect(() => {
    if (!synced || !anchorBlock) return
    let tries = 0
    let timer = 0
    const tick = () => {
      // a block inside a folded section is hidden: open that fold first (docs/adr/1221-*)
      revealBlock(anchorBlock)
      const find = () =>
        document.querySelector(`.bn-block-outer[data-id="${CSS.escape(anchorBlock)}"], [data-id="${CSS.escape(anchorBlock)}"]`)
      const el = find()
      if (el) {
        // instant, then held in place while content above still renders (lib/pinAnchor.ts):
        // a smooth scroll aims at a position that moves while it runs
        // (it ends by itself or on user input, not when the param is removed below)
        el.scrollIntoView({ block: 'center' })
        pinAnchor(find)
        el.classList.add('nd-block-flash')
        window.setTimeout(() => el.classList.remove('nd-block-flash'), 1600)
      }
      if (el || ++tries > 20) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev)
            next.delete('block')
            return next
          },
          { replace: true },
        )
        return
      }
      timer = window.setTimeout(tick, 100)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [synced, anchorBlock, setSearchParams])

  // Template caret (?cursor=<blockId>:<offset>, docs/adr/0922-*): a page just created from a
  // template with {{cursor}} opens with the caret where the marker was. Retried briefly until the
  // block is in the editor after sync, then the param is removed.
  const cursorParam = searchParams.get('cursor')
  useEffect(() => {
    if (!synced || !cursorParam || readOnly) return
    const sep = cursorParam.lastIndexOf(':')
    const blockId = sep > 0 ? cursorParam.slice(0, sep) : cursorParam
    const offset = sep > 0 ? Math.max(0, Number(cursorParam.slice(sep + 1)) || 0) : 0
    let tries = 0
    let timer = 0
    const done = () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('cursor')
          return next
        },
        { replace: true },
      )
    const tick = () => {
      const block = editor.getBlock(blockId)
      if (block) {
        try {
          editor.setTextCursorPosition(block, 'start')
          if (offset > 0) {
            const tiptap = (editor as unknown as {
              _tiptapEditor?: { state: { selection: { from: number } }; commands: { setTextSelection: (p: number) => boolean } }
            })._tiptapEditor
            if (tiptap) tiptap.commands.setTextSelection(tiptap.state.selection.from + offset)
          }
          editor.focus()
        } catch {
          // a block without inline content (table, image) — leave the caret where it is
        }
        done()
        return
      }
      if (++tries > 20) {
        done()
        return
      }
      timer = window.setTimeout(tick, 100)
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [synced, cursorParam, readOnly, editor, setSearchParams])

  // Share the editor instance with the parent (PageView) — for the right panel (outline/outgoing
  // links/tags). Reset to null on unmount (document switch, folder navigation) to avoid stale state.
  useEffect(() => {
    onEditorReady?.(editor)
    return () => onEditorReady?.(null)
  }, [editor, onEditorReady])

  // Intercept clicks on internal wikilinks (/w/...) as SPA navigation instead of a new tab/full load.
  const onClickCapture = (e: React.MouseEvent) => {
    const href = (e.target as HTMLElement)
      .closest('a')
      ?.getAttribute('href')
    if (href && href.startsWith('/w/')) {
      e.preventDefault()
      navigate(href)
    }
  }

  return (
    <div className="relative" onClickCapture={onClickCapture}>
      {!synced && (
        <div className="nd-late pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-app/90 px-3 py-1 text-xs text-sub shadow-sm backdrop-blur">
          {t('editor.connecting')}
        </div>
      )}
      {/* slashMenu={false}: turn off the default slash menu and replace it with SlashMenu (default
          items + callout). Avoids a duplicate "/" controller — the rest of the default UI
          (toolbar, side menu, …) stays as is. */}
      <BlockNoteView
        editor={editor}
        theme={resolved}
        slashMenu={false}
        editable={!readOnly}
      >
        <SlashMenu editor={editor} />
        <WikilinkMenu editor={editor} wsId={wsId} />
        <MentionMenu editor={editor} wsId={wsId} />
        <QueryBlockPortals editor={editor} wsId={wsId} />
      </BlockNoteView>
    </div>
  )
}

/**
 * The page editor over a local Y.Doc with no server connection: row templates
 * (docs/adr/1182-*). Same schema, menus, uploads and paste handling as a page, so whatever the
 * editor can write survives (callouts, mentions, embeds). The caller loads the document and saves
 * its updates; there is no presence or live sync.
 */
export function LocalDocEditor({
  doc,
  wsId,
  uploadPageId,
  me,
  readOnly = false,
  placeholder,
}: {
  doc: Y.Doc
  wsId: string
  /** Uploads are attached to this page (the collection), so they follow its visibility. */
  uploadPageId: string
  me: UserDTO
  readOnly?: boolean
  placeholder?: string
}) {
  const { resolved } = useTheme()
  const navigate = useNavigate()
  const editor = useCreateBlockNote(
    {
      schema,
      collaboration: {
        fragment: doc.getXmlFragment('document'),
        user: { name: me.name, color: userColor(me.id) },
        provider: { awareness: undefined },
        showCursorLabels: 'activity',
      },
      dictionary: editorDictionary(),
      ...(placeholder ? { placeholders: { emptyDocument: placeholder } } : {}),
      uploadFile: (file: File) => uploadFile(wsId, file, uploadPageId),
      pasteHandler: ({ event, editor, defaultPasteHandler }) =>
        handleUrlPaste(event, editor as InklingEditor) || defaultPasteHandler(),
      extensions: [inklingShortcuts()],
    },
    [doc],
  )
  useEffect(() => capUndoHistory(editor), [editor])
  // Same seeding as CollabEditorBody: an empty fragment gets a real first paragraph.
  useEffect(() => {
    if (readOnly) return
    try {
      const frag = doc.getXmlFragment('document')
      if (frag.length === 0 && editor.isEmpty && editor.document.length > 0) {
        editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
      }
    } catch {
      // not fatal: the first keystroke creates the block
    }
  }, [readOnly, doc, editor])
  const onClickCapture = (e: React.MouseEvent) => {
    const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
    if (href && href.startsWith('/w/')) {
      e.preventDefault()
      navigate(href)
    }
  }
  return (
    <div className="relative" onClickCapture={onClickCapture}>
      <BlockNoteView editor={editor} theme={resolved} slashMenu={false} editable={!readOnly}>
        <SlashMenu editor={editor} />
        <WikilinkMenu editor={editor} wsId={wsId} />
        <MentionMenu editor={editor} wsId={wsId} />
        <QueryBlockPortals editor={editor} wsId={wsId} />
      </BlockNoteView>
    </div>
  )
}
