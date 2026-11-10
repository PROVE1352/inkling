# 2204. One status for unsent edits: on this device, or only in this tab

- Status: Accepted
- Date: 2026-11-10

## Context
0.15.1 (ADR 1926) added "Not saved yet" and a `beforeunload` guard for edits the server has not
acknowledged, which then existed only in the tab. With device copies (ADR 2200) most such edits
also survive a reload, and the guard asking anyway would be noise; when storage fails they do not.

## Decision
- The tracker (`lib/unsavedEdits.ts`) gets a `durable` flag per document, fed by the device copy
  (all local edits written, no failed write). `anyUnsaved()` still drives the indicator;
  `anyAtRisk()` (unsaved and not durable) drives the leave guard.
- The page's status dot says "Not uploaded yet — saved on this device, uploaded when the connection
  is back" for durable edits and keeps "Not saved yet — keep this tab open" for the rest.
- Edits loaded from the device at open count as unsent from the start (their provider is told).
- When a provider gets back to 0 unsynced changes after an outage or with edits loaded from the
  device, a toast says "Offline edits uploaded".
- A banner above the page says when the app runs offline or from kept data, how many pages wait to be
  uploaded, when storage failed, and links to recovery items (ADR 2201).
- A document the gate did not let merge shows why above the editor.

## Alternatives considered
- **A second indicator for "offline"**: the dot already says Disconnected; the banner covers the app.

## References
- apps/web/src/lib/unsavedEdits.ts, collabSocket.ts, apps/web/src/pages/PageView.tsx (StatusDot),
  apps/web/src/lib/offline/OfflineBanner.tsx
