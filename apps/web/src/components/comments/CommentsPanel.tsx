import { useMemo, useState } from 'react'
import type { CommentDTO, MemberDTO } from '@inkling/shared'
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useMe,
  useUpdateComment,
} from '../../api'
import { relativeTime } from '../../lib/time'
import type { InklingEditor } from '../CollabEditor'
import { CheckIcon, MessageIcon, ReplyIcon, TrashIcon } from '../Icons'
import { CommentComposer } from './CommentComposer'
import { useT } from '../../i18n'

// ---------------------------------------------------------------------------
// Block text lookup (anchor preview / scroll) — based on editor.document
// ---------------------------------------------------------------------------

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const node of content as any[]) {
    if (typeof node === 'string') out += node
    else if (node?.type === 'text') out += node.text ?? ''
    else if (node?.type === 'link') out += inlineText(node.content)
    else if (node?.type === 'mention') out += `@${node.props?.label ?? ''}`
  }
  return out
}

function findBlockText(blocks: any[], id: string): string | null {
  for (const b of blocks ?? []) {
    if (b?.id === id) return inlineText(b.content)
    if (Array.isArray(b?.children)) {
      const found = findBlockText(b.children, id)
      if (found !== null) return found
    }
  }
  return null
}

function scrollToBlock(id: string) {
  const el = document.querySelector(`[data-id="${id}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('nd-block-flash')
    window.setTimeout(() => el.classList.remove('nd-block-flash'), 1200)
  }
}

// ---------------------------------------------------------------------------
// Thread building
// ---------------------------------------------------------------------------

interface Thread {
  root: CommentDTO
  replies: CommentDTO[]
  blockId: string
  resolved: boolean
}

function buildThreads(comments: CommentDTO[]): Thread[] {
  const groups = new Map<string, CommentDTO[]>()
  for (const c of comments) {
    const arr = groups.get(c.threadId) ?? []
    arr.push(c)
    groups.set(c.threadId, arr)
  }
  const threads: Thread[] = []
  for (const [threadId, arr] of groups) {
    arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const root = arr.find((c) => c.id === threadId) ?? arr[0]
    const replies = arr.filter((c) => c.id !== root.id)
    threads.push({ root, replies, blockId: root.blockId, resolved: root.resolved })
  }
  // Latest activity (root creation time) first — new threads on top.
  threads.sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt))
  return threads
}

// ---------------------------------------------------------------------------
// Single comment row
// ---------------------------------------------------------------------------

function CommentRow({
  comment,
  canManage,
  canEdit,
  pageId,
  members,
}: {
  comment: CommentDTO
  canManage: boolean
  canEdit: boolean
  pageId: string
  members: MemberDTO[]
}) {
  const tr = useT()
  const update = useUpdateComment(pageId)
  const del = useDeleteComment(pageId)
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <CommentComposer
        members={members}
        placeholder={tr('comments.editPlaceholder')}
        submitLabel={tr('common.save')}
        autoFocus
        initialValue={comment.body}
        busy={update.isPending}
        onSubmit={(body) => {
          update.mutate({ id: comment.id, body }, { onSuccess: () => setEditing(false) })
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="group/comment flex flex-col gap-0.5">
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-xs font-medium text-ink">
          {comment.author.name}
        </span>
        {comment.viaClient && (
          // Posted by an agent through MCP (docs/adr/0936-*); plain text, React escapes it.
          <span className="shrink-0 truncate text-[11px] text-sub" title={comment.viaClient}>
            {tr('comments.via', { client: comment.viaClient })}
          </span>
        )}
        <span className="shrink-0 text-[11px] text-sub">
          {relativeTime(comment.createdAt)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/comment:opacity-100">
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1 py-0.5 text-[11px] text-sub hover:bg-hover hover:text-ink"
            >
              {tr('common.edit')}
            </button>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => del.mutate(comment.id)}
              aria-label={tr('comments.delete')}
              className="rounded p-0.5 text-sub hover:bg-hover hover:text-red-500"
            >
              <TrashIcon size={12} />
            </button>
          )}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs text-ink/90">{comment.body}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Thread card
// ---------------------------------------------------------------------------

function ThreadCard({
  thread,
  pageId,
  members,
  myId,
  isOwner,
  editor,
  canComment = true,
}: {
  thread: Thread
  pageId: string
  members: MemberDTO[]
  myId: string | undefined
  isOwner: boolean
  editor: InklingEditor | null
  canComment?: boolean
}) {
  const tr = useT()
  const update = useUpdateComment(pageId)
  const create = useCreateComment(pageId)
  const [replying, setReplying] = useState(false)

  const preview = useMemo(() => {
    const t = editor ? findBlockText((editor.document as any[]) ?? [], thread.blockId) : null
    const trimmed = (t ?? '').trim()
    if (!trimmed) return tr('comments.block')
    return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
  }, [editor, thread.blockId, tr])

  const canManage = (c: CommentDTO) => c.author.id === myId || isOwner
  const canEdit = (c: CommentDTO) => !!myId && c.author.id === myId

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-line p-2 transition-opacity ${
        thread.resolved ? 'opacity-70' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => scrollToBlock(thread.blockId)}
        title={tr('comments.goToBlock')}
        className="flex items-center gap-1 truncate text-left text-[11px] text-sub hover:text-accent"
      >
        <MessageIcon size={11} className="shrink-0" />
        <span className="min-w-0 truncate italic">{preview}</span>
      </button>

      <CommentRow
        comment={thread.root}
        canManage={canManage(thread.root)}
        canEdit={canEdit(thread.root)}
        pageId={pageId}
        members={members}
      />

      {thread.replies.length > 0 && (
        <div className="flex flex-col gap-2 border-l border-line pl-2">
          {thread.replies.map((r) => (
            <CommentRow
              key={r.id}
              comment={r}
              canManage={canManage(r)}
              canEdit={canEdit(r)}
              pageId={pageId}
              members={members}
            />
          ))}
        </div>
      )}

      {replying ? (
        <CommentComposer
          members={members}
          placeholder={tr('comments.replyPlaceholder')}
          submitLabel={tr('comments.reply')}
          autoFocus
          busy={create.isPending}
          onSubmit={(body, mentionUserIds) => {
            create.mutate(
              {
                blockId: thread.blockId,
                body,
                threadId: thread.root.threadId,
                mentionUserIds: mentionUserIds.length ? mentionUserIds : undefined,
              },
              { onSuccess: () => setReplying(false) },
            )
          }}
          onCancel={() => setReplying(false)}
        />
      ) : !canComment ? null : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-sub hover:bg-hover hover:text-ink"
          >
            <ReplyIcon size={12} /> {tr('comments.reply')}
          </button>
          <button
            type="button"
            onClick={() =>
              update.mutate({ id: thread.root.id, resolved: !thread.resolved })
            }
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-hover ${
              thread.resolved ? 'text-green-600' : 'text-sub hover:text-ink'
            }`}
          >
            <CheckIcon size={12} /> {thread.resolved ? tr('comments.resolved') : tr('comments.resolve')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function CommentsPanel({
  wsId: _wsId,
  pageId,
  editor,
  members,
  canComment = true,
}: {
  wsId: string
  pageId: string
  editor: InklingEditor | null
  members: MemberDTO[]
  /** False when the caller's level on the page is `view` (docs/adr/1251-*): read the threads only. */
  canComment?: boolean
}) {
  const tr = useT()
  const me = useMe()
  const comments = useComments(pageId)
  const create = useCreateComment(pageId)
  const [composeBlockId, setComposeBlockId] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)

  const threads = useMemo(() => buildThreads(comments.data ?? []), [comments.data])
  const active = threads.filter((t) => !t.resolved)
  const resolved = threads.filter((t) => t.resolved)

  const myId = me.data?.id
  // owners and admins moderate comments (docs/adr/0945-*)
  const isOwner = (members.find((m) => m.id === myId)?.role ?? 'member') !== 'member'

  const startCompose = () => {
    if (!editor) return
    try {
      const bid = editor.getTextCursorPosition().block.id
      setComposeBlockId(bid)
      scrollToBlock(bid)
    } catch {
      // ignore when the cursor position is unavailable
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {canComment && (
      <button
        type="button"
        onClick={startCompose}
        disabled={!editor}
        className="flex items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-xs text-sub transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-60"
      >
        <MessageIcon size={13} /> {tr('comments.commentOnBlock')}
      </button>
      )}

      {composeBlockId && (
        <div className="flex flex-col gap-1 rounded-md border border-accent/40 bg-accent-soft/40 p-2">
          <span className="text-[11px] text-sub">{tr('comments.newThread')}</span>
          <CommentComposer
            members={members}
            placeholder={tr('comments.placeholder')}
            submitLabel={tr('comments.submit')}
            autoFocus
            busy={create.isPending}
            onSubmit={(body, mentionUserIds) => {
              create.mutate(
                {
                  blockId: composeBlockId,
                  body,
                  mentionUserIds: mentionUserIds.length ? mentionUserIds : undefined,
                },
                { onSuccess: () => setComposeBlockId(null) },
              )
            }}
            onCancel={() => setComposeBlockId(null)}
          />
        </div>
      )}

      {comments.isLoading ? (
        <p className="text-xs text-sub">{tr('common.loading')}</p>
      ) : active.length === 0 && resolved.length === 0 ? (
        <p className="text-xs text-sub">{tr('comments.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {active.map((t) => (
            <ThreadCard
              key={t.root.id}
              thread={t}
              pageId={pageId}
              members={members}
              myId={myId}
              isOwner={isOwner}
              editor={editor}
              canComment={canComment}
            />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="self-start text-[11px] text-sub hover:text-ink"
          >
            {tr(showResolved ? 'comments.hideResolved' : 'comments.showResolved', { count: resolved.length })}
          </button>
          {showResolved &&
            resolved.map((t) => (
              <ThreadCard
                key={t.root.id}
                thread={t}
                pageId={pageId}
                members={members}
                myId={myId}
                isOwner={isOwner}
                editor={editor}
                canComment={canComment}
              />
            ))}
        </div>
      )}
    </div>
  )
}
