# 2593. The sidebar's account block folds, remembered in this browser

- Status: Accepted
- Date: 2026-11-27

## Context
The account block at the bottom of the sidebar (name, email, copy invite link, sign out) takes several rows that a
person rarely uses, on every screen. On a laptop that leaves less room for the page tree.

## Decision
- The name row is a button with an arrow (`aria-expanded`) that folds and unfolds the block. Folded, only the name
  row shows; unfolded, the block is as before. It starts unfolded.
- The choice is kept per person in this browser: localStorage `inkling:sidebar-account:<userId>`, the same way the
  sidebar sections remember their folding (`inkling:section:<wsId>`), with the same arrow. No server column.
- The operator's legal links (terms, contact) stay visible when the block is folded. The compact footer of a short
  sidebar (one row of icons) is unchanged.

## Alternatives
- Store it in `users.sidebar_prefs` (docs/adr/1020-*) so it follows the account. Screen heights differ per device,
  so a per-device choice fits better, and that column would change meaning: it holds the list of sidebar menus.

## Consequences
- A person who folds the block on a laptop still sees it unfolded on another device or in a private window.
