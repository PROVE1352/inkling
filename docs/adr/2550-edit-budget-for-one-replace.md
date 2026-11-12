# 2550. One replace has an edit budget; past it a changed block's content is swapped whole

- Status: Accepted (amends 0940, 1500)
- Date: 2026-11-12

## Context
`update_page(replace)` and `patch_section(replace)` are minimal edits (ADR 0940, 1500): old and new
blocks are aligned, changed blocks of the same type are paired, and each pair gets a character-level
Myers diff applied as Yjs insert/delete/format calls. The only cap was per pair (`INLINE_MAX_D` 4,000,
4M steps). Rewriting a large body with different text paired every old paragraph with a new one, so a
1 MB body of random words produced hundreds of edits in each of ~1,900 paragraphs, twice (dry run on a
copy, then the live document). Each Yjs text operation can split an item, and a split inserts into the
writing client's struct array (`findIndexCleanStart` → `splice`), so the cost was operations × structs:
78 s of CPU with 60 s in `findIndexCleanStart`, the document cut into hundreds of thousands of items,
the heap out of memory at 512 MB on the second request, and the event loop blocked long enough for the
gate's open transaction to hit `idle_in_transaction_session_timeout`. Present since 0.21.1.

Measured at 1e1d0cb (`replaceLarge.test.ts`, pure): two replaces of 300K random words leave 241k structs
where the same body built fresh has 5k; six 100K replaces add ~31k structs each.

## Decision
- **Budget per replace** (`context/sectionPatch.ts`, `REPLACE_BUDGET`): 2,000 Yjs text operations and
  40M diff steps (characters tokenized + Myers steps). A pair is planned first (`planInline`, nothing
  written); when its operations do not fit in what is left, or nothing is left, or the pair holds more
  than 200,000 characters, the block keeps its container and id but its content node is replaced by the
  new one (`swapContent`), carrying block colors, alignment and the toggle node as a retype does.
- **Only large ranges have a budget**: when the old and new blocks of the range hold at most 128 KiB
  of characters together (`BUDGET_FREE_CHARS`), the edit runs without one, exactly as before. Measured
  with the budget on every range, a whole rewrite of a 5K body of random words already swapped 3 of 11
  paragraphs (it takes ~2,500 operations), and touching 15% of the words in every paragraph of a 50K
  body swapped 15 of 104; with the gate none of these is swapped. The cost the budget bounds is
  operations × structs, which only a large range makes large. The gate is decided once from the blocks,
  so the dry run, the live edit and a batch's copy run agree.
- **A block whose characters and Markdown marks did not change is never swapped**: before any diff,
  the two content nodes are compared as one key (text runs with their Markdown marks, known inline
  nodes; `inlineKey`), and equal keys skip the diff, which would have found no edit anyway. This matters
  on pages over 2,000 blocks, where the route computes no echo and every block is paired.
- **Counted, not timed**, and fresh for every run of the edit, so the dry run on the copy and the live
  edit take the same path. `patch_sections` and a revert batch share one budget across their edits
  (`newReplaceBudget`, made once per run over the batch).
- **Values from the test suites, not from page sizes**: every replace in the unit and database suites
  was recorded (one temporary counter, both suites): at most **23** text operations (sectionLinks.db),
  **4.0M** diff steps (mcpFixes013.db: one pair at the per-pair Myers cap), **16,498** characters in one
  pair. The budget is 87×, 10× (ten pairs at the per-pair cap) and 12× those. A small edit of a large
  page with more than 2,000 blocks (no echo, every block paired) diffs only the changed blocks
  (`replaceBudget.test.ts`: 300K page, three words changed, 3 operations, nothing swapped). A large
  range that rewrites much more than that (an agent translating or reformatting a whole long page) does
  reach the budget, and its later changed blocks are swapped.
- **Ceiling**: on the 990K random-words body a replace now takes ~1.1 s for both runs together
  (pure), the server answers in ~2 s and its event loop stalls ~1 s (was: out of memory).
- Also in the same path: deletions of many blocks take one `toArray` (was one per deleted block,
  quadratic on a whole-page rewrite).

## What a swapped block loses (pinned in `replaceBudget.test.ts`)
- Kept: the block id, so comment threads (anchored by block id) and block links stay; block colors,
  alignment, toggles; the result reads back as the sent Markdown.
- Lost, as for a table edit: characters a person typed into that block concurrently (their items'
  parent is deleted), marks Markdown cannot express (underline, text colors), and inline nodes the
  Markdown did not carry (a mention chip survives only if the agent sent it back in the notation).
- Blocks edited before the budget ran out keep all of that, as before. Which blocks are swapped is
  deterministic: changed blocks in document order, once the budget is spent.

## Alternatives considered
- **Word similarity gate for same-type pairs** (`similarity`, 0.5, as `pairRetypes` does): turns
  rewritten paragraphs into delete + insert. Rejected as the main fix: it changes small edits too (a
  rewritten paragraph loses its id and concurrent typing at any size) and does not bound the work of
  similar-but-different paragraphs.
- **Delete + insert past the budget** instead of a content swap: new block ids, so comments become
  orphans. The swap costs the same and keeps ids.
- **Dropping the dry run** for large edits: it is what makes a bug unable to leave half a patch behind
  (ADR 0940); with the budget its cost is bounded.
- **Timing the edit**: not deterministic; the dry run and the live run could diverge.

## Consequences
- Ranges up to 128 KiB and edits within the budget are byte-identical to before: a differential run of
  the 1e1d0cb module against the new one on 400 seeded pages up to 50K (random edits, whole-body
  rewrites and every-paragraph edits; document and section replaces, with and without echo, fixed
  client id) gave identical encoded documents and stats in 400/400.
- Below the gate nothing changed, including the old cost: repeatedly rewriting a page of up to ~60K
  with entirely different text still adds tens of thousands of structs per rewrite (pre-existing).
- Every rewrite still leaves tombstones (a deleted item stays where a live block points at it):
  about one struct per swapped block plus about two per text operation, so a page rewritten many
  times still grows, linearly and by at most about its own size per rewrite.
- `lastReplaceWork()` and `setReplaceBudgetForTests()` are exported for tests and benches.

## References
- apps/server/src/context/sectionPatch.ts (`REPLACE_BUDGET`, `planInline`, `swapContent`, `deleteChildren`)
- apps/server/src/context/sectionBatch.ts (shared budget)
- apps/server/src/context/replaceLarge.test.ts, replaceBudget.test.ts
- ADR 0940, 1500, 2551
