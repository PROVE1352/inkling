import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

/**
 * Who made a change: a person or an agent (docs/adr/1870-*).
 *
 * `via` (users' `via`, page_changes.via_client, pages.created_via, notifications.via_client, …) is
 * the OAuth client name of an agent connection. One value is not an agent: answers sent through a
 * public form carry `via = "public form"` so the feed can say "<publisher> via public form"
 * (docs/adr/1822-*), but what they hold was typed by a person. Every place that sorts changes into
 * "AI" and "people" asks these helpers, never `via IS NOT NULL` on its own. The name is reserved for
 * OAuth clients (clientName.ts), so no agent can pass for a form.
 */
export const PUBLIC_FORM_VIA = 'public form'

/** The via of an agent connection (not null, not the public form marker). */
export function isAgentVia(via: string | null | undefined): via is string {
  return !!via && via !== PUBLIC_FORM_VIA
}

/** SQL: the via column names an agent connection. */
export function agentViaSql(col: SQL): SQL {
  return sql`(${col} IS NOT NULL AND ${col} <> ${PUBLIC_FORM_VIA})`
}

/** SQL: the change was made by a person (no via, or through a public form). */
export function personViaSql(col: SQL): SQL {
  return sql`(${col} IS NULL OR ${col} = ${PUBLIC_FORM_VIA})`
}
