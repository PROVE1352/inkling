import { sql } from 'drizzle-orm'
import { db } from '../db/index'
import { claimState, onboardingEnabled } from './state'

/**
 * "Your agent is connected" (docs/adr/2390-*): the first authenticated /mcp request of a person's agent
 * (an OAuth grant or an agent connection token) records `agentAt` in their onboarding state and ticks
 * the checklist's `ai` item. Called by the /mcp handler after the bearer check (mcp.ts).
 *
 * At most one database round trip per person and process: once recorded (or found recorded), the
 * person is remembered here and later requests touch nothing. The update is conditional
 * (`agentAt IS NULL`), so after a restart the one check writes no row for someone already recorded.
 * It never fails or holds up the request beyond that first check: errors are logged and the next
 * request tries again.
 */

const known = new Set<string>()
const inflight = new Map<string, Promise<void>>()
/** Bounds the memory on a server with very many agents; forgetting only costs one more check. */
const KNOWN_MAX = 50_000
let statements = 0

/** Database statements this module ran since start (tests count the writes a request causes). */
export function agentNoteStatements(): number {
  return statements
}

/** Tests: forget what was remembered, as a restart does. */
export function forgetAgentNotesForTests(): void {
  known.clear()
}

/** Record that this person's agent connected, once. Resolves when it is recorded (or skipped). */
export function noteAgentConnected(userId: string): Promise<void> {
  if (known.has(userId) || !onboardingEnabled()) return Promise.resolve()
  const running = inflight.get(userId)
  if (running) return running
  const p = record(userId)
    .then(() => {
      if (known.size >= KNOWN_MAX) known.clear()
      known.add(userId)
    })
    .catch((err: unknown) => {
      console.error('[inkling] onboarding: recording the agent connection failed', err)
    })
    .finally(() => inflight.delete(userId))
  inflight.set(userId, p)
  return p
}

async function record(userId: string): Promise<void> {
  if (await markConnected(userId)) return
  // No row yet (the person never opened the web app since their account was made): make it the way
  // the first onboarding read does, so ONBOARDING=off and legacy rows keep their meaning, then mark.
  statements++
  const exists = (await db.execute(sql`SELECT 1 FROM user_onboarding WHERE user_id = ${userId}`)) as unknown as unknown[]
  if (exists.length > 0) return
  statements++
  await claimState(userId)
  await markConnected(userId)
}

/** The conditional update: true when the row exists and now has `agentAt` set by this call. */
async function markConnected(userId: string): Promise<boolean> {
  const at = new Date().toISOString()
  statements++
  const rows = (await db.execute(sql`
    UPDATE user_onboarding
       SET state = state || jsonb_build_object(
             'agentAt', ${at}::text,
             'done', coalesce(state->'done', '{}'::jsonb) || jsonb_build_object('ai', coalesce(state->'done'->'ai', to_jsonb(${at}::text)))
           ),
           updated_at = now()
     WHERE user_id = ${userId} AND state->'agentAt' IS NULL
    RETURNING user_id
  `)) as unknown as unknown[]
  return rows.length > 0
}
