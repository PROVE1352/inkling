# 0925. Template gallery, visibility rules and MCP tools

- Status: Accepted
- Date: 2026-11-07

## Decision
- **Gallery** (`TemplateGalleryModal`): categories Docs / Projects / Meetings / Personal / Custom,
  search over name and description, source filter (built-in / workspace / mine), and a preview.
  The preview is server-produced plain data (first 14 blocks as `{type, text, depth}` + page
  outline with database field/view/row counts), rendered as React elements — no HTML from
  templates reaches `innerHTML`. "Use template" opens the variable step (title, date for dated
  templates, input questions). Import and export live in the gallery.
- **Visibility:** shared templates → every workspace member; private → creator only (saved from a
  private page, or "Only me"). Private templates answer 404 to others on list, preview, export,
  use and delete. A template is usable only in its own workspace. Deleting needs the creator or an
  owner. Every route goes through `requireMembership`, which also returns 404 for a soft-deleted
  workspace (ADR 0910).
- **MCP:** `list_templates` and `create_from_template` call the REST routes through `app.inject`
  as the token user, like every other tool, so permissions are identical to the web app.
  `create_from_template` accepts a built-in key or uuid, `inputs`, `date`, `parentId` and
  `private` (top level only, as in `create_page`).
- **Strings:** gallery strings are a separate i18n area (`i18n/{en,ko}/templates.ts`); built-in
  template bodies are written per language, not translated word for word.

## Trade-offs
The gallery lists every template on open (no paging); workspaces are expected to hold dozens, not
thousands.
