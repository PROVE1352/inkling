import { useCallback, useEffect, useState } from 'react'
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
import { createGate, fetchSyncCheck } from '../lib/offline/gate'
import type { PageCopy } from '../lib/offline/pageCopy'
import { deviceStateWith, forgetCopy, keepRecovery, openPageCopy, useOfflineStatus } from '../lib/offline/runtime'
import { toast } from '../lib/toast'
import type { TKey } from '../i18n'
import { capUndoHistory } from '../lib/undoCap'
import { pinAnchor } from '../lib/pinAnchor'
import { revealBlock } from '../lib/headingFolds'
import { inklingShortcuts, useEditorPaletteCommands } from '../lib/shortcuts/editorKeys'
import { tableQuickInput } from '../lib/tableQuickInput'
import { selectPickerGuard } from '../lib/selectPickerGuard'
import { editableLinkAuxClick, editorLinkClick, internalLinkClick } from '../lib/internalLinks'
import { useTheme } from '../lib/theme'
import { editorSchemaSpecs, pageEmbedSpec } from './blocks/PageEmbed'
import { QueryBlockPortals } from './blocks/QueryBlock'
import { MermaidPortals, mermaidCodeBlockSpec } from './blocks/MermaidBlock'
import { useSectionLinkJump } from '../lib/sectionLinks'
import { handleUrlPaste } from './blocks/LinkEmbed'
import { ColumnsSideMenu, columnsExtension, pasteFlatInColumn } from './blocks/Columns'
import type { CollabUser } from './OnlineUsers'
import { WikilinkMenu } from './WikilinkMenu'
import { MentionMenu } from './MentionMenu'
import { SlashMenu } from './SlashMenu'
import { createZoomableImageSpec } from './imageViewer/zoomableImage'
import { imageTarget, openFromImage } from './imageViewer/openImageViewer'
import { getLocale, t, useT } from '../i18n'

/** BlockNote's dictionary for the app locale, with our own empty-block hint (BlockNote's Korean one
 *  repeats "입력" three times). Block-type hints (heading, list) stay BlockNote's. */
function editorDictionary() {
  const base = getLocale() === 'ko' ? bnKo : bnEn
  return { ...base, placeholders: { ...base.placeholders, default: t('editor.placeholder') } }
}

// Loose type so parents (PageView etc.) can share the editor instance
export type InklingEditor = BlockNoteEditor<any, any, any>

/** The awareness `user` field: BlockNote's name + colour, plus the account id (docs/adr/1846-*). */
function awarenessUser(me: UserDTO): { name: string; color: string } {
  const user = { name: me.name, color: userColor(me.id), id: me.id }
  return user
}

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
  /**
   * The server took this connection as read-only because the page holds a node type this build does not
   * know (docs/adr/2425-*): the schema it needs. The editor shows its own banner, not the lock banner.
   */
  schemaNeeds?: number
}

// One spec list for this schema and the page-embed viewer's (editorSchemaSpecs, docs/adr/1539-*):
// the custom nodes share their configs with the server schema (@inkling/shared, docs/adr/1500-*),
// so server reads keep them. Here pageEmbed renders the target body and code blocks in language
// `dataview` render live query results (docs/QUERY.md), in language `mermaid` a diagram (docs/adr/2104-*),
// and images carry a "View larger" button (docs/adr/2386-*).
const schema = BlockNoteSchema.create(
  editorSchemaSpecs({ pageEmbed: pageEmbedSpec, codeBlock: mermaidCodeBlockSpec, image: createZoomableImageSpec() }),
)
// LocalDocEditor (row templates, the offline recovery preview): the same nodes with BlockNote's plain
// image, so the viewer's button appears only in page bodies (docs/adr/2386-*).
const localSchema = BlockNoteSchema.create(editorSchemaSpecs({ pageEmbed: pageEmbedSpec, codeBlock: mermaidCodeBlockSpec }))

/** Why the device copy was not merged (docs/adr/2201-*): shown above the editor that reopened from the server. */
type BlockedNotice = 'restored' | 'replaced' | 'readonly' | 'trashed' | 'outdated' | 'gone'
const BLOCKED_TEXT: Record<BlockedNotice, TKey> = {
  outdated: 'offline.blocked.outdated',
  restored: 'offline.blocked.restored',
  replaced: 'offline.blocked.replaced',
  readonly: 'offline.blocked.readonly',
  trashed: 'offline.blocked.trashed',
  gone: 'offline.blocked.gone',
}

