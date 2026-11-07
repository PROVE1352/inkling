import type { InboxKind, NotificationLevel } from '@inkling/shared'

/**
 * Notification kinds produced by the notification engine (docs/adr/1000-*), with their delivery
 * rules in one table so the engine, the inbox and the docs read the same thing.
 *
 *  - direct:   addressed to one person (mention, reply in their thread, assignment). Reaches the
 *              person at levels all/mentions, quietly at "nothing", never at "mute" — unless the kind
 *              passes mute (`bypassMute`, reserved for approval requests addressed to you).
 *  - implicit: the page's creator/owner hears about new comments without subscribing; same level
 *              handling as direct, but never mailed right away.
 *  - activity: only subscribers at level "all" (comments and edits on a followed subtree).
 *  - summary:  produced from a subscription itself (the AI edit daily summary); always delivered.
 */
export type NotifyKind =
  | 'doc_mention'
  | 'comment_mention'
  | 'comment_reply'
  | 'comment'
  | 'page_owner'
  | 'task_assigned'
  | 'page_update'
  | 'agent_digest'
  | 'approval_request'
  | 'approval_result'

export interface KindSpec {
  /** Higher wins when one person qualifies for several kinds from one event. */
  priority: number
  /** Mailed right away (when the user keeps instant mail on); otherwise it waits for the digest. */
  instantMail: boolean
  /** Delivered even at level "mute". */
  bypassMute: boolean
  /** How the agent inbox labels it; null = not an inbox item. */
  inbox: InboxKind | null
  /** An agent-written instance is listed quietly and only reaches the digest. */
  quietWhenAgent: boolean
}

export const KINDS: Record<NotifyKind, KindSpec> = {
  approval_request: { priority: 90, instantMail: true, bypassMute: true, inbox: null, quietWhenAgent: false },
  approval_result: { priority: 85, instantMail: true, bypassMute: false, inbox: 'approval_result', quietWhenAgent: false },
  comment_mention: { priority: 80, instantMail: true, bypassMute: false, inbox: 'mention', quietWhenAgent: true },
  doc_mention: { priority: 75, instantMail: true, bypassMute: false, inbox: 'mention', quietWhenAgent: true },
  task_assigned: { priority: 70, instantMail: true, bypassMute: false, inbox: 'assigned', quietWhenAgent: false },
  page_owner: { priority: 65, instantMail: true, bypassMute: false, inbox: 'assigned', quietWhenAgent: false },
  comment_reply: { priority: 60, instantMail: true, bypassMute: false, inbox: 'reply', quietWhenAgent: false },
  comment: { priority: 40, instantMail: false, bypassMute: false, inbox: 'comment', quietWhenAgent: false },
  page_update: { priority: 20, instantMail: false, bypassMute: false, inbox: null, quietWhenAgent: true },
  agent_digest: { priority: 10, instantMail: false, bypassMute: false, inbox: null, quietWhenAgent: false },
}

/** Inbox kind → notification types (for the MCP inbox filter). */
export function typesForInbox(kinds: readonly InboxKind[]): NotifyKind[] {
  return (Object.keys(KINDS) as NotifyKind[]).filter((k) => {
    const i = KINDS[k].inbox
    return i !== null && kinds.includes(i)
  })
}

export type Reason = 'direct' | 'implicit' | 'activity'

export interface Decision {
  deliver: boolean
  delivery: 'now' | 'quiet'
}

/**
 * The level rule. `level` is the nearest subscription of the recipient for the page (default
 * 'mentions'); `agent` = the action came through an agent connection.
 */
export function decide(kind: NotifyKind, reason: Reason, level: NotificationLevel, agent: boolean): Decision {
  const spec = KINDS[kind]
  if (spec.bypassMute) return { deliver: true, delivery: 'now' }
  if (level === 'mute') return { deliver: false, delivery: 'quiet' }
  if (reason === 'activity' && level !== 'all') return { deliver: false, delivery: 'quiet' }
  if (level === 'nothing') return { deliver: true, delivery: 'quiet' }
  if (agent && spec.quietWhenAgent) return { deliver: true, delivery: 'quiet' }
  return { deliver: true, delivery: 'now' }
}
