# 2045. Uploads through a connection: 5 MB, typed by the server, a daily budget

- Status: Accepted (limits and budget amended by [2065](2065-agent-uploads-switch-and-limits.md))
- Date: 2026-11-10

## Context
The web upload takes up to 25 MB and trusts the browser's Content-Type against an allow list (only
`text/plain` among text types). An agent's upload arrives as base64 inside a JSON-RPC body that the
MCP route caps at 12 MB (ADR 1526); base64 adds a third. There is no storage quota anywhere in
Inkling today.

## Decision
- **5 MB per file through a connection** (`AGENT_UPLOAD_MAX_BYTES`): 5 MB of bytes is ~6.7 MB of
  base64, which leaves room under the 12 MB body for JSON and other arguments, and keeps the tool's
  peak memory (string, buffer, multipart copy) around 20 MB per call. The tool measures before
  decoding and answers "the file is N MB; upload_file takes at most 5.0 MB (the MCP request is capped
  at 12 MB and base64 adds a third)". A body over 12 MB is refused by the HTTP layer before the tool
  runs (its message is Fastify's).
- **Typed by the server**: the extension says what the file claims; the bytes must agree — PNG, JPEG,
  GIF, WebP and PDF by magic numbers; `.txt .log .tsv` (text/plain), `.csv` (text/csv), `.md .markdown`
  (text/markdown), `.json` (application/json) as strict UTF-8 without NUL. SVG, HTML, scripts,
  archives, executables and audio/video are refused through connections (SVG is scriptable; agents
  can draw diagrams as PNG or as Mermaid text in the page). The client's Content-Type is ignored.
- `text/csv`, `text/markdown`, `application/json` join the web allow list too; like every non-raster
  type they download as attachments with `nosniff` and a sandbox CSP.
- **Daily budget**: uploads through connections stop (429 `UPLOAD_BUDGET`) once the account added
  200 MB of files in the last 24 hours (all its uploads count). Not a quota — a brake on a looping
  agent filling the disk.

## Alternatives considered
- **25 MB like the web**: does not fit the MCP body with base64.
- **A per-connection counter in memory**: lost on restart; the `files` table already has the numbers.
- **Accept SVG and serve it as an attachment**: browsers render SVG in an `<img>` without scripts,
  but a direct visit is a document; the web upload refuses it for the same reason.

## References
- apps/server/src/uploadCheck.ts, apps/server/src/routes/files.ts, apps/server/src/uploadCheck.test.ts
