# Running a demo instance

A demo instance is a second Inkling server that strangers can sign up to and try. It runs next to your own
server but shares nothing with it: its own compose project, database, volumes, network and port. The
restricted mode of 0.22 turns on what such a server needs: sign-in IDs instead of email addresses, an
account cap, a per-IP sign-up limit, accounts deleted 14 days after sign-up, limits on workspaces, members,
pages and storage, server-wide switches for features that send data outside, terms and consent at sign-up,
and a "Demo" label on every screen. 한국어: [DEMO.ko.md](DEMO.ko.md).

The files are in [`deploy/demo/`](../deploy/demo/): `compose.demo.yaml` (an overlay on `compose.yaml`),
`demo.env.example` (the settings) and `legal/` (templates of the terms, privacy policy and sign-up texts).
Design notes: ADR 2500–2524.

## 1. Start it as a separate instance

On the server that runs your main instance, from the repository root:

```bash
cp deploy/demo/demo.env.example deploy/demo/demo.env
# fill in POSTGRES_PASSWORD, APP_SECRET_KEY (openssl rand -base64 32 each) and PUBLIC_URL
docker compose --env-file deploy/demo/demo.env -f compose.yaml -f deploy/demo/compose.demo.yaml up -d
```

Always pass `--env-file deploy/demo/demo.env`. The overlay refuses to start without it (every demo setting
is required), so the production `.env` can never start a demo with no limits, and the demo can never reuse
the production volumes. The app listens on `127.0.0.1:3100` only; nothing is public until step 4.

## 2. Create the operator account before opening sign-up

`SIGNUP_REQUIRE_KEY=0` opens sign-up to everyone, and the first account of a server without an administrator
becomes the administrator. So create your own account first, while the demo is still reachable only from
this machine:

```bash
docker compose --env-file deploy/demo/demo.env -f compose.yaml -f deploy/demo/compose.demo.yaml logs app | grep -A2 'No accounts yet'
ssh -L 3100:127.0.0.1:3100 your-server     # from your computer, then open the /setup?code=… link on localhost:3100
```

The setup link works once, only while there are no accounts. The setup form shows the same consent boxes as
the sign-up form: the operator agrees to the terms too. Administrator accounts never expire.

## 3. Fill in the terms folder

`deploy/demo/legal/` is a template with four placeholders: `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`,
`{{SERVICE_URL}}` and `{{EFFECTIVE_DATE}}`. Copy it out of the repository, fill it in, and point
`DEMO_LEGAL_DIR` in `demo.env` at the copy:

```bash
sudo mkdir -p /srv/inkling-demo && sudo cp -r deploy/demo/legal /srv/inkling-demo/legal
# edit the four placeholders in /srv/inkling-demo/legal/*.md, then in demo.env:
#   DEMO_LEGAL_DIR=/srv/inkling-demo/legal
docker compose --env-file deploy/demo/demo.env -f compose.yaml -f deploy/demo/compose.demo.yaml up -d app
```

The server reads the folder once at start. A malformed `signup.json` stops it with the file and the reason
in the log; a placeholder left in a document is a warning at every start. The folder's version is a hash of
its files, so any edit followed by a restart asks every account, yours included, to agree again on the next
request. A restart also closes the open editing connections, so nobody keeps working on the old terms.

What the folder holds:

| File | Use |
|---|---|
| `terms.ko.md`, `terms.en.md` | Terms of Service, shown at `/terms` |
| `privacy.ko.md`, `privacy.en.md` | Privacy Policy, shown at `/privacy` |
| `signup.json` | The notice at the top of the sign-up form and the tick boxes (`id`, `required`, `label`, optional `doc` and `details`) |

A document with only one language is shown in that language to everyone. Documents are Markdown; HTML in
them is shown as text, and links work only for `http`, `https` and `mailto`.

## 4. Proxy

Put HTTPS in front of `127.0.0.1:3100`. With Caddy on the host:

```
demo.example.com {
	encode gzip zstd
	reverse_proxy 127.0.0.1:3100
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
```

`TRUST_PROXY=loopback,uniquelocal` makes the server take the client address from `X-Forwarded-For` when the
request comes from the proxy, which the per-IP sign-up limit needs. If the proxy keeps an access log, that
log holds IP addresses too: keep it no longer than the privacy policy says (30 days in the template).

## 5. Check before you announce it

