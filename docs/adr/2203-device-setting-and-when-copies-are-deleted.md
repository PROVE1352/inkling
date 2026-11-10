# 2203. Device setting: on in the installed app, off in a browser tab; when copies are deleted

- Status: Accepted
- Date: 2026-11-10

## Context
Offline copies put page text on the device's disk, outside the session. On a personal phone or
laptop that is the point; on a shared or public computer it is a leak that outlives the session: if
the owner later signs that session out from elsewhere ("log out everywhere", password change), the
cookie dies but the copies stay readable to anyone who starts the app there without a network,
until the app next reaches the server.

## Decision
- **Setting** "Keep offline copies on this device" (Settings → Offline, per device, localStorage
  `inkling:offlineCopies`). Default: **on in the installed app** (`display-mode: standalone`; someone
  installed Inkling on this device), **off in a browser tab**. Turning it off deletes every copy at
  once; the page shows how much is stored and has "Delete now". Pending (unsent) edits are named in
  the confirmation.
- **Copies are deleted**
  - on logout, even when the server cannot be told (offline): logging out means leaving the device;
    the logout asks first when pages have unsent edits;
  - on any `401 UNAUTHORIZED` from the API (expired session, revoked session, "log out everywhere",
    password change on another device) — at the next request that reaches the server;
  - when another account signs in (`claim`: the store has one owner; a different user wipes it before
    anything is read or written; late writes of the previous user's open tab are refused inside their
    transaction);
  - per page on a definitive 403/404 from `/sync-check` (member removed, page made private, guest row
    removed, purged), unsent edits included: the user may no longer see that page;
  - per workspace when the workspace list no longer has it.
- Every key includes the user id, so even before a wipe one account never reads another's copies.

## Alternatives considered
- **On everywhere**: convenient, but turns every library or office computer into a store of notes.
- **Off everywhere**: the feature would go unused on the devices it is for.
- **Encrypting the store with a key from the server**: the key would have to be on the device to
  open pages offline, so it protects nothing offline; listed as a known issue instead.

## Consequences
- A user who wants offline pages in a browser tab turns the setting on once on that device.

## References
- apps/web/src/lib/offline/settings.ts, runtime.ts, OfflineSettings.tsx, apps/web/src/api.ts
  (api(), useLogout), apps/web/src/components/Sidebar.tsx
