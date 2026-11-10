# 2043. The workspace switch for suggest-only is on by default

- Status: Accepted
- Date: 2026-11-10

## Context
The heuristics misfire (ADR 0977): pages about prompt injection, long base64 or hex blobs, URLs
with placeholders. A team whose security notes keep firing must not have its agents blocked every
hour. Should the rule be opt-in like the edit policy (ADR 1544, default "direct") or opt-out?

## Decision
- `workspaces.agent_taint_demote`, **on by default**, switched by owners and admins in the web app
  (Workspace settings › Connected agents › Suspicious content; `PUT /api/workspaces/:id/settings/agent-taint`,
  browser only, audited as `settings.updated`). It is read for the workspace the write goes to.
- Off: connections write there as before even while suggest-only elsewhere; taints are still recorded
  (the audit and other workspaces keep working).

## Alternatives considered
- **Off by default** like the edit policy: the edit policy is a workflow choice; this is a security
  default whose false positive costs a click (a release) or a wait, while a false negative is an
  unreviewed write by a hijacked agent. Existing workspaces get it on with the upgrade; the changelog
  says so.
- **Per-page exemptions** ("this page is about injections"): the fingerprint memory of a release
  (ADR 2042) already makes a reviewed page stop firing until it changes.

## References
- apps/server/src/routes/agentTaint.ts, apps/web/src/pages/WorkspaceSettings.tsx
