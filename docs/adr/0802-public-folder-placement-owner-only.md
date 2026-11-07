# 0802. Publishing into a public folder is owner-only

- Status: Accepted
- Date: 2026-11-07
- Audit: C-M5

## Context
A public folder link exposes its subtree as computed at request time. Only owners may create public links, but any member could move a page under a shared folder (or create one there) and publish it.

## Decision
Inside the tree lock, `assertPlacement` looks for ancestors with a share token (shared scope). For a non-owner the placement is refused (403, reason in the message) unless every such ancestor already exposed the moved page (moves within the same public folder). Exception: a new row of a collection (direct parent is a collection) — treated as an edit of that collection's content, like typing into a public page. Copies placed next to their original (duplicate, expand-canvas) expose nothing new and skip the rule.

## Consequences
Members can still edit text of public pages and add database rows; publishing new pages into a public folder needs an owner.
