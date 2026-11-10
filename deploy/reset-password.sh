#!/usr/bin/env bash
# Reset an Inkling password (emergency path from the server console).
# Normally use "temporary password" / "reset code" in the web admin page. This script is for
# when the admin account itself is locked out or the web UI is down — it sets a new temporary
# password and ends every login (session) of that account.
#
#   ./deploy/reset-password.sh someone@example.com
#
# The hash is made inside the app container with the same library as the server (@node-rs/argon2,
# default options) — same format as the server's hashPassword(), so login works as is. The temporary
# password is only printed on screen and never stored in plain text in command-line args or the DB.
# Delegated-login accounts are excluded: their password lives on the external server.
set -euo pipefail
cd "$(dirname "$0")/.."

read -r -a DC <<<"${COMPOSE:-docker compose}"   # e.g. COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml"
# Role and database come from the db container's own environment (whatever INKLING_DATA_NAME names them).
psql() { "${DC[@]}" exec -T db sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"; }

email="${1:?usage: $0 <email>}"
esc="${email//\'/\'\'}"

row="$(psql -tAc "SELECT id || '|' || origin FROM users WHERE email = lower('$esc')")"
if [[ -z "$row" ]]; then
  echo "No such account: $email" >&2
  exit 1
fi
uid="${row%%|*}"
origin="${row##*|}"
if [[ "$origin" != "local" ]]; then
  echo "Delegated-login account ($origin): its password lives on the external auth server and cannot be changed here." >&2
  exit 1
fi

# Generate a temporary password + argon2 hash (with node in the app container)
out="$("${DC[@]}" exec -T app node -e '
const { hash } = require("@node-rs/argon2");
const { randomInt } = require("node:crypto");
const a = "abcdefghjkmnpqrstuvwxyz23456789";
let pw = "";
for (let i = 0; i < 12; i++) { if (i && i % 4 === 0) pw += "-"; pw += a[randomInt(a.length)]; }
hash(pw).then((h) => process.stdout.write(pw + "\n" + h + "\n"));
')"
pw="$(sed -n 1p <<<"$out")"
hashed="$(sed -n 2p <<<"$out")"
if [[ -z "$pw" || "$hashed" != \$argon2* ]]; then
  echo "Hashing failed — check that the app container is running (docker compose ps)." >&2
  exit 1
fi

# Replace the password + delete all sessions + discard leftover reset codes + resolve pending reset requests
# (psql variables are only substituted in stdin scripts, so pass it as a heredoc)
psql -q -v uid="$uid" -v h="$hashed" <<'SQL'
BEGIN;
UPDATE users SET password_hash = :'h' WHERE id = :'uid';
DELETE FROM sessions WHERE user_id = :'uid';
DELETE FROM password_reset_codes WHERE user_id = :'uid';
UPDATE password_reset_requests SET status = 'resolved', resolved_at = now()
 WHERE user_id = :'uid' AND status = 'pending';
COMMIT;
SQL

echo
echo "  Account           : $email"
echo "  Temporary password: $pw"
echo
echo "  All existing logins of this account were ended. Ask them to change the password in Settings > Account after logging in."
echo
