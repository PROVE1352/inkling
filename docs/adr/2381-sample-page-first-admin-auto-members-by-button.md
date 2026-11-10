# 2381. The sample page: made for the first admin once, for members by button, private, labelled as a sample

- Status: Accepted
- Date: 2026-11-11

## Context
A page to try things on (blocks, `[[links]]`, check boxes, callouts, a small database with an inline
view, a Mermaid diagram, shortcuts) helps a new person more than an empty tree. It must not clutter a
team's shared space, must not come back after it was deleted, and must not crowd out real notes when
an agent searches with `find_context`.

## Decision
- **Content** (`onboarding/sample.ts`, English and Korean, the person's language from
  `requestLocale`): root "Getting started with Inkling (sample)" / "Inkling 시작하기 (샘플)" whose first
  block is a callout saying it is a sample to delete; a child page to link to; a "Sample tasks"
  database (status select, date; table, board and calendar views; three rows) and an inline view of it
  in the root page.
- **Built with the template machinery, not listed as a template**: a `SpecNode` compiled by
  `compileSpec` (exported from `templates/builtins.ts`) and created by `instantiateTree`, so it gets
  the same transaction, tree lock, placement and indexing as a template. It is not in `BUILTINS`, so the
  gallery, `GET /workspaces/:id/templates` and the MCP `list_templates` output do not change.
- **Template change**: an embed in a template document that names a page of the same template is
  remapped to the new copy (`transformDocState` `remapPageId`). Specs name it by title
  (`"pageId":"@Title"`). Custom templates saved from a page with an inline view of a database inside the
  saved subtree now get a view of their own copy instead of the original; embeds of pages outside the
  template are kept as before.
- **Where and when**:
  - The first admin of a new server (an admin with no older account) gets it once, in their first
    workspace, on their first onboarding read (`maybeAutoSample`, claimed atomically).
  - Everyone else (an invited member, a later account) never gets it by itself; the checklist card's
    "Make a sample page" button makes it (`POST /api/me/onboarding/sample { workspaceId }`, members
    only, `requireMembership` without guests).
  - Always in the person's **private** pages (scope `private`), at the top level.
  - One live sample per person and workspace: a second call returns the live one (`created: false`);
    concurrent calls are serialized by a per-workspace mark in the state (60 s).
  - Deleted: never made again by itself; the button may make a new one.
- **Search and agents**: the index weight is unchanged. The title and first line say "sample", there
  is at most one per person and workspace, it is short (about 200 words) and private, so only the
  person and their own agent connections can find it.

## Alternatives considered
- **A listed built-in template "Getting started".** Changes `list_templates` output for every agent
  and the gallery for every person; the button covers the "make it again" case.
- **Shared scope in the first workspace.** The first workspace usually becomes the team's; every
  member and every agent connection would find the sample. Private keeps it to the person.
- **Lower its search weight or exclude it from `find_context`.** A new rule in the ranking for one page
  type; the label and privacy are enough, and a person may well want to find it.
- **Create it inside the sign-up transaction.** `instantiateTree` takes its own workspace tree lock
  and transaction; a failure there would fail sign-up. Creating it on the first read keeps sign-up as
  it was and is best-effort (`autoSample: 'failed'` is recorded, nothing is retried).

## Trade-offs
- An admin whose first read happens while the server is unhealthy does not get the sample
  automatically; the button still works.
- The sample's pages count toward nothing on the checklist (ADR 2380), so a person who only edits the
  sample sees `/` and `[[` ticked from their browser events, not from stored links.

## Consequences
- `onboarding.db.test.ts`: private, in the person's language, the inline view points at the copy,
  Mermaid/callout/check list blocks, other members cannot see it, once per workspace, not recreated
  after delete, recreated by button. `onboardingFirstAdmin.db.test.ts` (own database): the `/setup`
  account gets one sample even with two concurrent first reads; a signup-key account gets none.
