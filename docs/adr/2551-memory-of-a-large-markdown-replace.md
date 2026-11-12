# 2551. Memory of a large Markdown replace: what holds it, what was cut, what is left

- Status: Accepted
- Date: 2026-11-12

## Context
After ADR 2550 the random-words replace no longer explodes, but ordinary Markdown of ~1 MB (the
repository's ADRs: headings, lists, tables, code) already took ~640 MB of RSS on the **first** replace
with a 512 MB heap, and with a 320 MB heap (the demo preset) the agent path died on the first replace.
Measured where the memory goes, with forced GC between steps, a heap snapshot after each conversion
and heap snapshots taken at the heap limit (`--heapsnapshot-near-heap-limit`), on a 990K body:

| what | heap |
|---|---|
| server at rest after boot | ~84 MB |
| the parsed blocks (6–8k blocks) | 10–13 MB |
| one Y.Doc of the body (126k structs, 3.7 MB stored) | ~46 MB |
| the blocks read back from it | ~10 MB |
| `markdownToBlocks`: kept **after** it returned | ~108 MB |
| `blocksToMarkdown` of the whole body: kept after it returned | ~128 MB |

The two "kept after" rows are not leaks that grow, but each holds a whole DOM of the last large body:
- Parsing: BlockNote core parses the HTML inside one HTML document it caches for the process
  (`@blocknote/core` dist `src-*.js`: `var en = null; function tn() { return en ||=
  document.implementation.createHTMLDocument("title") }`). jsdom's selector engine (nwsapi) on that
  document remembers the element of its last query (`_nwsapi.Snapshot.from`), which is in the last
  parsed body, so the entire DOM stays reachable until the next parse that runs a list query.
- Exporting: a detached DOM root (`div`, all 27.5k text nodes of the body) stays held by closures of
  the export; the holder was not identified further.

The replace itself held, at its peak in the dry run: the live doc, the throwaway doc BlockNote built
for the new blocks, a copy of that doc only to read it, the dry run's copy (old blocks + new clones),
and the dry run's validation read, which again copied the copy before reading it.

## Decision
- After parsing more than 64 KiB of Markdown, `markdownToBlocks` parses a one-item list
  (`releaseParseDom`), which moves the selector engine's reference to a tiny element: the ~100 MB is
  released right away instead of at the next large parse (measured: 192 → 89 MB of heap).
- The two throwaway documents of a replace (the new blocks' document, the dry run's copy) are read
  directly; `readBlocks` copies only to protect a live document from y-prosemirror's destructive read,
  and neither is live (the new blocks' document is built by BlockNote with the server schema, so the
  read has nothing unknown to remove). Byte-identical results (ADR 2550's differential run).
- An agent's replace of a body with more than 2,000 blocks or more than 256 KiB of Markdown reports no
  line counts in its AI step (as a page over 2,000 blocks already did): counting meant exporting the
  whole body again and keeping that DOM.

## Not done
- **Patching BlockNote or jsdom** to drop the cached references: a dependency change (the pinned editor
  patch), out of scope for a patch release. The export-side holder is still there for every caller that
  exports a large page (read_page of a large page, exports, vault sync reads).
- **A dry run on the changed region only**: the dry run copies the whole range it edits (for a document
  replace, the whole document) and inserts the new clones into it, so a full rewrite holds about four
  documents' worth at once. Copying only the containers the plan touches needs the alignment planned
  before the copy; a larger restructuring of `replaceRange`.
- **Moving the work out of the write gate's transaction**: the edit runs inside `underWriteGate`'s
  transaction. With the budget the synchronous part of a 990K replace is about 1–2 s, far below the
  60 s idle-in-transaction timeout; running the dry run before the gate would need a "document
  unchanged since" check and a second path.

## Consequences
See the table in the 0.22.2 report (`w22-reports/replace-fix/`): with a 512 MB heap every case of the
reproduction now answers 200 and the server stays up, but with 990K of ordinary Markdown rewritten six
times the RSS still peaks at ~840–870 MB, above a 768 MB container limit (macOS measurement, not a
container). The likely reason, estimated and not proven: the live set of such a replace is ~300 MB of
heap (the table above), V8 lets the heap grow towards its limit, and the process carries ~140 MB outside
the heap at rest. With a 320 MB heap, six rewrites of 800K of ordinary Markdown survive and 900K dies at
the third to sixth rewrite (the document grows with every rewrite, so survival depends on how many).

## References
- apps/server/src/md/convert.ts (`releaseParseDom`), apps/server/src/pageContentWrite.ts (line counts)
- apps/server/src/context/sectionPatch.ts (`buildIncoming`, `validate`)
- ADR 0940, 1042, 1500, 2540, 2550
