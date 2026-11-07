# 0753. Revision-keyed render cache for public share pages

- Status: Accepted
- Date: 2026-11-07

## Context
Every `GET /api/public/:token` decoded the Yjs state and rendered full HTML; every image on a public page (`/public/:token/f/:fileId`) decoded the whole document again to check that the file is referenced by the page. A shared page with 20 images cost 21 full decodes per view.

## Decision
- `lru.ts`: a bounded LRU with TTL and byte budget.
- HTML cache: 200 entries / 32 MB / 10 min; allowed-file-id cache: 500 entries / 8 MB / 10 min.
- Keys: page id + `pages.updated_at` (bumped by every document store) + token (+ ref and a fingerprint of the folder subtree membership for folder shares, because link rewriting depends on it). Cover/icon are part of the file-id key.
- The cache is consulted only after the token/scope gate, so un-sharing or making a page private takes effect immediately.
- Collections are not cached (their table depends on child rows whose edits do not bump the parent).

## Measurements
30 sequential views of a 93 KB-state page: p50 17.0 ms → 0.9–2.1 ms, peak RSS delta +88 MB → +5 MB.

## Trade-offs
Up to ~40 MB of cached HTML/id sets in the worst case; entries for edited pages age out by TTL/LRU rather than being deleted.