type CollabEditorProps = {
  pageId: string
  wsId: string
  me: UserDTO
  /** page title, kept with the device copy and its recovery items */
  title?: string
  onCollabChange?: (state: CollabState) => void
  onEditorReady?: (editor: InklingEditor | null) => void
  /** Ink mode or an edit lock — the body is not editable */
  readOnly?: boolean
}

/**
 * The page editor. When the sync gate (lib/offline/gate.ts) does not let the device copy merge, the
 * session is thrown away and a new one opens from the server (`epoch`), with a notice saying why.
 */
export function CollabEditor(props: CollabEditorProps) {
  const t = useT()
  const [epoch, setEpoch] = useState(0)
  const [notice, setNotice] = useState<BlockedNotice | null>(null)
  const onReopen = useCallback((why: BlockedNotice | null, delayMs = 0) => {
    if (why) setNotice(why)
    window.setTimeout(() => setEpoch((e) => e + 1), delayMs)
  }, [])
  return (
    <>
      {notice && (
        <div role="status" data-testid="offline-blocked" className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-ink">
          <span className="min-w-0 flex-1">{t(BLOCKED_TEXT[notice])}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-xs text-sub hover:text-ink">
            {t('common.close')}
          </button>
        </div>
      )}
      <CollabEditorSession key={epoch} {...props} onReopen={onReopen} />
    </>
  )
}

