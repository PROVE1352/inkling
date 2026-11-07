# 0751. Large bodies: stream to disk, copy inside Postgres, spill exports

- Status: Accepted
- Date: 2026-11-07

## Context
Several paths materialised whole payloads in the Node heap: uploads (`toBuffer`, 25 MB), folder import (every part buffered, re-zipped with JSZip, the zip buffered and parsed again — 3–4x the folder size), page duplication / template instantiation (every Yjs state and search text of the subtree loaded into a Map), and the zip export (all rendered markdown kept in JSZip until the stream started; one open fd per asset).

## Decision
- **Uploads** stream to `uploads/.upload-<uuid>` through a byte-counting transform (`streamToFile`, budget = 25 MB) and are renamed to the file id after the row insert. MIME is checked before any byte is written.
- **Folder import** streams each part into a private temp dir (`DATA_DIR/tmp/import-<uuid>`, disk name = index, the client path never touches the filesystem) and feeds `importEntries` lazily; assets are `rename`d into `uploads/` (zero copy). Parent directory entries are synthesised to keep the JSZip-era behaviour (explicit directories → folder pages). The temp dir is removed in `finally`; `DATA_DIR/tmp` and stray `.upload-*` files are cleared at boot.
- **Duplicate / instantiate** copy `page_docs`, `page_texts`, `page_tags` with `INSERT … SELECT … FROM unnest(old_ids, new_ids)`; only template pages whose text contains `{{` are decoded in Node for variable substitution.
- **Zip export** writes each rendered entry to a temp file and hands JSZip a lazy stream that opens the file only when JSZip reads it; assets use the same lazy stream (one open fd at a time). All guards still run before the response starts. The page-count guard now counts the exported subtree (it counted the whole workspace, so a small folder in a >5,000-page workspace was refused with 413).

## Measurements (peak RSS delta of the server process, fresh process per operation, same seed, original vs new code)

| operation | before | after |
|---|---|---|
| upload 24 MB | +31 MB | +1–7 MB |
| folder import, 2×20 MB assets + 8 md | +114 MB, 782 ms | +32–37 MB, 351–695 ms |
| duplicate 99 docs (9.2 MB of Yjs state) | +286 MB, 296 ms | +5–6 MB, 87–135 ms |
| zip export of the same 99 docs (2.9 MB zip) | +49 MB | +43–58 MB (no measurable change) |

The export spill shows **no measured memory win at the tested scale** (99 pages; at 990 pages both versions were dominated by conversion garbage, +200 MB vs +75 MB in one run each, too noisy to claim). It is kept on design grounds: memory is bounded by one page's markdown instead of the whole tree, and assets/entries hold one fd at a time instead of one per entry.

Found while measuring: an export of ~1,000 documents never reached the client. Rendering happens before the first byte (guards first), and the server's 30 s idle socket timeout (`connectionTimeout`) destroyed the connection mid-render in both versions. Zip export routes now give their socket a 10-minute idle window. The render itself is BlockNote's `blocksToMarkdownLossy` in JSDOM: ~20 ms for a typical 300-block page, but 817 ms for a page holding one 112 KB paragraph (JSDOM NodeList updates) — a truly progressive zip writer that starts streaming during the walk is the follow-up if large exports matter. No content hash is computed for uploads: nothing consumes it and `/files/:id` is already immutable by id (ETag = id).

## Trade-offs
- Folder import and export need free disk space in `DATA_DIR` roughly equal to the payload.
- An interrupted import/export leaves temp files until the request's `finally` or the next boot.
