import { eq } from 'drizzle-orm'
import type { SlackEventKind, SlackIntegrationDTO, SlackSetupInfo } from '@inkling/shared'
import { SLACK_BOT_SCOPES, SLACK_EVENT_KINDS } from '@inkling/shared'
import { db } from '../db/index'
import { slackIntegrations } from '../db/schema'
import { env } from '../env'
import { isSealed, protectSecret, revealSecret, SecretUnreadableError } from '../secretsAtRest'
import { secretBoxAvailable } from '../secretBox'

/**
 * The stored Slack app of a workspace (docs/adr/1800-*, 1801-*): reading the row, its secrets and
 * its masked view, the setup values (request URLs, manifest) and the small cache the notification
 * tap reads.
 */

export type IntegrationRow = typeof slackIntegrations.$inferSelect

export async function loadIntegration(workspaceId: string): Promise<IntegrationRow | null> {
  const [r] = await db.select().from(slackIntegrations).where(eq(slackIntegrations.workspaceId, workspaceId)).limit(1)
  return r ?? null
}

/** Stored form of a secret (sealed with APP_SECRET_KEY when set; the workspace id binds it to its row). */
export function storeSlackSecret(purpose: 'slack-bot-token' | 'slack-signing-secret', raw: string, workspaceId: string): string {
  return protectSecret(purpose, raw, workspaceId)
}

/** The bot token, or null when it cannot be decrypted (APP_SECRET_KEY missing or changed). */
export function botTokenOf(r: Pick<IntegrationRow, 'workspaceId' | 'botToken'>): string | null {
  try {
    return revealSecret('slack-bot-token', r.botToken, r.workspaceId)
  } catch (e) {
    if (e instanceof SecretUnreadableError) return null
    throw e
  }
}

export function signingSecretOf(r: Pick<IntegrationRow, 'workspaceId' | 'signingSecret'>): string | null {
  try {
    return revealSecret('slack-signing-secret', r.signingSecret, r.workspaceId)
  } catch (e) {
    if (e instanceof SecretUnreadableError) return null
    throw e
  }
}

/** `xoxb-…1234`: the prefix and the last four characters, nothing else. */
export function tokenHint(token: string): string {
  return token.slice(-4)
}

export function eventsOf(v: unknown): SlackEventKind[] {
  return Array.isArray(v) ? (v.filter((x) => (SLACK_EVENT_KINDS as readonly string[]).includes(x as string)) as SlackEventKind[]) : []
}

export function toIntegrationDTO(r: IntegrationRow): SlackIntegrationDTO {
  const readable = botTokenOf(r) !== null && signingSecretOf(r) !== null
  return {
    workspaceId: r.workspaceId,
    teamId: r.teamId,
    teamName: r.teamName,
    botUserId: r.botUserId,
    botTokenHint: `xoxb-…${r.botTokenHint}`,
    signingSecretSet: !!r.signingSecret,
    secretsReadable: readable,
    sealed: isSealed(r.botToken) && isSealed(r.signingSecret),
    channelId: r.channelId,
    channelName: r.channelName,
    events: eventsOf(r.events),
    enabled: r.enabled === '1',
    blockedReason: r.blockedReason,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Links and setup values
// ---------------------------------------------------------------------------

/** PUBLIC_URL, else APP_URL, without a trailing slash; null when neither is set. */
export function configuredOrigin(): string | null {
  const v = env.publicUrl ?? env.appUrl ?? null
  if (!v) return null
  try {
    return new URL(v).origin
  } catch {
    return null
  }
}

/** Link to a page in the web app (null without a configured origin). */
export function pageLink(origin: string | null, workspaceId: string, pageId: string): string | null {
  return origin ? `${origin}/w/${workspaceId}/p/${pageId}` : null
}

/**
 * Request URLs and the app manifest for one workspace. `fallbackOrigin` is the address the settings
 * page was opened on, used only when PUBLIC_URL / APP_URL are not set.
 */
export function setupInfo(workspaceId: string, fallbackOrigin: string): SlackSetupInfo {
  const configured = configuredOrigin()
  const origin = configured ?? fallbackOrigin.replace(/\/$/, '')
  const commandUrl = `${origin}/api/slack/w/${workspaceId}/commands`
  const eventsUrl = `${origin}/api/slack/w/${workspaceId}/events`
  let unfurlDomain: string | null = null
  if (configured) {
    const h = new URL(configured).hostname
    // Slack only unfurls real domain names (not IP addresses or localhost).
    if (h.includes('.') && !/^[\d.]+$/.test(h) && !h.startsWith('[')) unfurlDomain = h
  }
  const features: Record<string, unknown> = {
    bot_user: { display_name: 'Inkling', always_online: false },
    slash_commands: [
      {
        command: '/inkling',
        url: commandUrl,
        description: 'Search your Inkling notes (only you see the answer)',
        usage_hint: '<words> | link | unlink | help',
        should_escape: false,
      },
    ],
  }
  if (unfurlDomain) features.unfurl_domains = [unfurlDomain]
  const manifest: Record<string, unknown> = {
    display_information: {
      name: 'Inkling',
      description: 'Notes from your Inkling workspace: channel updates, /inkling search and link previews.',
      background_color: '#2b2b2b',
    },
    features,
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      ...(unfurlDomain ? { event_subscriptions: { request_url: eventsUrl, bot_events: ['link_shared', 'app_uninstalled', 'tokens_revoked'] } } : {}),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
  return {
    commandUrl,
    eventsUrl,
    unfurlDomain,
    publicUrlSet: configured !== null,
    scopes: [...SLACK_BOT_SCOPES],
    manifest,
    secretKeySet: secretBoxAvailable(),
  }
}

// ---------------------------------------------------------------------------
// Cache for the notification tap (60 s, like the webhook hook list)
// ---------------------------------------------------------------------------

export interface TapConfig {
  events: Set<SlackEventKind>
}

const TAP_TTL_MS = 60_000
const tapCache = new Map<string, { at: number; cfg: TapConfig | null }>()

/** Enabled, unblocked integration of a workspace with its event kinds; null = post nothing. */
export async function tapConfig(workspaceId: string): Promise<TapConfig | null> {
  const hit = tapCache.get(workspaceId)
  if (hit && Date.now() - hit.at < TAP_TTL_MS) return hit.cfg
  const [r] = await db
    .select({ enabled: slackIntegrations.enabled, events: slackIntegrations.events, blocked: slackIntegrations.blockedReason })
    .from(slackIntegrations)
    .where(eq(slackIntegrations.workspaceId, workspaceId))
    .limit(1)
  const events = r ? eventsOf(r.events) : []
  const cfg = r && r.enabled === '1' && !r.blocked && events.length ? { events: new Set(events) } : null
  tapCache.set(workspaceId, { at: Date.now(), cfg })
  if (tapCache.size > 10_000) tapCache.delete(tapCache.keys().next().value as string)
  return cfg
}

export function invalidateSlackCache(workspaceId: string): void {
  tapCache.delete(workspaceId)
}
