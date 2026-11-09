# 1514. read_file: images as images, text as untrusted text, everything else as metadata

- Status: Accepted
- Date: 2026-11-09

## Context
read_page shows image and file blocks as `/files/<id>` links. Agents could not open them. Uploads
allow PNG, JPEG, GIF, WebP, AVIF, PDF, MP4/WebM video, MPEG/MP4/WAV audio and text/plain (no
text/markdown, CSV or JSON types are accepted, so such files arrive as text/plain or not at all).

## Decision
- `read_file(file, maxChars?)`: `file` is the id or any link containing `/files/<id>`.
- New route `GET /api/files/:id/meta` with exactly the download's checks (workspace member or guest,
  the file's page visible now, guests only files of pages shared with them) plus one more: a
  connection limited to a subtree gets `OUT_OF_RANGE` for legacy files without a page, which
  belong to the whole workspace. The tool decides from the metadata before fetching bytes through
  `GET /files/:id`.
- PNG, JPEG, WebP, GIF up to 3 MB: MCP image content, after a magic-byte check (a file whose bytes
  are not the declared type is not returned). Over 3 MB: metadata and "too large"; the server
  cannot shrink images without a dependency (0882).
- text/* (and application/json): up to 2 MB, UTF-8, `maxChars` (default 20,000), wrapped as
  untrusted content (0976); bytes with NUL are treated as binary.
- PDF and everything else (AVIF, audio, video): metadata only. PDF text needs a parser; writing one
  for compressed, font-encoded streams is out of proportion, and the answer says so.

## Alternatives considered
- **Base64 any file as an embedded resource**: clients and models cannot use most of it; large.
- **Fetch first, decide later**: reads up to 25 MB to refuse it.
- **PDF text via a dependency (pdf.js)**: against 0882 for now; listed in KNOWN-ISSUES.

## Consequences
- Public links (1302) are not involved: read_file only uses the signed-in path, so the public-file
  scope rule does not widen or narrow anything here.
- The download route itself still serves pageless legacy files to subtree-limited tokens (existing
  KNOWN-ISSUES entry); the new metadata route refuses them, so read_file does not reach them.
- Tests: `apps/server/src/mcpTools/agentTools012.db.test.ts` (image, link forms, text with
  truncation and untrusted wrapper, PDF metadata, over-size image, wrong magic bytes, private page,
  subtree range) and `apps/server/src/guests.db.test.ts` (guest metadata access).
