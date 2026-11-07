# 0995. Math nodes in both editor schemas, built from one shared config

- Status: Accepted
- Date: 2026-11-07

## Context
Equations (KaTeX) are a block (`math`, display) and an inline atom (`inlineMath`) in the web editor.
The server reads documents through its own BlockNote editor (`apps/server/src/md/editor.ts`) for
Markdown export, MCP reads, indexing and `patch_section`. y-prosemirror deletes the Yjs items of
nodes the reading schema does not know (ADR 0940). ADR 0940 stopped the server from reading the
live document, but a node the server does not know is still missing from every server read: it is
absent from exports and MCP output, and a server write built from such a read drops it.

`@blocknote/core` is not a dependency of the server package; only `@blocknote/server-util` (same
pinned version) is, and no dependency may be added for this.

## Decision
- `packages/shared/src/math.ts` holds the node configs: type names `math` / `inlineMath`, one
  string prop `latex` (default `''`), content `none`. The web specs (`components/blocks/Math.tsx`)
  and the server specs (`md/serverSchema.ts`) are both built from these objects, so the
  ProseMirror node names and attributes cannot drift apart. `inlineMath` is an atom; `latex` is the
  LaTeX source, never rendered HTML.
- The server schema is BlockNote's defaults plus the two math specs, passed to
  `ServerBlockNoteEditor.create({ schema })`. Core is imported from server-util's own resolution
  (`createRequire(server-util).resolve('@blocknote/core')` → the package's `exports['.'].import`
  ESM entry) with a top-level `await import()`, so `getServerEditor()` stays synchronous. It must
  be the ESM entry: server-util imports core as ESM, and a CJS copy would be a second module
  instance whose schema class the editor does not recognise. A small local interface types the
  five core exports used, because core's types are not resolvable from the server package.
- The server specs render the LaTeX source as text (`<div class="nd-math-source">`,
  `<span class="nd-math-inline-source">`); BlockNote adds `data-latex` to the wrapper. The server
  never renders KaTeX (ADR 0999).
- The page-embed viewer (`PageEmbed.tsx`) binds a read-only editor to another page's live doc, so
  its schema registers the math nodes too.
- `patch_section` needs no change: `inlineMath` becomes a known inline token whose key includes its
  attributes, so an edited formula is replaced and an unchanged one is left alone.
- Full-text search indexes the LaTeX source (`md/textIndex.ts`).

## Alternatives considered
- **Add `@blocknote/core` to the server's dependencies**: the clean import, but a lockfile change
  for a package that is already installed at the pinned version (ADR 0882).
- **Keep math unknown to the server and rely on copy reads (ADR 0940)**: exports, MCP reads and any
  server write would still drop every formula.
- **Hand-copy the web specs on the server** (rejected in ADR 0940 for callouts): drifts. Sharing
  only the config, not the React render, avoids that for nodes whose data is one string.

## Consequences
- Tests (`apps/server/src/md/math.test.ts`): a Yjs round trip keeps both nodes; reading the live
  doc with the server editor writes nothing, while BlockNote's default schema deletes them (control);
  public HTML carries the source as text and in `data-latex`; a no-op `patch_section` over a
  section with math writes nothing, and editing a formula keeps the math of other sections.
- Callouts, mentions and embeds are still unknown to the server (ADR 0940, KNOWN-ISSUES).
- A BlockNote upgrade must keep `createBlockSpec` / `createInlineContentSpec` and the
  `exports['.'].import` layout of core; `serverSchema.ts` fails at boot otherwise.
