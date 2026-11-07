# 0933. Change feed diff: Myers line diff with sentence units and hard caps

- Status: Accepted
- Date: 2026-11-07

## Context
`changes_since` (docs/adr/0932-*) shows a modified section as a minimal -/+ diff between its
state at the agent's cursor and now. The output is read by a language model inside a token
budget, so what matters is (1) few output tokens for small edits, (2) correctness — every
changed line shows, nothing unchanged shows as changed, (3) bounded CPU per call, since the
inputs are user documents of any shape. Section texts are light Markdown (chunker.ts), one line
per block; a paragraph is one line, often hundreds of characters long. No new dependency may be
added.

## Decision
- **Units** (apps/server/src/context/diff.ts:35): lines; a line longer than 160 ASCII-equivalent
  characters (estimated tokens × 4: ~160 Latin characters or ~40 Hangul) is split into sentences
  at `. ! ? 。 ！ ？` followed by whitespace (:32). One edited sentence in a long paragraph is one
  -/+ pair instead of the paragraph twice.
- **Algorithm**: common prefix and suffix are trimmed (linear), then Myers' greedy O((N+M)·D)
  shortest edit script on the middle (:65), keeping one copy of the frontier per step
  (memory O(D²)) for the backtrack. The script is minimal (fuzz-tested against the O(N·M) LCS
  dynamic program in the test suite).
- **Caps** (`DIFF_LIMITS`, :17), any exceeded → `large`, printed as "large change, read section":
  - `maxUnits` 3,000 per side after trimming: a stored side is ≤ 16 KB (docs/adr/0932-*), i.e.
    at most a few thousand short lines, so the cap only bites on degenerate input.
  - `maxD` 400: time ≤ (N+M)·D ≈ 6,000 × 400 = 2.4 M comparisons (a few ms), memory ≈ D² Int32
    ≈ 640 KB. A diff of more than 400 changed units is ≥ 4,000 output tokens at ~10 tokens per
    unit — more than the default feed budget (3,000), so pointing the agent at the section is
    better than printing it.
  - `maxWork` 4 M steps per diff (frontier steps + snake comparisons, counted at :83), plus a
    shared 40 M for all diffs of one feed call (changeFeed.ts:41); after that, remaining modified
    entries print "large change". A counter instead of a wall clock keeps the output a pure
    function of the input: the feed must be byte-identical for the same state (prompt caching,
    docs/adr/0932-*), which a timeout under load would break.
- **Format** (:160): hunks of `- ` lines then `+ ` lines, each preceded by at most one context
  line (the unchanged unit right before the hunk, skipped when blank, cut at 80 characters);
  `…` marks skipped unchanged units between hunks. Two hunks one unit apart share it as context
  without `…`.
- **Accuracy table**: 17 scenarios with exact expected output (identical, single change,
  append, prepend, deletes, empty ↔ text, distant and adjacent hunks, blank context, block
  replace, moved line, long English and Korean paragraphs, list items, long context) — 17/17.

## Alternatives considered
- **O(N·M) LCS dynamic programming**: simplest to write, but 3,000 × 3,000 cells is 9 M per
  diff in time and memory; rejected for unbounded input.
- **Hunt–Szymanski** (O((r + N) log N), r = matching pairs): fast when few lines match, but
  degenerates on documents with many repeated lines (blank lines, `---`, list markers), which
  notes have.
- **Patience / histogram diff** (git options): better-looking hunks for code moved around
  unique lines, but they still fall back to Myers for non-unique regions and need the unique-line
  index; for prose sections the Myers output is already minimal and the moved-line case is rare.
- **Word- or character-level diff**: precise but noisy for a model ("-the +a" tokens without
  structure), and many more units per section (D caps hit sooner). Sentence units keep the
  output readable and still small.
- **No diff, just the new text**: simplest, but a one-word fix in a 2 KB section would cost the
  whole section every time.

## Trade-offs
- Sentence splitting is a regex; abbreviations ("e.g. ") split a sentence early. Only the
  granularity changes, never correctness: both sides are split the same way.
- Very large rewrites print "large change" rather than a partial diff; the agent then reads the
  section (read_page(section=…)).
- The work caps bound CPU only indirectly (a step is a string comparison, so very long units
  cost more per step); units are lines or sentences of a ≤ 16 KB text, so a capped diff stays in
  the low milliseconds. Typical sections diff in well under 1 ms.

## How others solve it
- GNU diff and git default: Myers O(ND) with a cost heuristic (GNU `TOO_EXPENSIVE`) that gives
  up minimality on huge inputs — our `maxD` fallback is the same idea, stated to the reader.
- google/diff-match-patch: Myers with a wall-clock `Diff_Timeout` (1 s default) and a line-mode
  pre-pass — the same shape as our caps and line units, but a clock makes the result depend on
  load; we count work instead.
- git `--patience` / `--histogram`: anchor on unique lines first, then Myers in between.

## Consequences
- Unit tests: scenario table, minimality fuzz, caps (apps/server/src/context/changeFeed.test.ts).
- No dependency added; the module is pure and reusable (e.g. for history views).

## References
- apps/server/src/context/diff.ts:17 (caps), :32 (sentence split), :35 (units), :65 (Myers), :83 (work counter), :132 (trim + caps), :160 (hunks)
- apps/server/src/context/changeFeed.ts:41 (per-call diff work), :390 (`unitBody`)
- E. W. Myers, "An O(ND) Difference Algorithm and Its Variations", Algorithmica 1(2), 1986
- J. W. Hunt, T. G. Szymanski, "A fast algorithm for computing longest common subsequences", CACM 20(5), 1977
