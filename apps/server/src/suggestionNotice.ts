// "This page's suggestions or section claims changed" for the people who have the page open
// (docs/adr/2556-*).
//
// Claims (leases.ts) and suggested edits (suggestions.ts, autoAccept.ts) used to reach an open page
// only through the web app's 15 s poll and window focus. Every function that changes a
// section_leases or section_suggestions row of a page now also sends this stateless message on the
// page's collab document, like the comments notice ({t:'comments'}, routes/comments.ts). The message
// carries nothing but its kind: the page is the document it is sent on, and the client answers it by
// calling the same REST read it polls (GET /pages/:id/suggestions), whose access check decides what
// it sees. Only connections that passed the document's onAuthenticate (collab.ts) receive it.
//
// Sent after the row change has committed (never inside its transaction), so the read it triggers
// sees the change. A failure is logged by broadcastToPage and never fails the write. Single
// instance only, like the comments notice: another process's open clients keep the poll.
import { broadcastToPage } from './collab'

/** The whole payload, on purpose: no suggestion text, section, connection or user names. */
export const SUGGESTIONS_NOTICE = { t: 'suggestions' } as const

/** Tells the open clients of each page to read its suggestions and claims again. Never throws. */
export function suggestionsChanged(...pageIds: (string | null | undefined)[]): void {
  for (const id of new Set(pageIds)) if (id) broadcastToPage(id, SUGGESTIONS_NOTICE)
}
