import type { OnboardingDTO } from '@inkling/shared'

// Shortcuts from a new person's first screens to the next useful step (docs/adr/2380-*): one place for
// "connect an AI agent" (the per-app setup on /settings/connections, not the Settings row that only
// links there) and the rule for offering the practice sample page on the empty home screen.

/** Where every "Connect an AI agent" button and link goes: the app picker and the command to paste. */
export const AI_CONNECT_PATH = '/settings/connections'

/** What the connect hint points at on that screen: the app picker together with its command. */
export const AI_CONNECT_HINT_TARGET = '[data-onboarding="mcp-app"]'

/**
 * Whether the empty home screen leads with "Make a sample page to practise on": onboarding is on, the
 * person is a member here (not a guest), has no live sample in this workspace and still has the
 * getting-started card (the intro's end screen uses the same rule, so accounts from before onboarding
 * and people who dismissed the card keep New page as the main button).
 */
export function homeOffersSample(dto: OnboardingDTO | null | undefined, wsId: string | undefined, guest: boolean): boolean {
  if (!dto || !dto.enabled || !wsId || guest) return false
  if (dto.audience === 'guest' || dto.checklist.dismissed) return false
  return !dto.samples[wsId]
}

/** The sample page in this workspace, for "see the example suggestions on the sample page"; else null. */
export function samplePageOf(dto: OnboardingDTO | null | undefined, wsId: string | undefined): string | null {
  if (!dto || !dto.enabled || !wsId) return null
  return dto.samples[wsId] ?? null
}

/**
 * The "Other options" fold under the command (tool set, sign-in method) starts open only when a choice
 * there is not the default, e.g. a token was just made on this screen and the settings switched to it.
 */
export function mcpOptionsOpen(profile: 'full' | 'core', auth: 'oauth' | 'token'): boolean {
  return profile !== 'full' || auth !== 'oauth'
}

/**
 * The share step's hint and what it points at. The invite link is always there (no server switch turns it
 * off); the public link from the page's globe button is named only while `public-links` is on.
 */
export function shareHint(publicLinksOff: boolean): { key: 'getStarted.item.share.hint' | 'getStarted.item.share.hintInviteOnly'; publicLink: boolean } {
  return publicLinksOff ? { key: 'getStarted.item.share.hintInviteOnly', publicLink: false } : { key: 'getStarted.item.share.hint', publicLink: true }
}
