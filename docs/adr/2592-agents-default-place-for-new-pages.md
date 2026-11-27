# 2592. A default place for pages that agents create

- Status: Accepted
- Date: 2026-11-27

## Context
An agent that creates a page without naming a parent puts it at the top level of the shared section. In a busy
workspace the top level fills up with meeting summaries, research notes and imports that people then move by hand.
People asked for one place where such pages go unless the agent chooses otherwise: a default, not a rule.

## Decision
- `workspaces.agent_default_parent_id` (uuid, FK to `pages`, ON DELETE SET NULL), migration 0065. Empty on every
  workspace after the upgrade. Deleting the page for good clears the setting.
- `PUT /api/workspaces/:id/settings/agent-default-parent { pageId: uuid | null }` → `{ settings, role, can }`.
  Owners and admins, browser only (members, guests and tokens get 403), audited as `settings.updated`. Refused with
  400: `Page is invalid` (missing or in another workspace), `DEFAULT_PARENT_PRIVATE`, `DEFAULT_PARENT_COLLECTION`,
  `DEFAULT_PARENT_INSTRUCTIONS` (the page or a page above it is an agent instruction page, docs/adr/0975-*).
  `GET /api/workspaces/:id/settings` returns `settings.agentDefaultParent: { id, title } | null` (null while the
  page is in the trash); `GET /api/workspaces` adds `agentDefaultParentId`.
- When it applies: a token request (an MCP OAuth connection, an agent connection token or a personal API token; not
  a database automation and not the browser) that creates at the top level of the shared section without naming a
  parent:
  - `POST /api/pages` without `parentId` (`parentId: null` is the top level on purpose),
  - `POST /api/workspaces/:id/import` and `/import-folder` without the `parentId` query (`?parentId=root` is the top
    level on purpose),
  - `POST /api/pages/from-template` without `parentId` (null is the top level on purpose).

  When the page is used, the answer adds `defaultParent: { id, title }`.
- Left alone: the private section, the browser, the web clipper (`POST /api/clip`, which has its own target), vault
  sync (`/sync/pages` mirrors the vault's tree), the tasks document (found as a single top-level document), and
  duplicates (placed next to the original).
- Skipped without a word (the page is created at the top level as before and the answer says nothing) when the page
  is in the trash, the caller cannot see it (connection range, agent blocks), it or a page above it is an
  instruction page (even for a token of someone who may edit there), or the caller may not write there (edit lock,
  the lock's agent rules such as agents read, page levels, suggest-only). A connection that cannot see the page
  learns neither its title nor that it exists. A connection limited to a subtree is still refused at the top level
  as before, and creates under the default page when that page is inside its range.
- MCP: `create_page`, `create_collection`, `create_from_template`, `import_folder` and `import_zip` say in one
  sentence that a page without `parentId` may go under the workspace's default page for agents. The answer says so:
  a `placed` field in the JSON of `create_page`, `create_from_template` and `import_folder`, one line for
  `create_collection` and `import_zip`: `placed under "<title>" (<id8>), this workspace's default place for new agent
  pages; pass parentId to choose, or move_page(parentId=null) for the top level`. `create_page` with
  `private=true` creates at the top level on purpose and then moves the page to private, so it never uses the
  default.
- Web: **New agent pages go here** (checked when on) in a page row's ⋯ menu, for admins, on shared pages that are
  not databases. Workspace settings › Connected agents › **New pages from agents** shows the page as a link with
  **Clear**.

## Alternatives
- Handle it in the MCP tools only. Personal API tokens and scripts would keep filling the top level.
- A new tool argument (`topLevel`) to ask for the top level. Every session would pay for it in the tool list;
  `parentId: null` and `move_page` already say it.
- A forced place that agents cannot leave. People asked for a default, and an agent asked to file a page somewhere
  else should be able to.
- Refuse a connection that cannot use the page. The refusal would tell it that a default page exists.

## Consequences
- An agent's new page may not be where the agent assumed; the answer names the place and how to choose another.
- A personal API token's `POST /api/pages` without `parentId` lands under the default page; a script that wants the
  top level sends `parentId: null`.
