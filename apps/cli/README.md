# inklingctl

Command-line client for Inkling: list workspaces, push a Markdown file, pull a workspace into a folder, and
two-way vault sync ([docs/VAULT-SYNC.md](../../docs/VAULT-SYNC.md)). Run `inklingctl help` for every command.

## Signing in

inklingctl needs one credential. It looks in this order and uses the first it finds:

1. `INKLING_TOKEN` in the environment (an API token, used for that run only, nothing is saved),
2. an API token saved by `inklingctl login --token`,
3. a session saved by `inklingctl login` (email and password).

### API token (recommended for scripts, cron and CI)

Make a token in the web app: Settings → Connections → API tokens → New token. Pick read only or read and write,
an expiry, and what it may see (everything, some workspaces, or one page and the pages under it). Then either

```sh
inklingctl login --token --server https://notes.example.com   # asks for the token, checks it, saves it
INKLING_TOKEN=ink_pat_… inklingctl ls                        # or pass it per run
```

`login --token` also reads the token from `INKLING_TOKEN` or from a pipe. The token is sent as
`Authorization: Bearer`, is shown with its last use in the web app, and can be revoked there. Setting a new
password revokes all tokens.

### Password

```sh
inklingctl login --server https://notes.example.com
```

Email and password come from `--email` / `INKLING_EMAIL` / `INKLING_PASSWORD`, a pipe, or a prompt. The session
cookie is saved in `~/.inkling.json` (mode 0600). Logging in with a password removes a saved token and the other way
round, so only one credential is on disk. Configs from older versions (`"cookie": "inkling_sid=…"`) keep working.

`deploy/cli-token.sh` on the server can still issue a session for someone who cannot open the web app; for
everything else an API token is the better choice (it can be limited, expires and shows when it was used).

`inklingctl status` says which credential is in use.