function CollabEditorSession({
  pageId,
  wsId,
  me,
  title,
  onCollabChange,
  onEditorReady,
  readOnly = false,
  onReopen,
}: CollabEditorProps & { onReopen: (why: BlockedNotice | null, delayMs?: number) => void }) {
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
  // The page needs a newer document schema than this build knows (docs/adr/2425-*): read-only + banner.
  const [schemaNeeds, setSchemaNeeds] = useState<number | null>(null)
  // The device copy (docs/adr/2200-*): undefined while it loads, null when there is none to keep
  // (setting off, storage unusable). Loaded into `doc` before the provider exists.
  const [copy, setCopy] = useState<PageCopy | null | undefined>(undefined)
  const [hadCopy, setHadCopy] = useState(false)
  useEffect(() => {
    let alive = true
    let c: PageCopy | null = null
    void (async () => {
      try {
        c = await openPageCopy({ pageId, wsId, doc, session: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, title })
        if (c && (await c.load())) setHadCopy(true)
      } catch {
        c = null
      }
      if (!alive) {
        c?.dispose()
        return
      }
      setCopy(c)
    })()
    return () => {
      alive = false
      // a copy handed to a provider lives until that provider is destroyed (onDestroy below)
      if (c && !c.started()) c.dispose()
    }
    // the title only labels the copy; a rename must not reopen it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageId, wsId])
  useEffect(() => {
    if (copy && title) copy.setTitle(title)
  }, [copy, title])

  useEffect(() => {
    if (copy === undefined) return
    let blocked = false
    // The sync gate runs before every Auth (docs/adr/2201-*). Without a device copy (setting off,
    // storage unusable) there is nowhere to keep a recovery item, so the page syncs as in 0.17.
    const token = copy && createGate({
      doc,
      copy,
      check: () => fetchSyncCheck(pageId, fetch, copy.schema()),
      onBlocked: async (d) => {
        if (d.kind === 'retry') {
          onReopen(null, 10_000)
          return
        }
        blocked = true
        try {
          if (d.kind === 'recover') {
            await copy?.flush()
            await keepRecovery({ pageId, wsId, title: title ?? '', reason: d.reason, state: await deviceStateWith(pageId, doc) })
          }
          copy?.dispose()
          await forgetCopy(pageId)
        } finally {
          // a reset lost nothing (no unsent edits): reopen without a notice
          onReopen(d.kind === 'forget' ? 'gone' : d.kind === 'recover' ? d.reason : null)
        }
      },
    })
    let uploadedAfterOutage = !!copy?.pending()
    let destroyed = false
    // eslint-disable-next-line prefer-const
    let handle: ReturnType<typeof openCollab> | undefined
    handle = openCollab({
      name: pageId,
      document: doc,
      userKey: me.id,
      token: token || undefined,
      copy: copy ?? undefined,
      // The provider outlives this editor while it holds unacknowledged edits (ADR 1926): the copy
      // keeps clearing its marks until then.
      onDestroy: () => {
        destroyed = true
        const prov = handle?.provider
        prov?.off('unsyncedChanges', onUnsynced)
        // destroyed because its last edits were just acknowledged: clear their marks, then let go
        void (async () => {
          if (copy && !blocked && prov && prov.unsyncedChanges === 0 && copy.pending()) await copy.acked()
          copy?.dispose()
        })()
      },
      // Stateless notices the server sends on this page's channel. On a comment change, refetch
      // immediately instead of waiting for the poll; the document generation goes to the device
      // copy (docs/adr/2201-*). Unknown and malformed payloads are ignored.
      onStateless: ({ payload }) => {
        try {
          const msg = JSON.parse(payload)
          if (msg?.t === 'comments') {
            queryClient.invalidateQueries({ queryKey: qk.comments(pageId) })
          } else if (msg?.t === 'gen' && typeof msg.gen === 'number' && !blocked) {
            copy?.setGen(msg.gen)
          } else if (msg?.t === 'schema' && typeof msg.needs === 'number') {
            // sent only to a connection the server took as read-only for this reason
            setSchemaNeeds(msg.needs)
          }
        } catch {
          // ignore malformed payloads
        }
      },
    })
    const p = handle.provider
    copy?.start((origin) => origin === p)
    // Everything sent so far is acknowledged: clear the copy's unsent marks (compare-and-delete).
    function onUnsynced(n: number) {
      if (n !== 0 || !copy || blocked || destroyed || !copy.pending()) return
      const after = uploadedAfterOutage
      uploadedAfterOutage = false
      void copy.acked().then(() => {
        if (after) toast({ message: t('offline.uploaded') })
      })
    }
    p.on('unsyncedChanges', onUnsynced)
    const onDown = () => {
      if (copy?.pending()) uploadedAfterOutage = true
    }
    p.on('disconnect', onDown)
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
      p.off('disconnect', onDown)
      p.off('status', onStatus)
      p.off('authenticationFailed', onDenied)
      p.off('authenticated', onAuthenticated)
      p.off('synced', onSynced)
      p.awareness?.off('change', onAwareness)
      handle.release()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageId, me.id, copy])

  useEffect(() => () => doc.destroy(), [doc])

  // Report collab state to the parent (PageView) — for the top-bar connection dot / online users
  useEffect(() => {
    onCollabChange?.({ status, synced, users, scope, ...(schemaNeeds !== null ? { schemaNeeds } : {}) })
  }, [status, synced, users, scope, schemaNeeds, onCollabChange])

  // No server and nothing on this device for this page: say so instead of an empty editor whose
  // typing would only start a second, unrelated history (docs/adr/2202-*).
  const offline = useOfflineStatus()
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (synced) return
    const timer = window.setTimeout(() => setLate(true), 4000)
    return () => window.clearTimeout(timer)
  }, [synced])
  const unreachable = !synced && (offline.offline || (late && status !== 'connected'))
  if (copy !== undefined && !hadCopy && unreachable) {
    return (
      <div data-testid="offline-not-cached" className="rounded-md border border-line px-4 py-6 text-center text-sm text-sub">
        {t(offline.enabled ? 'offline.notCached' : 'offline.notCachedOff')}
      </div>
    )
  }

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
    <>
      {schemaNeeds !== null && (
        <div role="status" data-testid="schema-readonly" className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-ink">
          <span className="min-w-0 flex-1">{t('docSchema.readOnly')}</span>
          <button type="button" onClick={() => window.location.reload()} className="shrink-0 text-xs font-medium text-ink underline-offset-2 hover:underline">
            {t('docSchema.reload')}
          </button>
        </div>
      )}
    <CollabEditorBody
      pageId={pageId}
      wsId={wsId}
      me={me}
      doc={doc}
      provider={provider}
      synced={synced}
      deviceCopy={hadCopy}
      onEditorReady={onEditorReady}
      readOnly={readOnly || schemaNeeds !== null}
    />
    </>
  )
}

