import { z } from 'zod'

// ---------------------------------------------------------------------------
// Slack app per workspace: channel notifications, /inkling search, link unfurls (docs/adr/1800-* .. 1806-*)
// ---------------------------------------------------------------------------

/**
 * Channel notification kinds, each switched on or off per workspace (docs/adr/1802-*):
 *  - mention:    someone was @mentioned in a page or a comment
 *  - assigned:   someone was made a page's owner or put in a person field (task assignment)
 *  - suggestion: an agent left an edit suggestion waiting for a person (open suggestion)
 *  - reply:      a reply in a comment thread
 *  - digest:     once a day, the shared pages that changed in the last day
 * Only pages shared with the whole workspace are ever named in the channel.
 */
export const SLACK_EVENT_KINDS = ['mention', 'assigned', 'suggestion', 'reply', 'digest'] as const
export type SlackEventKind = (typeof SLACK_EVENT_KINDS)[number]

/** Bot scopes the app needs (shown next to the manifest). */
export const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'commands', 'links:read', 'links:write', 'users:read', 'users:read.email'] as const

/** A bot token (`xoxb-…`). Never returned by the API once saved. */
export const slackBotTokenSchema = z
  .string()
  .trim()
  .regex(/^xoxb-[A-Za-z0-9-]{10,250}$/, 'A bot token starts with xoxb-')
/** The app's signing secret (hex). Never returned by the API once saved. */
export const slackSigningSecretSchema = z
  .string()
  .trim()
  .regex(/^[A-Fa-f0-9]{16,128}$/, 'The signing secret is a hexadecimal string')
/** A channel id (C… public, G… private), not a #name: names change, ids do not. */
export const slackChannelIdSchema = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{2,30}$/, 'Use the channel ID (C…), not its name')

/**
 * PUT /api/workspaces/:id/slack. The token and secret are required the first time; afterwards an
 * omitted value keeps the stored one (the client never has it to send back).
 */
export const slackSettingsSchema = z.object({
  botToken: slackBotTokenSchema.optional(),
  signingSecret: slackSigningSecretSchema.optional(),
  channelId: slackChannelIdSchema,
  events: z
    .array(z.enum(SLACK_EVENT_KINDS))
    .max(SLACK_EVENT_KINDS.length)
    .transform((a) => [...new Set(a)]),
  enabled: z.boolean().default(true),
})
export type SlackSettingsInput = z.input<typeof slackSettingsSchema>

/** The stored connection, without its secrets (docs/adr/1801-*). */
export interface SlackIntegrationDTO {
  workspaceId: string
  /** Slack team the token belongs to (from auth.test when the token was saved). */
  teamId: string
  teamName: string | null
  botUserId: string | null
  /** `xoxb-…` + the last four characters; the token itself is never returned. */
  botTokenHint: string
  /** A signing secret is stored (its value is never returned). */
  signingSecretSet: boolean
  /** false when the stored token or secret cannot be decrypted (APP_SECRET_KEY missing or changed). */
  secretsReadable: boolean
  /** The secrets are sealed with APP_SECRET_KEY (false: stored as typed because the key is not set). */
  sealed: boolean
  channelId: string
  channelName: string | null
  events: SlackEventKind[]
  enabled: boolean
  /** Why channel posts are paused (revoked token, bot removed from the channel …); cleared on save or a passing test. */
  blockedReason: string | null
  lastError: string | null
  lastErrorAt: string | null
  lastSuccessAt: string | null
  updatedAt: string
}

/** What the operator types into the Slack app settings (or pastes as a manifest). */
export interface SlackSetupInfo {
  /** Slash command request URL. */
  commandUrl: string
  /** Event subscriptions request URL (link unfurls). */
  eventsUrl: string
  /** Domain to list under link unfurling; null without PUBLIC_URL / APP_URL. */
  unfurlDomain: string | null
  /** PUBLIC_URL or APP_URL is set (request URLs otherwise follow the address this page was opened on). */
  publicUrlSet: boolean
  scopes: string[]
  /** App manifest (JSON) with the URLs above filled in. */
  manifest: Record<string, unknown>
  /** APP_SECRET_KEY is set: the token and secret are encrypted at rest. */
  secretKeySet: boolean
}

/** GET /api/workspaces/:id/slack */
export interface SlackSettingsResponse {
  integration: SlackIntegrationDTO | null
  setup: SlackSetupInfo
}

/** A Slack account linked to an Inkling member of the workspace. */
export interface SlackLinkDTO {
  userId: string
  name: string
  slackUserId: string
  /** 'email': matched by address; 'link': confirmed by the person with a one-time link. */
  method: 'email' | 'link'
  createdAt: string
}

/** POST /api/slack/link/preview: what a one-time link code would link (shown before confirming). */
export interface SlackLinkPreviewDTO {
  workspaceId: string
  workspaceName: string
  teamName: string | null
  slackUserId: string
  expiresAt: string
}

/** POST /api/workspaces/:id/slack/test */
export interface SlackTestResultDTO {
  ok: boolean
  /** Slack's error code (e.g. not_in_channel), never a secret. */
  error: string | null
}

export const slackLinkCodeSchema = z.object({ code: z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/) })
