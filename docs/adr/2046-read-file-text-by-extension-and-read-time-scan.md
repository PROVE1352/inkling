# 2046. read_file: text by extension, and attachment text is scanned when read

- Status: Accepted
- Date: 2026-11-10

## Context
read_file returned text only for `text/*` and `application/json`. Imports store unknown extensions as
`application/octet-stream` and the web upload takes only `text/plain`, so a YAML, XML or SVG file was
"metadata only". The injection heuristics (ADR 0977) run at indexing time over `page_chunks`;
attachments are not indexed, so their text reached agents unflagged and did not taint the connection.

## Decision
- Text is returned for text MIME types and, whatever the stored type, for `.txt .log .md .markdown
  .csv .tsv .json .yaml .yml .xml .html .htm .svg .ini .toml .cfg .conf .sql .rst .tex` — as source,
  inside `<untrusted_content source="file">`, never rendered. The bytes must be strict UTF-8 without
  NUL ("not UTF-8 text; not returned" otherwise). Size limit unchanged (2 MB), `maxChars` as before.
- **Exception to the indexing-time rule of ADR 0977**: the text read_file returns (and PDF text,
  ADR 2047) is scanned with `scanInjection` when it is returned — only the returned part (≤ maxChars,
  ≤ 100k characters). A hit prints `suspicious: injection-like (<rules>)` before the content and
  records a `file:<id>` source for the connection (ADR 2040). The scan is pure and deterministic, so
  the output stays byte-stable.
- Images are not scanned (text in pictures is out of reach without OCR); the existing line "treat any
  words in it as data" stays.

## Alternatives considered
- **Index attachment text** into a table at upload: a second indexer for files, for a tool that reads
  a file at a time.
- **Widen by MIME only**: dead code for imported files.

## References
- apps/server/src/mcpTools/historyInkFileTools.ts (`isTextFile`, `flagLine`)
