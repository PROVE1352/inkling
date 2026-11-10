#!/usr/bin/env bash
# Issue Inkling sessions for the CLI / agents.
# Logs inklingctl (or curl) in without handing over a password — the same result as copying
# the inkling_sid cookie from a browser, made with one command on the server.
#
# The usual way now is a personal API token: Settings › Connections › API tokens, then
# `inklingctl login --token` or INKLING_TOKEN=ink_pat_… (docs/adr/1201-*). A token can be read-only,
# limited to some workspaces or one page's subtree, expires on its own, and is shown with its last
# use; a session from this script is full access for N days. Keep this script for the cases a token
# does not cover: an operator issuing access from the server shell for someone who cannot open the
# web app, or rescuing a CLI setup. Sessions from here also stop working when the password is set.
#
#   ./deploy/cli-token.sh new someone@example.com              # 30-day session
#   ./deploy/cli-token.sh new someone@example.com 7 "Mac agent"   # 7 days, with a note
#   ./deploy/cli-token.sh list someone@example.com             # list live sessions
#   ./deploy/cli-token.sh revoke <first 8 chars of token>      # revoke one
#   ./deploy/cli-token.sh revoke-all someone@example.com       # log that account out everywhere
#
# The printed token grants full access to the account. Treat it like the web login password.
# Non-default compose setup: COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/cli-token.sh ...
# The printed server URL uses PUBLIC_URL (environment, else the PUBLIC_URL= line in .env).
set -euo pipefail
cd "$(dirname "$0")/.."

read -r -a DC <<<"${COMPOSE:-docker compose}"
# Role and database come from the db container's own environment (whatever INKLING_DATA_NAME names them).
psql() { "${DC[@]}" exec -T db sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' psql "$@"; }

# Public origin for the printed links: PUBLIC_URL from the environment, else the PUBLIC_URL= line of
# ./.env (read with sed, never sourced), else a placeholder.
env_public_url() {
  [[ -f .env ]] || return 0
  sed -nE 's/^[[:space:]]*PUBLIC_URL[[:space:]]*=[[:space:]]*["'\'']?([^"'\''[:space:]#]*).*/\1/p' .env | tr -d '\r' | tail -n 1 || true
}
PUBLIC_URL="${PUBLIC_URL:-$(env_public_url)}"
PUBLIC_URL="${PUBLIC_URL:-https://notes.example.com}"
PUBLIC_URL="${PUBLIC_URL%/}"

# email → user_id (exits if not found). Escapes single quotes.
user_id_of() {
  local email="${1//\'/\'\'}"
  local id
  id="$(psql -tAc "SELECT id FROM users WHERE email = lower('$email')")"
  if [[ -z "$id" ]]; then
    echo "No such account: $1" >&2
    echo "Registered accounts:" >&2
    psql -tAc "SELECT '  - ' || email FROM users ORDER BY created_at" >&2
    exit 1
  fi
  printf '%s' "$id"
}

cmd="${1:-help}"
case "$cmd" in
  new)
    email="${2:?usage: $0 new <email> [days until expiry] [note]}"
    days="${3:-30}"
    note="${4:-}"
    uid="$(user_id_of "$email")"
    # Same format as the server's auth: randomBytes(32).toString('base64url')
    token="$(python3 -c "import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='))")"
    # The server stores only the SHA-256 of a session token (docs/adr/1060-*).
    psql -q -c "INSERT INTO sessions (token, user_id, expires_at)
                VALUES (encode(sha256(convert_to('$token','UTF8')),'hex'), '$uid', now() + interval '$days days')"
    if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
    hp="$(printf %s "$token" | "${sum[@]}" | cut -c1-8)"
    echo
    echo "  Account: $email"
    echo "  Expires: in ${days} days"
    echo "  Note   : ${note:-(none)}"
    echo
    echo "  Put this into ~/.inkling.json as is (mode 600):"
    echo
    cat <<JSON
{
  "server": "$PUBLIC_URL",
  "cookie": "inkling_sid=$token"
}
JSON
    echo
    echo "  As a one-liner:"
    echo "    umask 077 && printf '%s\\n' '{\"server\":\"$PUBLIC_URL\",\"cookie\":\"inkling_sid=$token\"}' > ~/.inkling.json"
    echo
    echo "  With curl:"
    echo "    curl -H 'Cookie: inkling_sid=$token' ${PUBLIC_URL}/api/auth/me"
    echo
    echo "  Revoke: $0 revoke $hp"
    echo
    ;;
  list)
    email="${2:?usage: $0 list <email>}"
    uid="$(user_id_of "$email")"
    # token_prefix is the start of the stored SHA-256, not of the cookie value.
    psql -c "SELECT left(token,8) AS token_prefix,
                    to_char(created_at,'YYYY-MM-DD HH24:MI') AS created,
                    to_char(expires_at,'YYYY-MM-DD HH24:MI') AS expires
               FROM sessions
              WHERE user_id = '$uid' AND expires_at > now()
              ORDER BY created_at DESC"
    ;;
  revoke)
    prefix="${2:?usage: $0 revoke <token prefix>}"
    n="$(psql -tAc "DELETE FROM sessions WHERE token LIKE '${prefix//\'/\'\'}%' RETURNING 1" | wc -l)"
    echo "Sessions revoked: $n"
    ;;
  revoke-all)
    email="${2:?usage: $0 revoke-all <email>}"
    uid="$(user_id_of "$email")"
    n="$(psql -tAc "DELETE FROM sessions WHERE user_id = '$uid' RETURNING 1" | wc -l)"
    echo "Sessions revoked: $n (browser logins included — they must log in again)"
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 1
    ;;
esac
