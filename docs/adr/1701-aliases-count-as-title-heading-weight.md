# 1701. find_context: page aliases count as the title; heading weight 0.2 → 0.3

- Status: Accepted (amends the weights of 1210)
- Date: 2026-11-10

## Context
A page can carry wiki-link aliases (`pages.aliases`, set from `aliases:` in front matter), and members
use them as the page's name ("PayFix" for the TF page). find_context read only `pages.title`: the query
"PayFix" returned nothing although `[[PayFix]]` links to the page. Separately, ADR 1210 made common
words weigh little through idf; the remaining question for 0.14 was whether a section whose title or
heading names the query should count more against sections that only repeat common words.

## Decision
- **Aliases are part of the title.** In SQL, the title probe (`titleCond`, which brings in the first six
  chunks of a page whose title matches), the title-only page list and the per-candidate title flag test
  `p.title` and, only when the array is not empty, `p.aliases::text` (jsonb text keeps non-ASCII as
  it is; brackets and quotes are word separators for the `simple` parser). In Node, `Candidate.aliases`
  (newline-joined) is appended to the title for the title share and for tf. No index: the title probe
  already reads the workspace's pages row by row.
- **Heading weight 0.2 → 0.3** (`WEIGHTS.heading`), chosen on the dev questions only
  (`context-tune.ts`, ADR 1213): unpadded dev recall@5 0.964 → 0.991, MRR unchanged on the large set.
  0.35 started to lose ("서울 AI 해커톤 팀 구성" rank 3 → 4), 0.4 lost dev MRR 0.901 → 0.872. The weights
  no longer sum to 1 before bonuses; scores are compared with each other and with the relative floor
  only.
- Title weight stays 0.15 (0.2 and 0.25: no dev change).

## Alternatives considered (dev, padded + 5,000 distractors)
- **Flatter idf for the title/heading shares** (idf^0.5, idf^0): dev MRR 0.901 → 0.887 both; "feature
  flag rollout percentages" fell to rank 2. A common word in a heading would count more, which is what the
  field report asked for, but on dev it promoted pages whose title repeats a common word. Not taken.
- **Aliases as their own field with their own weight**: no evaluation question separates an alias from a
  title; one field keeps the score explainable.
- **An expression or trigram index on aliases**: aliases are rare and short; the cost is the jsonb-to-text
  cast, skipped for empty arrays.

## Consequences
- An alias-only query ("PayFix") now finds the page (db test "Korean partial match …").
- Ranking still uses idf for title and heading shares; a common word that names a page counts little.

## References
- apps/server/src/context/retrieve.ts (`inTitle`, `titleCond`, `titleMatch`, `aliasText`)
- apps/server/src/context/rank.ts (`Candidate.aliases`, `WEIGHTS.heading`, `scoreParts`)
- docs/adr/1210-*, 1213-*, 1702-*