- The start log has a line for the limits that are on, one for the features that are off, one for
  `LEGAL_DIR` with its version, and no placeholder warning.
- `curl -s https://demo.example.com/api/auth/mode` shows `loginId`, `instanceLabel`, `legal`, `limits` and
  `disabledFeatures`.
- In a private window: the sign-up form asks for an ID, shows the notice and six unticked boxes, and the
  button stays off until all are ticked. `/terms` and `/privacy` open without signing in.
- After signing up, the deletion date is shown, and the "Demo" label is visible on a phone and on a computer.
- `docker compose … ps` shows no published database port and only `127.0.0.1:3100` for the app.
- Admin › Backups shows 7 daily, 0 weekly and 0 monthly sets.
- From one network, a third sign-up in a day is refused (the proxy passes the real address).

## Settings

One line each; the full reference is in the operations docs.

| Variable | Demo value | Meaning |
|---|---|---|
| `LOGIN_ID_MODE` | `username` | Sign up with an ID and a nickname instead of an email address |
| `SIGNUP_REQUIRE_KEY` | `0` | Anyone can sign up without a key |
| `SIGNUP_MAX_USERS` | `50` | Most accounts on the server, administrators included |
| `SIGNUP_PER_IP_PER_DAY` | `2` | Sign-ups from one address in 24 hours |
| `ACCOUNT_LIFETIME_DAYS` | `14` | Accounts made from now on are deleted this many days after sign-up |
| `ACCOUNT_LIFETIME_DRY_RUN` | empty | `1` logs what would be deleted and deletes nothing |
| `LIMIT_WORKSPACES_PER_USER` | `2` | Workspaces one person owns, deleted ones still restorable included |
| `LIMIT_MEMBERS_PER_WORKSPACE` | `4` | Members of one workspace |
| `LIMIT_PAGES_PER_WORKSPACE` | `300` | Pages of one workspace, trash included |
| `LIMIT_FILE_MB` | `5` | Size of one uploaded file |
| `LIMIT_WORKSPACE_STORAGE_MB` | `20` | Files, page bodies and version history of one workspace |
| `LIMIT_VERSIONS_PER_PAGE` | `10` | Version history kept per page |
| `WORKSPACE_RESTORE_DAYS` | `7` | Days a deleted workspace can be restored |
| `AGENT_UPLOAD_MAX_MB`, `AGENT_UPLOAD_DAILY_MB` | `5`, `10` | Uploads by AI agents: per file, per account per day |
| `DISABLED_FEATURES` | see `demo.env.example` | Features turned off on the whole server |
| `LEGAL_DIR` | `/legal` | The terms folder inside the container (`DEMO_LEGAL_DIR` on the host) |
| `INSTANCE_LABEL` | `Demo` | The label every screen shows |
| `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_KEEP_MONTHLY` | `7`, `0`, `0` | Backup sets kept |

Mail, OIDC, semantic search and experimental features stay off by leaving their variables empty. MCP stays on.

## What the operator should know

### Accounts are really deleted

`ACCOUNT_LIFETIME_DAYS=14` deletes an account, its private pages and files, and the workspaces only it was
in, 14 days after sign-up, whether or not it was used. Backups keep them for up to 7 more days. Accounts
made before the setting was on, and administrators, are never deleted by it.

To see what it would do before it deletes anything, start with `ACCOUNT_LIFETIME_DRY_RUN=1`. The hourly
housekeeping then logs one line per account it would delete (the account id and how many workspaces would
go) and deletes nothing. Once the first accounts pass their date and the log lists exactly those, empty the
value and run `up -d app` again.

### Closing the demo without notice

If you shut the demo down, the privacy policy template promises that the database, the files and the
backups are deleted without delay:

```bash
docker compose --env-file deploy/demo/demo.env -f compose.yaml -f deploy/demo/compose.demo.yaml down -v
```

`down -v` removes the demo's volumes, backups included; the main instance is not touched. Also delete
remote backup copies if `BACKUP_RCLONE_REMOTE` was set, the proxy's access log for the demo host, the
filled terms folder and `demo.env`. If the server stopped suddenly, do this as soon as you can reach it.

### These files are not legal advice

The templates in `deploy/demo/legal/` and this page are a starting point written for one operator's demo,
not legal advice. Read them, adapt them to your situation and your country, and have them checked if you
are unsure. Sentences in the templates that describe what the app does were written for the settings
above; change a setting and you may need to change the text.
