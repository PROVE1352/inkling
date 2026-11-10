#!/usr/bin/env bash
# Manage Inkling signup keys (CLI fallback).
# Normally use the web admin page (/w/<workspace>/admin, admin accounts only). This script is for
# when the web UI is down or the admin account is locked out — identical except created_by stays empty.
# These are Inkling's own keys, unrelated to the external auth server used for delegated login. A
# single-use key also works as a password reset code for whoever signed up with it ("Forgot password?").
#
#   ./deploy/signup-key.sh new "friend A"       # issue a single-use key
#   ./deploy/signup-key.sh new "study" 5 30     # 5 uses, expires in 30 days
#   ./deploy/signup-key.sh list                 # list issued keys
#   ./deploy/signup-key.sh revoke <KEY>         # delete a key (accounts already created stay)
#
# Non-default compose setup: COMPOSE="docker compose -f compose.yaml -f deploy/compose.caddy.yaml" ./deploy/signup-key.sh list
# The signup link uses PUBLIC_URL (environment, else the PUBLIC_URL= line in .env).
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

# Alphabet without confusable characters (0/O, 1/I/L) — same rule as invite codes
gen_key() {
  local alphabet='ABCDEFGHJKMNPQRSTUVWXYZ23456789' out='' i
  for ((i = 0; i < 16; i++)); do
    out+="${alphabet:$((RANDOM % ${#alphabet})):1}"
    if ((i == 3 || i == 7 || i == 11)); then out+='-'; fi
  done
  printf '%s' "$out"
}

cmd="${1:-list}"
case "$cmd" in
  new)
    note="${2:-}"
    uses="${3:-1}"
    days="${4:-}"          # empty = never expires
    key="$(gen_key)"
    if [[ -n "$days" ]]; then
      expires="now() + interval '$days days'"
    else
      expires="NULL"
    fi
    # Stored like the server stores keys: SHA-256 of the upper-case key plus its last four characters
    # (docs/adr/1110-*). The key itself is only printed here; the admin screen shows its hint.
    psql -q -c "INSERT INTO signup_keys (key, key_hint, note, max_uses, expires_at)
                VALUES (encode(sha256(convert_to('$key', 'UTF8')), 'hex'), right('$key', 4),
                        $( [[ -n "$note" ]] && echo "'${note//\'/\'\'}'" || echo NULL ), $uses, $expires)"
    echo
    echo "  Signup key : $key"
    echo "  Note       : ${note:-(none)}"
    echo "  Uses       : ${uses} / expires: ${days:+in ${days} days}${days:-never}"
    echo "  Signup link: ${PUBLIC_URL}/register"
    echo
    ;;
  list)
    psql -c "SELECT CASE WHEN key ~ '^[0-9a-f]{64}$' THEN '…' || coalesce(key_hint, '') ELSE key END AS key,
                    coalesce(note,'') AS note, used_count || '/' || max_uses AS uses,
                    coalesce(to_char(expires_at,'YYYY-MM-DD'),'never') AS expires,
                    to_char(created_at,'YYYY-MM-DD') AS created
               FROM signup_keys ORDER BY created_at DESC"
    ;;
  revoke)
    key="${2:?usage: $0 revoke <KEY>}"
    k="${key//\'/\'\'}"
    psql -q -c "DELETE FROM signup_keys
                 WHERE key IN ('$k', encode(sha256(convert_to(upper(trim('$k')), 'UTF8')), 'hex'))"
    echo "Deleted: $key"
    ;;
  *)
    sed -n '2,14p' "$0"
    exit 1
    ;;
esac
