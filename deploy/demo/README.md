# Demo instance preset

> **Do not open a public demo for strangers with 0.22.0.** The security review before release left problems open
> for a demo server that shares the disk and memory of one machine with other services; 0.22.1 fixes them. Using
> limits and features turned off on a server for people you know is not affected. Details:
> [docs/KNOWN-ISSUES.md, "Added in 0.22.0"](../../docs/KNOWN-ISSUES.md#added-in-0220).
>
> 0.22.0으로는 낯선 사람에게 여는 공개 데모를 열지 마세요. 데모 서버가 같은 기계의 다른 서비스와 디스크와 메모리를 같이
> 쓸 때의 문제가 남아 있고 0.22.1에서 고칩니다. 아는 사람끼리 쓰는 서버에서 한도와 기능 끄기를 쓰는 것은 해당하지
> 않습니다([docs/KNOWN-ISSUES.ko.md](../../docs/KNOWN-ISSUES.ko.md#added-in-0220)).

Files for running a public demo of Inkling as a separate instance next to your own server, with the
restricted mode of 0.22 switched on. The steps (separate instance, terms, proxy, operator account with the setup link, checks) and what
each setting means are in [docs/DEMO.md](../../docs/DEMO.md) ([한국어](../../docs/DEMO.ko.md)).

| File | What it is |
|---|---|
| `demo.sh` | The only way to run the demo: `config`, `up`, `down` (keeps the data), `destroy` (deletes it after you type the project name), `ps`, `logs`, `exec`. Fixed project name `inkling-demo`, nothing taken from the shell, and `up`/`down`/`destroy` refused unless the resolved project, volumes, network, database and port are the demo's |
| `compose.demo.yaml` | Overlay on `compose.yaml`: the demo's own project, network, volumes and database written out (never read from a variable production also uses), the 0.22 settings passed to the app, the terms folder mounted at `/legal`, no published database port, memory, CPU and process limits, backups kept 7 days |
| `demo.env.example` | The demo settings. Copy to `demo.env` and fill in the values marked `CHANGE-ME` with new secrets (never production's); `PUBLIC_URL` is the public address from the start |
| `legal/` | Templates of the terms of service, privacy policy (Korean and English) and the sign-up notice and tick boxes (`signup.json`). The documents still contain `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`, `{{SERVICE_URL}}` and `{{EFFECTIVE_DATE}}`: the server warns at every start until they are filled in |

Deploy the demo from a checkout of its own, not from the folder the production instance runs in:

```bash
cp deploy/demo/demo.env.example deploy/demo/demo.env
openssl rand -base64 32    # once each for DEMO_POSTGRES_PASSWORD and DEMO_APP_SECRET_KEY
deploy/demo/demo.sh config
deploy/demo/demo.sh up
```

Never run `docker compose` with `compose.demo.yaml` yourself: the overlay stops without the script, and a
shell with production's `COMPOSE_PROJECT_NAME` would still name the project. `demo.env` holds secrets; keep
it out of version control.

`LEGAL_DIR` on a server other than this demo: `compose.yaml` passes the variable, but the folder must be
mounted into the container as well, as `compose.demo.yaml` does (`volumes: - <host folder>:/legal:ro` with
`LEGAL_DIR=/legal`).

The templates are a starting point, not legal advice.
