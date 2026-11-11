# Demo instance preset

Files for running a public demo of Inkling as a separate instance next to your own server, with the
restricted mode of 0.22 switched on. The steps (separate instance, terms, proxy, operator account with the setup link, checks) and what
each setting means are in [docs/DEMO.md](../../docs/DEMO.md) ([한국어](../../docs/DEMO.ko.md)).

| File | What it is |
|---|---|
| `compose.demo.yaml` | Overlay on `compose.yaml`: its own project, network and volumes, the 0.22 settings passed to the app, the terms folder mounted at `/legal`, no published database port, memory, CPU and process limits, backups kept 7 days |
| `demo.env.example` | The demo settings. Copy to `demo.env` and fill in the values marked `CHANGE-ME`; `PUBLIC_URL` is the public address from the start |
| `legal/` | Templates of the terms of service, privacy policy (Korean and English) and the sign-up notice and tick boxes (`signup.json`). The documents still contain `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`, `{{SERVICE_URL}}` and `{{EFFECTIVE_DATE}}`: the server warns at every start until they are filled in |

```bash
cp deploy/demo/demo.env.example deploy/demo/demo.env
docker compose --env-file deploy/demo/demo.env -f compose.yaml -f deploy/demo/compose.demo.yaml up -d
```

Run it from the repository root and always with `--env-file deploy/demo/demo.env`: without it the overlay
refuses to start. `demo.env` holds secrets; keep it out of version control.

`LEGAL_DIR` on a server other than this demo: `compose.yaml` passes the variable, but the folder must be
mounted into the container as well, as `compose.demo.yaml` does (`volumes: - <host folder>:/legal:ro` with
`LEGAL_DIR=/legal`).

The templates are a starting point, not legal advice.
