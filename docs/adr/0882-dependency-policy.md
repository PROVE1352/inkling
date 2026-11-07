# 0882. Dependency policy: pinned editor stack, frozen lockfile, Dependabot with exclusions

- Status: Accepted
- Date: 2026-11-07

## Context
- `@blocknote/*` 0.51.4 is used by five packages across `apps/web` and `apps/server`.
  `patches/@blocknote__core@0.51.4.patch` (`patchedDependencies` in `pnpm-workspace.yaml`)
  replaces an `editor.getBlock(id)` call in `getBlockFromPos` that walks the whole document
  (O(n²) while a large document builds its node views). The patch key carries the exact version.
- `apps/web/src/lib/perf.test.ts` asserts that the local code-block language table equals the
  pinned `@blocknote/code-block` table verbatim (ADR 0704).
- `pnpm-workspace.yaml` overrides `prosemirror-view` to 1.42.4 so the editor stack shares one
  copy. The original reason for the exact version was not recorded; it moves with BlockNote.

## Decision
- `@blocknote/*` dependencies are exact versions (no range), all equal, in every package.
- CI installs with `--frozen-lockfile` and runs `scripts/check-editor-pins.mjs`
  (`pnpm check:pins`), which fails when: a `@blocknote/*` specifier is not exact or versions differ;
  the lockfile resolves any `@blocknote/*` package to more than one version or a different one; the
  patch key no longer matches the BlockNote version; `prosemirror-view` resolves to anything other
  than the override.
- Dependabot: npm weekly (development minor/patch and production patch updates grouped),
  GitHub Actions monthly. `@blocknote/*` and `prosemirror-*` are ignored; they are upgraded by
  hand following CONTRIBUTING.md "Upgrading the editor".

## Alternatives considered
- Letting Dependabot bump BlockNote: it opens one pull request per package, so web and server
  drift apart, and a bumped `@blocknote/core` silently drops the patch.
- Ignoring only `@blocknote/core`: the five packages must move together.
- Ranges with the lockfile as the only pin: a `pnpm install` after any unrelated change can move
  the editor; an exact specifier makes the intent visible in review.
- Vendoring BlockNote: a large fork to maintain for a one-function patch.

## Trade-offs
- Editor security fixes are not proposed automatically; someone has to watch BlockNote and
  ProseMirror releases.
- The lockfile check is a line scanner, not a YAML parser; a lockfile format change
  (`lockfileVersion` other than 9.0) needs the script updated.

## Consequences
- Editor upgrades are deliberate, single pull requests that re-create the patch and run the manual
  editor checks listed in CONTRIBUTING.md.

## Addendum: why prosemirror-view is pinned to exactly 1.42.4

`prosemirror-view` < 1.42.3 has a paste XSS advisory, so it is overridden upward. The override is an exact `1.42.4`, not `>=1.42.3`: `1.42.9` (what a range resolves to) requires `prosemirror-model ^1.25.12`, while the BlockNote 0.51.4 editor stack resolves `prosemirror-model 1.25.10`. A range therefore splits the lockfile into two `prosemirror-model` copies — the same shape as the incident where duplicated ProseMirror modules rendered every document body empty. `1.42.4` is the last release that accepts `prosemirror-model ^1.25.8`, so the editor keeps a single model instance. Raise it only together with BlockNote and verify with `pnpm check:pins`.
