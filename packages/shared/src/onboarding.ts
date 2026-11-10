import { z } from 'zod'

// Onboarding: the intro motion, the "Getting started" checklist and the sample page
// (docs/adr/2380-*, 2381-*, 2382-*). Per person, browser sessions only (GET/PATCH /api/me/onboarding,
// POST /api/me/onboarding/sample); agents never see it.

/** Every checklist item. Which ones a person gets depends on their audience. */
export const ONBOARDING_ITEMS = ['page', 'slash', 'link', 'database', 'share', 'ai', 'explore', 'comment', 'install'] as const
export type OnboardingItemId = (typeof ONBOARDING_ITEMS)[number]

/**
 * Who the onboarding is for:
 *   owner  — runs their own workspace (the first admin of a new server, or anyone not yet in a team workspace)
 *   member — joined a workspace someone else made (invited)
 *   guest  — only has pages shared with them in other people's workspaces: no onboarding at all
 */
export type OnboardingAudience = 'owner' | 'member' | 'guest'

export const ONBOARDING_ITEMS_BY_AUDIENCE: Record<OnboardingAudience, readonly OnboardingItemId[]> = {
  owner: ['page', 'slash', 'link', 'database', 'share', 'ai', 'install'],
  member: ['explore', 'page', 'slash', 'link', 'comment', 'ai', 'install'],
  guest: [],
}

/** Shown only where the browser can install the app or keep offline copies; not needed to finish. */
export const ONBOARDING_OPTIONAL_ITEMS: readonly OnboardingItemId[] = ['install']

/**
 * Items only the browser can see (the server keeps no record of them): opening the slash menu,
 * inserting a link from the `[[` menu, copying the MCP address, opening someone else's page,
 * running the installed app or turning on offline copies. `link` and `ai` are also derived
 * from what the server stores.
 */
export const ONBOARDING_CLIENT_EVENTS = ['slash', 'link', 'ai', 'explore', 'install'] as const
export type OnboardingClientEvent = (typeof ONBOARDING_CLIENT_EVENTS)[number]

export interface OnboardingItemDTO {
  id: OnboardingItemId
  done: boolean
}

export interface OnboardingDTO {
  /** false when the operator set ONBOARDING=off: show nothing. */
  enabled: boolean
  audience: OnboardingAudience
  /** Play the intro by itself now (a new account that has not closed it yet). */
  intro: boolean
  checklist: {
    /** Show the card (not dismissed, not finished, not a guest). */
    show: boolean
    collapsed: boolean
    dismissed: boolean
    /** Every non-optional item is done. */
    complete: boolean
    items: OnboardingItemDTO[]
  }
  /** Live sample pages by workspace id (root page id); a trashed sample is left out. */
  samples: Record<string, string>
}

/** PATCH /me/onboarding — any subset; at least one field. */
export const updateOnboardingSchema = z
  .object({
    introSeen: z.literal(true).optional(),
    collapsed: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    event: z.enum(ONBOARDING_CLIENT_EVENTS).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change')
export type UpdateOnboardingInput = z.infer<typeof updateOnboardingSchema>

/** POST /me/onboarding/sample — the sample page in this workspace, in the caller's private pages. */
export const createSamplePageSchema = z.object({ workspaceId: z.uuid() }).strict()

export interface SamplePageResultDTO {
  pageId: string
  workspaceId: string
  /** false = a live sample already existed in this workspace and is returned instead. */
  created: boolean
}
