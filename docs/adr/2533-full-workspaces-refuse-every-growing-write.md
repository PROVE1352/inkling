# 2533. A full workspace refuses every write that grows it

- Status: Accepted
- Date: 2026-11-12

## Context
ADR 2506 made a workspace past `LIMIT_WORKSPACE_STORAGE_MB` read-only for new pages, uploads, imports,
templates, comments, handwriting, versions and body writes. The 0.22 security review (F5, R10) found the
writes it missed: `PATCH /pages/:id/props` took five ~800 KB writes into a full workspace. Row properties,
collection fields, views, row templates, titles and aliases are counted in the workspace's storage, but
those routes neither refused a full workspace nor moved the cached use, so between two recounts a
workspace with room could also outgrow its limit by a request size per write.

## Decision
- Every POST, PUT and PATCH route in the source is in a table (`quota/writeSweep.test.ts`): checked in the
  handler, checked in the helper it goes through (named), or open with the reason. A new write route fails
  the test until it is listed.
- **Checked** (161 routes surveyed): the content writes. `quota/room.ts assertWorkspaceGrowth(db, ws,
  bytes)` refuses (413 `LIMIT_STORAGE`) a workspace that is full or a write that does not fit, and moves the
  cached use by the request's JSON size at once (an upper bound; the next recount corrects it). When the
  cache says "does not fit" but was not recounted in the last 10 s, the workspace is recounted once first,
  so the upper bounds never lock a workspace that has room. Used by: row properties (R10), rows batch,
  collection fields, new and changed views, new and changed row templates, page title, icon, cover,
  aliases and date property (`PATCH /pages/:id`; moving and the switches stay open), an edited comment
  body, and every suggestion (`createSuggestions`). `assertWorkspaceWritable` (refuse when full) for new
  automations, new webhooks and new share links. Already checked before: pages, files, imports, templates,
  comments, handwriting, versions, the body writes through `docWriteGate`, quick tasks, vault sync, rows
  and the trees templates make.
- **Open**, each with its reason in the table: removing, unpublishing, rejecting, restoring from the trash
  or from deletion (counted already); membership (leaving, roles, transfer; joining keeps
  `LIMIT_MEMBERS`); settings of bounded size replaced in place (workspace name and switches, agent policy
  and rules, locks, owners, page access, the one share link's expiry, automation rules, so a rule can be
  switched off); ticking a task (ADR 2506); reads sent as POST; everything about the person only (sign-in,
  2FA, tokens, preferences, read marks, saved for later, bookmarks); the server admin's routes; the MCP
  endpoint (its tools call the routes above).
- No value cap was added to `z.unknown()` properties: a request is bounded by Fastify's 1 MiB body limit
  (the batch routes by their own), and with the storage limit every byte counts at once. A server without
  the limit keeps 0.21.1's behaviour.
- Without `LIMIT_WORKSPACE_STORAGE_MB` none of the checks reads anything; a stale `over_storage` flag is
  ignored.

## Consequences
- R10 now answers 413 five times. Six ≈320 KB property writes into a 1 MB workspace with room: three pass,
  then 413, stored 0.96 MB (the 0.22.0 code: six times 200, 1.9 MB stored).
- Replacing a value counts its size again until the next recount (hourly, the usage screen after a minute,
  a refused write after 10 s), so a workspace near its limit can refuse a large write it would have room
  for; the recount on refusal keeps that short.
- Two concurrent writes can each pass the check by at most one request (no lock is taken on these paths).
