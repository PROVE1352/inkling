# 2004. Long agent instructions: a note at the end of get_instructions and a length route

- Status: Accepted
- Date: 2026-11-10

## Context
get_instructions returns every `always` instruction page in full (and, with forPageId, every
matching one) at the start of an agent's work in a workspace. Each body is already cut at 12,000
characters (INSTRUCTION_BODY_MAX), but several pages add up, and a long rule set costs every session
and dilutes the rules that matter. Another agent tool draws a line for a file it reads at the start
of every session: its auto-memory index is read only up to the first 200 lines or 25 KB. Nobody in
the workspace sees the size today, and the warning in the web app's instruction settings belongs to
the web work stream, which needs a value from the server.

## Decision
- **Limit**: long = more than 200 lines or more than 25,000 bytes (UTF-8) of the Markdown an agent
  receives (lines are newline-separated lines, blank ones included, as in a file). One function,
  `measureInstructions` (`instructionLength.ts`), is used by both outputs below.
- **get_instructions** measures the bodies it returned in full (always, plus matching ones with
  forPageId) and, when long, ends with one line:
  `note: the instructions above are N lines, X KB (~T tok), past the 200 lines or 25 KB that some
  agent tools read of such files; follow all of them, and tell the person a workspace owner or admin
  could shorten them or move details to on-request instructions.` Deterministic; nothing else in the
  output changes, and the rules' `v=` hash is unchanged.
- **`GET /api/workspaces/:id/agent-instructions/length`** (members, `routes/instructionLength.ts`):
  `{ limits: { lines, bytes }, always: { lines, bytes, tokens, long, pages }, pages: [{ pageId, mode,
  lines, bytes, tokens, long, truncated }] }`, measured on the same text as get_instructions
  (`instructionBody`, live document first, cut at 12,000 characters; `truncated` says it was cut).
  Sizes only, no text. Who may see the list of instruction pages is unchanged (any member).
  A separate route rather than a field on `AgentInstructionDTO`: the DTO is built by
  `instructionRows`, which read paths call through `applicableInstructions`, and measuring needs each
  page's Markdown; the lock state's DTO is built elsewhere (`editLock.ts`).

## Measured
No change to fixed cost: the note appears only when the instructions are long (~60 tokens then).
The route converts each instruction page to Markdown once per call (the same work as one
get_instructions call).

## Alternatives considered
- **Token limit** (e.g. 6,000 estimated tokens): tracks cost better, but has no outside reference and
  differs by language under our estimator (Hangul counts one token per character); lines and bytes
  are what a person editing the page can see and fix.
- **Cutting the bundle at the limit**: would drop rules silently; the existing 12,000-character cut
  per page stays and says `[truncated]`.
- **Counting only the `always` pages in the note**: matching pages are also returned in full and paid
  for by the session that asked for them.

## References
- apps/server/src/instructionLength.ts, routes/instructionLength.ts, mcpTools/instructionTools.ts
- apps/server/src/mcpTools/profilesResources.db.test.ts, toolProfiles.test.ts
- docs/adr/0975-*
