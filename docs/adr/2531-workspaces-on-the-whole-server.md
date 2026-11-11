# 2531. A ceiling on the workspaces of the whole server

- Status: Accepted
- Date: 2026-11-12

## Context
The 0.22 security review (F1, reproduction R8): when an account deletes itself, a shared workspace it owned
alone passes to its oldest admin or member without looking at `LIMIT_WORKSPACES_PER_USER` (the operator's
rule: a shared workspace stays until everyone has left), and its sign-up slot under `SIGNUP_MAX_USERS` comes
free. One keeper account collected two workspaces per throwaway sign-up, without end (9 after 4 rounds),
each with its own storage limit.

Refusing the handover would break the operator's rule (or delete a workspace other people use), so the
handover keeps ignoring the per-person limit.

## Decision
- `LIMIT_WORKSPACES_TOTAL` bounds every `workspaces` row on the server, deleted-but-restorable ones
  included (`quota/room.ts assertWorkspacesTotalRoom`), checked under one server-wide advisory lock
  (`ws-total`), taken after the person's `user-ws:` lock and before the sign-up cap lock, so the order is
  the same on every path.
- Where a workspace is born: `POST /workspaces` (403 `LIMIT_WORKSPACES_TOTAL` with `{ limit, used }`); sign-up,
  which makes a personal workspace (a sign-up hook from `quota/register.ts`: a quick count before anything
  is written, the locked count inside the sign-up transaction; 403 `SIGNUP_FULL`); a new OIDC account
  (`SIGNUP_FULL`, the callback's error redirect). The setup-code sign-up of the first admin is not refused,
  as with `SIGNUP_MAX_USERS`.
- Restoring a deleted workspace is not checked: it is counted already. Transfers and handovers do not
  change the count.
- `GET /api/auth/mode` says `signupFull: true` when the total is reached, so the sign-up screen closes.
- Unset: no read, no lock, no field.

## Consequences
- The storage one account can collect has a ceiling: at most `LIMIT_WORKSPACES_TOTAL` workspaces of
  `LIMIT_WORKSPACE_STORAGE_MB` each exist at all. Demo preset (50 accounts, 2 per person, 100 in total,
  20 MB): at most 100 × 20 MB = 2,000 MB is counted by the workspace limits (files, bodies, versions, rows,
  comments, handwriting, change texts), whoever holds it; the instance fuse (ADR 2532) at 3,000 MB covers
  what they do not count.
- Reaching the total closes sign-up for everyone until workspaces are deleted for good (by their owners,
  by expiry, or by restore windows ending). A determined user can reach it on purpose; the operator sees it
  in the admin user list and the sign-up screen, and it stops growth instead of filling the disk.
- The R8 reproduction with the limit: totals 3, 5, 7 then every further sign-up refused (keeper owns 7);
  the 0.22.0 code on the same test went on to 17.
