# 2160. The first admin comes in through a one-time setup link from the server log

- Status: Accepted
- Date: 2026-11-10

## Context
A fresh install needed five steps before anyone could sign in: copy `.env`, type a database password,
start, issue a signup key with `deploy/signup-key.sh` (a psql INSERT), sign up with it. The key step is
the one people stumble on, and it exists for a reason: with `NODE_ENV=production` signups need a key
(C-M10) so the first stranger to reach a fresh public instance does not become its admin.

The obvious shortcut, "requests from localhost need no key", is unsafe: behind a reverse proxy (Caddy,
nginx, a tunnel) every request reaches the app from a local address, so on a real server the first
visitor would be treated as local and become admin.

## Decision
- **At boot, with no account in the database**, the server makes a one-time setup code (24 characters of
  the unambiguous alphabet signup keys use, about 119 bits, from `crypto.randomBytes` without modulo bias)
  and prints `<PUBLIC_URL or APP_URL>/setup?code=…` to stdout once it listens. When neither origin is set
  it prints `http://localhost:<PORT>` and says to keep the `/setup?code=…` part on another address.
- **Memory only**: the process keeps the SHA-256 of the normalized code; nothing is written to the
  database (no migration). A restart with still no account makes a new code and the old one stops
  working. The instance lock (ADR 1925) means there is one process per database, so one code.
- **`POST /api/auth/register` takes `setupCode`** in place of `signupKey`. A wrong code is 403
  `INVALID_SETUP_CODE` and counts as a failed attempt for the IP ban (`recordFailure(req,
  'setup-code')`), on top of the route's 10/min limit; a code after setup closed is 403 `SETUP_CLOSED`.
  The compare is constant-time.
- **At most one account**: the setup account is inserted under the admin advisory lock (the one
  `promoteIfNoAdmin` takes) after a `no user exists` check in the same transaction, with `is_admin = true`
  set on insert. Of N concurrent setups one commits and the others get `SETUP_CLOSED`; a setup racing a
  key signup can only win while that other account has not committed, and there is never a second admin
  (the key signup's `promoteIfNoAdmin` sees the admin).
- **Closed for good once any account exists**, however it was made (signup key, open signup, OpenID
  Connect auto-create, delegated login): `/auth/mode` checks the table while a code is open and closes it
  when it finds a row; a boot that finds accounts makes no code.
- The setup account is not held back by `REQUIRE_EMAIL_VERIFICATION`: the code already proves who runs
  the server, and a mail misconfiguration must not lock out the only admin (the verification mail is
  still sent when mail is on).
- **Web**: `/setup?code=…` is the sign-up screen in setup mode (title, the code field filled from the
  link, no signup key field). `/auth/mode` carries `setupPending`, and the sign-in screen then says where
  the link is (`docker compose logs app`).
- The signup-key path is unchanged, including `deploy/signup-key.sh` for the first admin, and
  `SIGNUP_REQUIRE_KEY` keeps its meaning. The boot warning "no accounts yet and signups need a key" is
  replaced by the link.

## Security argument
Who can read the server's stdout already controls the server (`docker compose logs` needs the same
access as `docker compose exec db psql`, which is what the signup-key script uses), so the code grants
nothing a log reader could not take anyway. Nobody on the network can see the code; guessing 119 bits
under a per-IP limit and ban is not feasible. The window is "from first boot to first account". Existing
installs have accounts, so they never print a code. Operators who ship container logs to a service other
people read should create the first account right after the first start or keep using the key
(deploy/DEPLOY.md 3-C).

## Alternatives considered
- **Requests from loopback need no key**: unsafe behind any proxy (above). Rejected.
- **Store the code in the database** (a signup key row marked "setup"): survives restarts, but it has to
  be cleaned up, shows in the admin key list, and a key row cannot express "only while there are no
  accounts" without new columns. Rejected for the in-memory code.
- **Write the code to a file in DATA_DIR**: readable with `docker compose exec app cat`, but the data
  volume is in the backups, and the log is where people already look. Not done.
- **A switch to turn the link off** (`FIRST_ADMIN_SETUP=0`): the link is closed on every instance that has
  an account, which is every running install; can be added if an operator needs it.
- **Generate the first admin's password at boot and print it**: a password in a log outlives the moment;
  a one-time code dies with the first account.

## References
- apps/server/src/firstAdminSetup.ts, apps/server/src/routes/auth.ts, apps/server/src/index.ts,
  packages/shared/src/index.ts (`registerSchema.setupCode`, `AuthModeDTO.setupPending`),
  apps/web/src/pages/Register.tsx, apps/web/src/pages/Login.tsx, apps/web/src/App.tsx
- apps/server/src/firstAdminSetup.db.test.ts (own scratch database: concurrency, closing, key path)
- ADR 2161 (local trial), C-M10 (production signup keys), ADR 1925 (one process per database)
