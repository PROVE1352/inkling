# 2166. Vault sync retries: a create happens once, a repeated write changes nothing

- Status: Accepted
- Date: 2026-11-10

## Context
`inklingctl sync` saves its state only at the end of a run, or in the error handler when a request
fails. A run cut off after the server committed a request but before the CLI recorded the answer
(a lost response, a killed process, a laptop lid closed) left work the next run could not
recognise. Measured with the fault sweep of `vaultSyncResume.db.test.ts` (one mixed scenario, a
fault at every request index, three modes: connection cut before the handler, response lost after
it, CLI killed with SIGKILL after it):
- A note with links or attachments is created empty and filled at the end of the run. Any failure
  in between left an empty page that the next run downloaded as `Name (2).md` while it created the
  note a second time: two pages, two files.
- A plain note created in one request duplicated the same way unless its text was already in
  Inkling's canonical Markdown form (the next run links a new page to a same-named note only when
  the texts are equal).
- A vault edit whose PUT answer was lost came back as "changed on both sides". The server holds the
  canonical form of the note (`*` bullets where the note has `-`), so the line merge reported the
  same lines changed differently: a conflict copy for an edit that had in fact gone through.

## Decision
- **Creates carry a retry key.** Before the creates of a run go out, the CLI gives every new note
  and folder a random UUID (`clientKey`) and saves it in `sync-state.json` (`pending`). `POST
  /workspaces/:id/sync/pages` makes the page with the id `syncCreateId(workspaceId, clientKey)`
  (SHA-256 of both, shaped as a UUID). If a live page with that id exists in the workspace, of the
  same kind and made by the same account, the request answers that page as it is now with
  `replayed: true` instead of making another; in every other case it makes the page with a fresh
  random id. The CLI computes the same id, so a run after a cut-off one recognises the page the
  lost request made before it reads anything: it fills it from the note (a normal write), or trashes
  it when the note is gone meanwhile. Keys are dropped when the create is answered and at the end of
  a completed run.
- **A two-phase create is recorded as soon as the page exists**, with an empty local hash: a run cut
  off before the fill uploads the note next time.
- **A write with a stale revision is accepted when it would change nothing.** On a revision or
  metadata mismatch `PUT /pages/:id/sync/md` renders the note as it would store it and compares it
  with the page's canonical Markdown (content hash). Equal: 200 with the current version, nothing
  written. Different: 412 as before. When both sides changed, the CLI now tries the write first and
  merges only on 412.

## Alternatives considered
- **The client picks the page id.** Simpler, but a create with an id that exists elsewhere would have
  to answer differently from one that does not, which tells a caller that the id exists
  (docs/adr/1301-*). A derived id cannot be aimed at an existing page.
- **An idempotency table on the server** (key → page id, with expiry): needs a migration and
  housekeeping for the same effect.
- **Saving the state after every request**: narrows the window but does not close it (the answer
  can still be lost after the commit), and costs a full state write per note on a first sync.
- **Matching unrecorded pages by title and folder on the next run**: links a page someone else made
  with the same name, and still needs a line merge without a common base.
- **A canonicalisation endpoint** the CLI calls before merging: a new route for every server to
  expose, and the merge would still have to guess whether the write was applied.

## Consequences
- The fault sweep (every request index × three modes) ends in the same pages, files and texts as an
  uninterrupted run, without conflict copies.
- Servers before 0.17 ignore `clientKey` (the body schema strips unknown keys) and keep answering 412
  for a repeated write: a new CLI against an old server behaves as before. An old CLI against a new
  server sends no key and is unchanged.
- An empty note created twice in a row on purpose cannot be told from a retry only if it has the
  same key, which only the same pending entry gives; a new note always gets a new key.
- A stale write costs one extra render on the server before the 412.

## References
- apps/server/src/routes/sync.ts (`syncCreateId`, create, PUT `stale`)
- apps/cli/src/commands/sync.ts (`pending`, `resumed`, `abandoned`, pass 2), apps/cli/src/sync/vault.ts (`syncCreateId`)
- apps/server/src/routes/vaultSyncResume.db.test.ts, vaultSyncSecurity.db.test.ts
