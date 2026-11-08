import { z } from 'zod'
import type { WorkspaceRole } from './index'

// ---------------------------------------------------------------------------
// People with access to a page tree, guests (docs/adr/1250-*, 1251-*, 1252-*, 1253-*)
// ---------------------------------------------------------------------------

/**
 * Level of one person on a page and its subtree. view < comment < edit < full; `full` also lets
 * them manage who has access (members only, never guests).
 */
export const PAGE_ACCESS_LEVELS = ['view', 'comment', 'edit', 'full'] as const
export type PageAccessLevel = (typeof PAGE_ACCESS_LEVELS)[number]
/** Levels a guest can be given. */
export const GUEST_ACCESS_LEVELS = ['view', 'comment', 'edit'] as const
export type GuestAccessLevel = (typeof GUEST_ACCESS_LEVELS)[number]

/** Members' level on a shared page without a row of their own (owners and admins: always `full`). */
export const MEMBER_DEFAULT_LEVEL: PageAccessLevel = 'edit'

/** Role in a workspace as the caller sees it: a member role, or `guest` (access to some pages only). */
export type WorkspaceAccessRole = WorkspaceRole | 'guest'

/** Who may invite people from outside the workspace: nobody, owners, owners and admins, or any member who can edit the page. */
export const GUEST_INVITE_POLICIES = ['off', 'owners', 'admins', 'members'] as const
export type GuestInvitePolicy = (typeof GUEST_INVITE_POLICIES)[number]

/** Maximum people with their own row on one page (invitations included). */
export const MAX_PAGE_PEOPLE = 100

export function levelRank(level: PageAccessLevel | null | undefined): number {
  return level ? PAGE_ACCESS_LEVELS.indexOf(level) + 1 : 0
}

/** PUT /pages/:id/access — give one person a level on this page (adds or changes their row). */
export const setPageAccessSchema = z
  .object({
    /** An account on this instance (from the candidates search or the list). */
    userId: z.uuid().optional(),
    /** Or an email address: an existing account is matched exactly; otherwise an invitation link is made. */
    email: z.email().max(320).optional(),
    level: z.enum(PAGE_ACCESS_LEVELS),
  })
  .strict()
  .refine((v) => (v.userId ? 1 : 0) + (v.email ? 1 : 0) === 1, { message: 'Give either userId or email' })
export type SetPageAccessInput = z.infer<typeof setPageAccessSchema>

/** One person in the page's access list. */
export interface PagePersonDTO {
  userId: string
  name: string
  email: string
  level: PageAccessLevel
  /** Not a member of the workspace: this page tree is all they can see. */
  guest: boolean
  /** The row is on an ancestor (change it there); null = on this page. */
  inheritedFrom: { pageId: string; title: string } | null
}

/** An invitation for an address without an account yet. */
export interface PageInviteDTO {
  id: string
  email: string
  level: GuestAccessLevel
  createdAt: string
  expiresAt: string
  /** Link to send by hand (only in the answer that created it, and only when no mail was sent). */
  link?: string
}

/** GET /pages/:id/access */
export interface PageAccessDTO {
  pageId: string
  people: PagePersonDTO[]
  invites: PageInviteDTO[]
  /** The caller's own level here. */
  myLevel: PageAccessLevel
  /** May change people's levels and remove them here. */
  canManage: boolean
  /** May add people from outside the workspace here (workspace policy). */
  canInviteGuests: boolean
  guestPolicy: GuestInvitePolicy
  /** Private pages are their author's only: no people list. */
  private: boolean
}

/** PUT /pages/:id/access answer. */
export interface SetPageAccessResult {
  access: PageAccessDTO
  /** An invitation was made for an address without an account. */
  invite?: PageInviteDTO
  /** The invitation mail went out (false: copy `invite.link` and send it yourself). */
  mailed?: boolean
}

/** GET /pages/:id/access/candidates?q= — people to add. */
export interface AccessCandidateDTO {
  userId: string
  name: string
  email: string
  /** Not a member of the workspace (adding them makes a guest). */
  guest: boolean
}

/** GET /workspaces/:id/guests (owners and admins). */
export interface WorkspaceGuestDTO {
  userId: string
  name: string
  email: string
  pages: { pageId: string; title: string; level: GuestAccessLevel }[]
}

/** POST /workspaces/:id/guests/remove */
export const removeGuestsSchema = z.object({ userIds: z.array(z.uuid()).min(1).max(200) }).strict()

/** GET /page-invites/:token (signed in) */
export interface PageInvitePreviewDTO {
  workspaceName: string
  pageTitle: string
  level: GuestAccessLevel
  invitedBy: string | null
  /** The signed-in account's email matches the invitation. */
  emailMatches: boolean
}