function CollabEditorBody({
  pageId,
  wsId,
  me,
  doc,
  provider,
  synced,
  deviceCopy,
  onEditorReady,
  readOnly,
}: {
  pageId: string
  wsId: string
  me: UserDTO
  doc: Y.Doc
  provider: HocuspocusProvider
  synced: boolean
  /** the body came from this device's offline copy (shown until the server answers) */
  deviceCopy: boolean
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
        // `id` rides along in the awareness state so presence can show the member's status (docs/adr/1846-*)
        user: awarenessUser(me),
        provider: { awareness: provider.awareness ?? undefined },
        showCursorLabels: 'activity',
      },
      // BlockNote's own UI strings follow the app locale. The app remounts on a language change,
      // so choosing the dictionary once at editor creation is enough.
      dictionary: editorDictionary(),
      uploadFile: (file: File) => uploadFile(wsId, file, pageId),
      // A bare URL pasted on an empty line becomes an embed/card block (switchable to a link).
      pasteHandler: ({ event, editor, defaultPasteHandler }) =>
        handleUrlPaste(event, editor as InklingEditor) || pasteFlatInColumn(event, editor) || defaultPasteHandler(),
      // Link clicks: BlockNote's default opens every link with window.open — internal links move in
      // the app instead (lib/internalLinks.ts, onClickCapture below).
      links: { onClick: editorLinkClick },
      // The registry's editor keys (⌘L, ⌘Enter, ⌘D, ⌘⇧D, ⌘., ⌘⇧E — docs/adr/1400-*), the typed
      // pipe row that becomes a table on Enter (docs/adr/1642-*) and select pickers in blocks
      // that ProseMirror must not take as clicks on the block (lib/selectPickerGuard.ts)
      extensions: [inklingShortcuts(), tableQuickInput(), selectPickerGuard(), columnsExtension()],
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

  // Section link `#h=…` (docs/adr/2102-*): find the heading, then jump through ?block= above.
  useSectionLinkJump(pageId, synced, () => editor.document)

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

  // A plain click on an internal link (/w/...) moves in the app; ⌘/Ctrl/Shift-click and the middle
  // button open a new tab (lib/internalLinks.ts).
  const onClickCapture = (e: React.MouseEvent) => {
    internalLinkClick(e, navigate)
  }
  // Image viewer (docs/adr/2386-*): a click on an editable image selects the block, so a double-click
  // opens it there; a read-only body (lock, read-only link) opens it with one click. The corner
  // button (zoomableImage.ts) opens it in both.
  const onImageOpen = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.type === 'click') !== readOnly) return
    const img = imageTarget(e.target)
    if (!img || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    openFromImage(e.currentTarget, img)
  }

  return (
    <div
      className="relative"
      onClickCapture={onClickCapture}
      onAuxClick={editableLinkAuxClick}
      onClick={onImageOpen}
      onDoubleClick={onImageOpen}
    >
      {!synced && (
        <div
          data-testid={deviceCopy ? 'offline-device-copy' : undefined}
          className="nd-late pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-app/90 px-3 py-1 text-xs text-sub shadow-sm backdrop-blur"
        >
          {t(deviceCopy ? 'offline.deviceCopy' : 'editor.connecting')}
        </div>
      )}
      {/* slashMenu={false}: turn off the default slash menu and replace it with SlashMenu (default
          items + callout). Avoids a duplicate "/" controller — the rest of the default UI
          (toolbar, side menu, …) stays as is. */}
      <BlockNoteView
        editor={editor}
        theme={resolved}
        slashMenu={false}
        sideMenu={false}
        editable={!readOnly}
      >
        <SlashMenu editor={editor} />
        {/* BlockNote's side menu with the column items in its block menu (blocks/Columns.tsx) */}
        <ColumnsSideMenu />
        <WikilinkMenu editor={editor} wsId={wsId} />
        <MentionMenu editor={editor} wsId={wsId} />
        <QueryBlockPortals editor={editor} wsId={wsId} />
        <MermaidPortals editor={editor} />
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
      schema: localSchema,
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
        handleUrlPaste(event, editor as InklingEditor) || pasteFlatInColumn(event, editor) || defaultPasteHandler(),
      links: { onClick: editorLinkClick },
      extensions: [inklingShortcuts(), tableQuickInput(), selectPickerGuard(), columnsExtension()],
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
    internalLinkClick(e, navigate)
  }
  return (
    <div className="relative" onClickCapture={onClickCapture} onAuxClick={editableLinkAuxClick}>
      <BlockNoteView editor={editor} theme={resolved} slashMenu={false} sideMenu={false} editable={!readOnly}>
        <SlashMenu editor={editor} />
        <ColumnsSideMenu />
        <WikilinkMenu editor={editor} wsId={wsId} />
        <MentionMenu editor={editor} wsId={wsId} />
        <QueryBlockPortals editor={editor} wsId={wsId} />
        <MermaidPortals editor={editor} />
      </BlockNoteView>
    </div>
  )
}
