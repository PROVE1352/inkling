# 0977. Injection-like content signals and a taint record (signal, never a block)

- Status: Accepted
- Date: 2026-11-07

## Context
Wrapping content as data (ADR 0976) does not tell an agent or a person that a particular section
looks like an attempt to steer agents. A cheap, deterministic signal helps people review such
pages and helps agents treat them with extra care; it must not block writes or reads, because it
is easy to evade and will misfire on pages that discuss prompt injection.

## Decision
- `scanInjection(text)` returns rule ids in a fixed order:
  `hidden-chars` (bidi, tag and zero-width characters), `override-phrase` (a constant list of
  English and Korean phrases, matched after NFKC, lower-casing, removing invisibles and collapsing
  spaces: ignore/disregard previous instructions, reveal the system prompt, you are now a … AI,
  이전 지시 무시, 시스템 프롬프트 출력, 너는 이제 …), `tool-directive` (a sentence that addresses
  an agent, names an Inkling tool and uses an imperative), `permission-change` (addresses an agent
  and asks to grant/remove a role, lock or access), `encoded-blob` (base64 ≥ 200 or hex ≥ 128
  characters), `exfil-url` (a URL whose query takes a placeholder, or a sentence telling to append
  data to a URL), `image-exfil` (a Markdown image whose URL query takes a placeholder).
- Computed **once per section at indexing time** into `page_chunks.suspicious text[]` (chunk hash
  includes it; CHUNKER_VERSION 2 makes the boot backfill re-scan existing pages). Reads never
  recompute.
- Shown as `suspicious: injection-like (<rules>)`: per fragment in find_context, per section in
  read_page outline/section, and a `- suspicious: … in §a, §b` line in read_page / read_pages.
  The web app shows a small warning badge (`GET /pages/:id/suspicious`). Instruction pages are
  scanned too and only warned about.
- The first detection per (page, rule) is written to the audit log (`content.suspicious`, no
  actor, `after: {rule, sections}`); later detections of the same rule are not repeated.
- **Taint record (hook only):** when an MCP read hands flagged content to a connection,
  `oauth_grants.tainted_at` is set (at most once a minute). Nothing reads it yet; write behaviour is
  unchanged. A follow-up can lower a tainted session's writes to proposals (CaMeL-style flow
  control); this column is where that decision will read from.

## Alternatives considered
- An LLM classifier: non-deterministic, costs a model call per save, and its output would break
  byte-stable tool output.
- Blocking or quarantining flagged pages: false positives on legitimate security notes, and an
  attacker paraphrases around the list.
- Scanning at read time: repeated work on every call; violates the indexing-time rule.

## Trade-offs
- Evadable by paraphrase, other languages, splitting across sections, images, or text the chunker
  does not index (e.g. image URLs are only seen when they are in indexed text).
- Some false positives on pages about agents and security; tests list the expected clean cases.
- The audit dedupe is best effort (two concurrent reindexes can both record a rule once).

## How others solve it
- Debenedetti et al. 2025, "Defeating Prompt Injections by Design" (CaMeL): separate the
  control flow from untrusted data and track capabilities; detection alone is insufficient.
  https://arxiv.org/abs/2503.18813
- Simon Willison, "The lethal trifecta for AI agents" (private data + untrusted content +
  external communication): remove one leg rather than rely on filters.
  https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Microsoft Prompt Shields / Lakera Guard: classifier-based detection used as a signal.

## Consequences
- Columns `page_chunks.suspicious`, `oauth_grants.tainted_at` (migration 0030).
- Audit action `content.suspicious`; shared `INJECTION_RULES` and `SuspiciousSectionsDTO`.

## References
- apps/server/src/context/injectionScan.ts:24, :73
- apps/server/src/context/chunker.ts:318, apps/server/src/context/chunkIndex.ts:186, :264
- apps/server/src/routes/editLock.ts:79
- apps/server/src/mcpTools/trust.test.ts:66
