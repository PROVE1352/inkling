# 0304. iCal feed format: all-day VEVENTs, date-independent UIDs, octet folding

- Status: Accepted
- Date: 2026-11-07

## Context
The feed must be valid RFC 5545 for strict parsers (Outlook, Apple) and stable across polls so
clients update events instead of duplicating them.

## Decision
- Each dated item is an all-day `VEVENT` (`DTSTART;VALUE=DATE`, `DTEND` = next day, `TRANSP:TRANSPARENT`).
  Done items get a "✓ " prefix in `SUMMARY` (VEVENT has no completed status).
- `UID = <kind>-<pageId>[-<fieldId|blockId>]@<host>` — independent of the date, so moving a due date
  updates the same event; a row with two date properties yields two events.
- TEXT values escape `\ ; , newline`; lines are CRLF and folded at 75 **octets** on code-point
  boundaries (Korean titles are 3 bytes/char; a naive char-count fold corrupts UTF-8).
- `DTSTAMP` is the start of the current UTC day so the body — and its ETag — only changes when content
  changes (at most once a day otherwise).
- Window: 90 days back, 400 days ahead.

## Alternatives considered
- **VTODO for tasks**: most subscription clients (Google) ignore VTODO.
- **Timestamped DTSTAMP (now)**: valid but defeats ETag/304.

## Trade-offs
No times of day (the app stores dates only).

## How others solve it
GitHub/Todoist feeds use all-day events and stable UIDs in the same way.

## Consequences
Smoke: max line 75 octets, CRLF only, 304 on matching `If-None-Match`.

## References
- apps/server/src/routes/ical.ts:38 (`icsEscape`), :50 (`icsFold`), :96 (`icsUid`), :231 (DTSTAMP)
