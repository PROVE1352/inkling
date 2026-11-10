# Inkling deployment guide (any Linux server)

Every image is multi-arch (x86-64 and ARM64), so the same setup works on ARM cloud VMs (for example
free-tier Ampere instances) and on ordinary x86 servers.

## 1. Prepare the server (Ubuntu 22.04)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log in again afterwards

# Firewall / security list: allow inbound 80 and 443 (in the OCI console's Security List too!)
```

## 2. Code & environment

```bash
git clone <repo-url> /opt/inkling && cd /opt/inkling
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD to a strong value! (used inside the Docker network)
```

The clone is still needed for `compose.yaml`, the Caddy overlay and the `deploy/*.sh` scripts, but the
app itself comes as a prebuilt image, `ghcr.io/prove1352/inkling` (linux/amd64 and linux/arm64), so
the server never has to run the build (which needs more than 1 GB of memory).

### Image or source build

| | Published image (default) | Source build |
|---|---|---|
| Start / update | `docker compose pull app && docker compose up -d app` | `docker compose -f compose.yaml -f compose.build.yaml up -d --build app` |
| Version | `INKLING_VERSION` in `.env`: a release as `X.Y.Z` (exact) or `X.Y` (newest patch), or empty (= `latest`) | whatever is checked out |
| Image name | `ghcr.io/prove1352/inkling:<version>` | `inkling:local` (never pulled) |

`compose.yaml` names the published image **and** keeps `build: .`, so `docker compose up -d --build`
still builds from source exactly as before; the result is tagged with the published name, and a later
`docker compose pull` would replace it with the release. When the image is missing locally (or a pull
fails, e.g. offline), `up` falls back to building. If you deploy from source on purpose (a fork, local
patches, an unreleased `main`), use `compose.build.yaml` so the two never mix. With HTTPS, list it last:
`-f compose.yaml -f deploy/compose.caddy.yaml -f compose.build.yaml`. If you already keep a
`compose.override.yaml` (read automatically when no `-f` is given), put its two lines under `app:`
there instead:

```yaml
services:
  app:
    image: inkling:local
    pull_policy: never
```

### Language and time zone

- `DEFAULT_LOCALE` (`en` | `ko`, default `en`): the language of emails and built-in templates for
  users who haven't picked one, and the web UI default before the browser language is applied.
  Each user picks their own language in Settings → Language.
- `TZ` (container time zone, default `UTC`): decides what "today" is for due dates, daily notes and
  reminders, and the times shown in emails.

For a Korean deployment, put this in `.env`:

```bash
DEFAULT_LOCALE=ko
TZ=Asia/Seoul
```

## 3-A. Plain HTTP (internal network / testing only)

```bash
docker compose up -d     # → http://<server-ip>:3000
```

> ⚠️ **On any non-local (internet-facing) host, the Caddy overlay from 3-B is required.** Running
> the base `compose.yaml` alone exposes the app over plain HTTP on port 3000, and the DB port is
> bound to loopback only, so use it for local / internal testing only. A public server must sit
> behind Caddy (HTTPS); only then do Secure cookies and the hidden app/DB ports apply.

## 3-B. Domain + HTTPS (recommended — PWA install and the clipboard API need it too)

1. DNS: domain (A record) → server IP. Any domain or subdomain works.
2. In `.env` (copied from `.env.example`), set the two existing lines:
   ```dotenv
   DOMAIN=notes.example.com
   PUBLIC_URL=https://notes.example.com   # mail links, OAuth issuer; also read by the deploy scripts
   ```
   then start with the overlay:
   ```bash
   docker compose -f compose.yaml -f deploy/compose.caddy.yaml up -d
   ```
3. Caddy issues the certificate automatically → `https://<domain>`. Cookies switch to Secure mode
   automatically (COOKIE_SECURE=1).

## 3-C. Accounts — issuing signup keys

Inkling accounts are created only with a **signup key** (if delegated login is on, people can also
come in with an external account — see 3-D). With `NODE_ENV=production` (the compose default), a
signup key is required even when `SIGNUP_REQUIRE_KEY` is empty. Open signup without a key is
enabled only when `.env` explicitly sets `SIGNUP_REQUIRE_KEY=0`.

**First admin.** While there is no admin at all, the first person to sign up or log in becomes an
admin automatically (bootstrap of a fresh install). After that, admins grant and revoke the role to
each other on the admin screen. The last admin cannot be demoted or removed. If signup keys are
required, create the first key with the CLI:

```bash
./deploy/signup-key.sh new "me"     # the first person to sign up with this key becomes admin
```

**Web admin page (recommended).** When you log in with an admin account, "Admin" appears in the
sidebar (`/w/<workspace>/admin`, with a number badge when password reset requests are pending).
From there you issue and revoke keys (+ invite mail), manage users (password reset, email
verification, admin role, forced removal), handle password reset requests, and manage banned IPs.
Lists show the newest 5 at a time and are searchable.

When you need to make someone admin directly with SQL:

```bash
docker compose exec -T db psql -U nodian -d nodian \
  -c "UPDATE users SET is_admin=true WHERE email='someone@example.com'"
```

**CLI (fallback).** When the web UI is down or the admin account is locked out:

```bash
./deploy/signup-key.sh new "friend A"     # single use, never expires
./deploy/signup-key.sh new "study" 5 30   # 5 uses, expires in 30 days
./deploy/signup-key.sh list               # list issued keys
./deploy/signup-key.sh revoke <KEY>       # delete a key (accounts already created stay)
./deploy/reset-password.sh someone@example.com   # issue a temporary password + log that account out
```

The recipient signs up at `https://<domain>/register?key=<KEY>` (or enters the key on `/register`)
and chooses an email, name and password.

**Forgotten passwords.**

- Login screen "Forgot password?" → `/reset`.
  - *I have a code*: email + code + new password. The code is a single-use reset code issued by an
    admin (valid 24 hours), or the **single-person (1-use) signup key** that person signed up with.
    A signup key shared by several people cannot be used for a reset.
  - *I don't have a code*: a reset request to the admins (with a note). If the account's email is
    verified and mail is on, a reset email goes out automatically without involving an admin. The
    response is the same whether or not the account exists.
- Admins: issue a [Reset code] / [Temporary password] from the request row or the user row → shown
  once on screen (copy or send by email). Either way, all of that person's existing logins are
  ended. Only a hash of the reset code is stored in the DB.
- The user themself: change it in Settings > Account with the current password (other devices are
  logged out, this one stays).
- Delegated-login accounts keep their password on the external auth server, so none of the above
  applies to them.

**Forced removal.** [Remove] on a user row in the admin screen. The users row is deleted; sessions,
workspace memberships, bookmarks, the user's own notifications and MCP connections are deleted with
it, while pages, files, comments, snapshots, templates and workspaces remain with only the author
column cleared (SET NULL). Signup keys that person used get one use back.
If the person is the sole owner of any workspace, removal is refused with 409 `SOLE_OWNER` and the
list of those workspaces — promote another member to owner first, then try again.
The person's private pages go to the trash without an author, are visible to nobody (admins
included) and are permanently deleted after 30 days. If they want, suggest an export before removal.

## 3-D. Delegated login (optional)

When `DELEGATED_AUTH_URL` is set, logging in with an id that Inkling doesn't know is verified by
that external auth server. Sharing goes **one way only, for login** — Inkling account passwords are
never sent out, and Inkling's own accounts (local accounts with a matching email) are always
verified locally.

| env | Meaning | Default |
|---|---|---|
| `DELEGATED_AUTH_URL` | Origin of the external auth server (e.g. `https://auth.example.com`) | none (off) |
| `DELEGATED_AUTH_NAME` | Name shown on the login and admin screens | "External account" |
| `DELEGATED_EMAIL_DOMAIN` | Email domain for mirrored delegated accounts (`<id>@<domain>`, no real mail is sent) | `delegated.local` |

Keep the first value of `DELEGATED_EMAIL_DOMAIN` — changing it breaks the match with existing
delegated accounts, and the same person ends up with a new account. Turning delegation on also
turns on the signup-key requirement automatically.

**Contract the external auth server must satisfy:**

```
POST <DELEGATED_AUTH_URL>/api/auth/login
Content-Type: application/json
{"username": "<id>", "password": "<password>"}
```

| External response | Inkling's verdict |
|---|---|
| 200 + `{"access_token": "<non-empty string>"}` | Success → find-or-create `<id>@<DELEGATED_EMAIL_DOMAIN>` in Inkling's users, then issue an Inkling session. The token is discarded, never stored or forwarded. |
| 200 + `{"totp_required": true}` | 401 `TOTP_UNSUPPORTED` (accounts with two-factor auth are not supported) |
| 401 | 401 `INVALID_CREDENTIALS` (same message as a failed local login) |
| 429 | 429 `RATE_LIMITED` |
| 5xx · network error · 10-second timeout · anything else | 503 `AUTH_UPSTREAM_UNAVAILABLE` |

## 3-E. Mail (optional)

Turned on by setting `SMTP_HOST` + `MAIL_FROM` (`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASS`, link address `APP_URL`). When off, the related buttons are hidden and only
copy-and-paste remains.

- Admins: [Send by email] for reset codes, temporary passwords and signup keys (invites). The
  recipient defaults to that user's email and can be changed (empty for the fake domain of
  delegated accounts).
- Links in mail: `/reset?email=&code=`, `/register?key=`, `/verify?token=` — the screens are prefilled.
- Email verification: a verification email is sent right after signup, can be resent from
  Settings > Account and the login screen, and admins have [Verification email] and [Mark verified]
  on the admin screen. Existing accounts are only shown as unverified; their login is not blocked.
  With `REQUIRE_EMAIL_VERIFICATION=1`, people who sign up **after that** cannot log in before
  verifying.
- When a verified email account presses "Forgot password?", a reset email goes out without the
  admin queue (at most one per 5 minutes).
- Server logs record only the recipient domain and the SMTP error code (never codes, passwords or
  SMTP_PASS).

## 3-F. Brute-force protection

**Failures** of login, password reset, signup keys, email verification tokens, reset requests,
delegated login, MCP OAuth authorization/token exchange and public share links (non-existent
tokens) are counted per IP. By default, 10 failures within 15 minutes ban that IP for 15 minutes,
and each repeat ban grows to 1 hour → 6 hours → 24 hours (cap) (the level resets 7 days after the
last ban). While banned, only the auth and token routes return 429 + `Retry-After` (the regular API
for logged-in users is not blocked). IPv6 is counted per /64. Accounts are never locked; once an
account passes 5 failures, only the delay before the next attempt grows: 1 s, 2 s, 4 s… up to 5
minutes. A success resets the counters.

- The real client IP is taken only from `X-Forwarded-For` added by a front proxy matching
  `TRUST_PROXY`. Default `loopback,uniquelocal` — connections coming through Caddy on the same host
  (127.0.0.1) and the Docker bridge (172.16/12 etc.). XFF on connections straight from the internet
  is ignored. If your front proxy lives elsewhere, change this to its address/CIDR.
- IPs/CIDRs in `ALLOWLIST_IPS` are never banned (shown on the admin screen).
- Bans are kept in the `ip_bans` table and survive restarts. Lift them in the admin screen under
  "Banned IPs" (manual bans work too, except for the IP you're connected from). To lift them quickly with SQL:

```bash
docker compose exec -T db psql -U nodian -d nodian \
  -c "UPDATE ip_bans SET banned_until = now() WHERE banned_until > now()"
docker compose restart app   # to clear the in-memory ban list as well
```

- Tuning: `AUTH_GUARD_WINDOW_MINUTES`, `AUTH_GUARD_MAX_FAILURES`, `AUTH_GUARD_BAN_MINUTES`,
  `AUTH_GUARD_BAN_MAX_HOURS`, `AUTH_GUARD_ACCOUNT_FAILURES`.
- Request rate limiting (@fastify/rate-limit: 300/min globally, 10/min for auth, etc.) keeps working
  separately and uses the same 429 `RATE_LIMITED` format.

## 3-G. OpenID Connect sign-in (optional)

Adds "Sign in with <name>" to the login screen. Works with OpenID Connect providers such as Google
Workspace, Microsoft Entra ID, Keycloak and Authentik. The password stays at the provider; Inkling
receives a signed id_token and issues its usual session (docs/adr/1160-*). Password sign-in keeps
working next to it.

1. Register Inkling as a confidential web client (authorization code flow) at the provider with
   the redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`, e.g.
   `https://notes.example.com/api/auth/oidc/callback`. `PUBLIC_URL` is required; the server does not
   start with OIDC configured and no `PUBLIC_URL`.
2. Put the issuer, client id and secret in `.env` and restart:

| env | Meaning | Default |
|---|---|---|
| `OIDC_ISSUER` | Issuer URL, exactly as the provider's discovery document states it | none (off) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Client credentials. The secret is sent only to the token endpoint, never logged or returned | none |
| `OIDC_NAME` | Button label ("Sign in with <name>") | `SSO` |
| `OIDC_ALLOWED_DOMAINS` | Comma-separated email domains allowed to sign in; needs `email_verified` | empty (anyone the provider issues) |
| `OIDC_AUTO_CREATE` | `1` = first sign-in of someone new creates an account (no signup key) | `0` |
| `OIDC_LINK_EXISTING` | `1` = connect to an existing local account with the same, provider-verified email (never admins) | `0` |
| `OIDC_REQUIRE_MFA` | `1` = refuse sign-ins whose id_token shows no second factor (`amr`/`acr`) | `0` |
| `OIDC_ACR_VALUES` | acr values to request; a returned one in this list counts as a second factor | empty |
| `OIDC_TRUST_EMAIL` | `1` = treat the email as verified when the provider sends no `email_verified` | `0` |
| `OIDC_SCOPES` | Requested scopes | `openid email profile` |
| `OIDC_ID_TOKEN_ALG` | The one accepted id_token algorithm: `RS256`, `PS256` or `ES256` | `RS256` |

Issuer examples:

| Provider | `OIDC_ISSUER` | Notes |
|---|---|---|
| Google Workspace | `https://accounts.google.com` | Restrict with `OIDC_ALLOWED_DOMAINS=<your domain>`. Google sends no `amr`, so leave `OIDC_REQUIRE_MFA=0` and enforce 2-Step Verification in the Admin console. |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` | Use the tenant id, not `common`/`organizations`. Turn on the optional `email` claim. Entra sends no `email_verified`: account creation needs `OIDC_TRUST_EMAIL=1`, and email linking stays off. |
| Keycloak | `https://<host>/realms/<realm>` | For `OIDC_REQUIRE_MFA`, configure ACR levels and set `OIDC_ACR_VALUES`, or add an `amr` mapper. |
| Authentik | `https://<host>/application/o/<slug>/` | Keep the trailing slash: it is part of the issuer. |

How accounts are matched (docs/adr/1161-*): by the provider's issuer and subject, never by email
alone. Someone who already has an Inkling account connects the provider in Settings › Account
(the safe way). With `OIDC_LINK_EXISTING=1` the first sign-in also connects to an account with the
same email if the provider marks that email verified. People with no account get one only with
`OIDC_AUTO_CREATE=1`; signup keys are not asked for, so set `OIDC_ALLOWED_DOMAINS` (the server
warns at boot when it is empty). On an empty instance the first account becomes admin, as with any
signup.

Two-step verification (docs/adr/1162-*): accounts created by the provider use the provider's
second factor and count as verified for workspaces that require two-step verification. To make
Inkling check it, set `OIDC_REQUIRE_MFA=1`. Accounts that also have Inkling's own two-step
verification are asked for the code after the provider.

Problems show up on the login screen as a fixed message and in the server log as
`[oidc] callback refused: <CODE> (<reason>)`. `OIDC_STATE_INVALID` usually means the sign-in took
longer than 10 minutes or was started in another tab or browser; `OIDC_UNAVAILABLE` means the
discovery document, keys or token endpoint could not be reached (check the issuer and the
container's outbound network).

## 3-H. Semantic search (optional)

Off unless both `EMBEDDING_URL` and `EMBEDDING_MODEL` are set (docs/adr/1740-*). When on, find_context also ranks
sections by meaning, and the server sends the text of every section chunk (page title, heading path, chunk text) to
that endpoint, once per change. With a hosted provider that is a third party; a local model server (Ollama,
text-embeddings-inference) keeps notes on your network. Put the variables in `.env` (examples in `.env.example`) and
restart:

| env | Meaning | Default |
|---|---|---|
| `EMBEDDING_URL` | Base URL of an OpenAI-compatible API (`https://api.openai.com/v1`, Ollama `http://host:11434/v1`) or the full `…/embeddings` URL | none (off) |
| `EMBEDDING_MODEL` | Model name; changing it re-embeds everything | none (off) |
| `EMBEDDING_API_KEY` | Sent as `Authorization: Bearer …`; never logged or shown | none |
| `EMBEDDING_DIMENSIONS` | Sent as `dimensions` (models that can shorten vectors) | model default |
| `EMBEDDING_BATCH_SIZE` | Chunks per request (1–256) | `32` |
| `EMBEDDING_REQUESTS_PER_MINUTE` | Indexer request rate | `60` |
| `EMBEDDING_TIMEOUT_MS` | Indexer request timeout | `30000` |
| `EMBEDDING_QUERY_TIMEOUT_MS` | Timeout of the query embedding of one search; on timeout search answers lexically | `3000` |
| `EMBEDDING_MAX_CHARS` | Characters of one chunk sent to the model | `4000` |
| `EMBEDDING_CACHE_MB` | In-process vector cache for queries | `128` |

Inside the container `localhost` is the container: for Ollama on the Docker host use
`http://host.docker.internal:11434/v1` (Docker Desktop) or the host's LAN address. Boot log, progress, memory and how
to turn it off again: [docs/OPERATIONS.md](../docs/OPERATIONS.md) section 5.

## 3-H2. Uploads by AI agents

Agents attach files to pages with the MCP tool `upload_file`, and API tokens with `POST /api/files`
(docs/adr/2044-*, 2065-*). Each workspace can follow the server default or turn it on or off (Workspace settings ›
Connected agents › File uploads; owners and admins). People's uploads in the browser and agents reading
attachments are never affected. Put the variables in `.env` only to change the defaults; Admin › Status shows the
values in use.

| env | Meaning | Default |
|---|---|---|
| `AGENT_UPLOADS` | `on` = allowed unless a workspace turns it off; `off` = refused unless a workspace turns it on; `never` = refused everywhere, workspaces cannot turn it on. Any other value counts as `off`, with a warning at boot | `on` |
| `AGENT_UPLOAD_MAX_MB` | Largest file an agent may upload, in MB (at most 64; higher values are cut with a warning). Above 8, MCP requests that call upload_file may be as large as the file in base64 plus 1 MB; other MCP requests keep 12 MB. Memory per upload in flight is about four times the file | `5` |
| `AGENT_UPLOAD_DAILY_MB` | Budget per account per 24 hours over the files that account's connections uploaded; `0` = no budget. Browser uploads do not count and have none | `200` |

## 3-I. One server process per database

The server refuses to start while another Inkling process uses the same database, because two processes overwrite
each other's documents (docs/adr/1925-*). `docker compose up -d` stops the old container first, so normal updates are
not affected. Put the variables in `.env` only if you need to change the default:

| env | Meaning | Default |
|---|---|---|
| `SINGLE_INSTANCE` | `0` (or `false`/`off`/`no`) turns the guard off, with a warning at boot. Only for a deliberate extra process against a live database, or behind a transaction-mode pooler; never for a second web server | on |
| `SINGLE_INSTANCE_WAIT` | Seconds a starting server waits for the other process to stop (a replaced container still saving documents) before it exits | `60` |

Log lines and what to do: [docs/OPERATIONS.md](../docs/OPERATIONS.md) section 9.

## 4. Backups

The `backup` service in `compose.yaml` backs up the database and the data volume every day at
03:00 (verified, GFS retention, weekly restore test) — no crontab needed. Status, "Back up now" and
downloads: Admin › Backups. Off-site copies (rclone), encryption, and restoring with
`./deploy/restore.sh`: **[docs/BACKUP.md](../docs/BACKUP.md)**.

```bash
./deploy/backup.sh            # back up now
./deploy/backup.sh list
./deploy/restore.sh --dry-run <set-id>
```

Older `./backups/nodian-db-*.dump` files from the previous script can still be restored with
`docker compose exec -T -e PGOPTIONS="-c statement_timeout=0" db pg_restore -U nodian -d nodian --clean < <file>`
(PGOPTIONS keeps a role- or database-level statement_timeout from cutting a long restore; the backup
scripts set the same for every psql / pg_dump / pg_restore they run).

## 5. Updating

Migrations run automatically, in one transaction, when the new app boots; the old version keeps the
database until then. Take a backup first, then (add your `-f` files to every compose command):

```bash
cd /opt/inkling
./deploy/backup.sh                 # ends with "ok set=<id> ..."
git pull                           # compose files and deploy scripts
# optional: pin the release in .env as INKLING_VERSION=X.Y.Z (or X.Y)
docker compose pull app
docker compose up -d app
docker compose logs --tail 50 app  # migration result and "Server listening"
```

Source build instead: `git pull && docker compose -f compose.yaml -f compose.build.yaml up -d --build app`
(or `docker compose up -d --build app` when the two lines are in `compose.override.yaml`).

Moving an existing source-built install to the published image: nothing is migrated by the switch
itself, the database and volumes stay as they are. Check that the release you pull is not older than
the code you were running (`git describe --tags` in the checkout; an install built from `main` after the
latest release must wait for the next release or keep building from source, because an older image
does not know the newer schema). Then follow the steps above. Every release is tested for an upgrade
from each earlier release (`.github/workflows/upgrade.yml`). Downgrading is not supported: to go
back, restore the backup taken before the upgrade (docs/BACKUP.md) and set `INKLING_VERSION` to
the old release.

On a stop signal (SIGTERM) the app saves collaborative documents being edited to the DB before
exiting, which takes up to ~25 seconds. compose's `stop_grace_period: 30s` waits for this, so don't
cut it short with `docker kill` / `docker compose kill`. A new container started while the old one is still
saving waits for it (`SINGLE_INSTANCE_WAIT`, section 3-I).

## Notes

- To use the Notion upload feature, set `NOTION_TOKEN=secret_...` in `.env` (create an internal integration at notion.so/my-integrations and give it access to the target pages).
- Moving data from another machine: `./deploy/backup.sh` there, `./deploy/backup.sh copy-out <set> <dir>`, copy the set to the new server and follow "Restoring on a new server" in docs/BACKUP.md.
