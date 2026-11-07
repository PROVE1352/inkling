# 0810. Import limits and real-byte zip metering

- Status: Accepted
- Date: 2026-11-07
- Audit: C-H2b, C-M6, C-L11 (attachments)

## Decision
Folder depth ≤ 32, created pages ≤ `IMPORT_MAX_PAGES` (default 5000), checked before any page is created; creation runs in one transaction under the tree lock with the placement check (depth cap includes the parent's depth). Zip entries are decompressed through `nodeStream` while counting real bytes: 25 MB per entry, 50 MB per import — the header `uncompressedSize` is only a first filter. Imported attachments get the `pageId` of the first page that references them (or the first created page), so the file gate applies that page's visibility.
