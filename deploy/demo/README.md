# Demo instance preset

> **Open a public demo for strangers only with 0.22.1 or later, and only with its data on a filesystem of its own**
> ([docs/DEMO.md](../../docs/DEMO.md), step 0). 0.22.0 left problems open for a demo that shares the disk and memory
> of one machine with other services; 0.22.1 fixes them. What is still known:
> [docs/KNOWN-ISSUES.md, "Added in 0.22.1"](../../docs/KNOWN-ISSUES.md#added-in-0221). A demo started with 0.22.0 has
> to be moved first (docs/DEMO.md, "Moving a demo from 0.22.0").
>
> 낯선 사람에게 여는 공개 데모는 0.22.1 이상에서, 데이터를 전용 파일시스템에 두었을 때만 여세요
> ([docs/DEMO.ko.md](../../docs/DEMO.ko.md), 0단계). 아직 알려진 문제는
> [docs/KNOWN-ISSUES.ko.md](../../docs/KNOWN-ISSUES.ko.md#added-in-0221)에 있고, 0.22.0으로 띄운 데모는 먼저 옮겨야
> 합니다(docs/DEMO.ko.md, "0.22.0 데모 옮기기").

Files for running a public demo of Inkling as a separate instance next to your own server, with the
restricted mode of 0.22 switched on. The steps (separate instance, terms, proxy, operator account with the setup link, checks) and what
each setting means are in [docs/DEMO.md](../../docs/DEMO.md) ([한국어](../../docs/DEMO.ko.md)).

| File | What it is |
|---|---|
| `demo.sh` | The only way to run the demo: `config`, `up`, `build` (rebuilds the demo's image), `down` (keeps the data), `destroy` (removes the containers, volumes and image after you type the project name; the files under `DEMO_VOLUME_ROOT` are left for you to delete), `ps`, `logs`, `exec`. Fixed project name `inkling-demo`, nothing taken from the shell, and `up`/`build`/`down`/`destroy` refused unless the resolved project, volumes, network, database, port and image are the demo's; `up` also refuses a `DEMO_VOLUME_ROOT` on the root filesystem, and every check refuses a service without `mem_limit`, an equal `memswap_limit`, `pids_limit` and `cpus` |
| `compose.demo.yaml` | Overlay on `compose.yaml`: the demo's own project, network, volumes and database written out (never read from a variable production also uses), its own image name (`DEMO_IMAGE`), every volume a folder under `DEMO_VOLUME_ROOT` (a filesystem made for the demo), the 0.22 settings passed to the app, the terms folder mounted at `/legal`, no published database port, memory, CPU and process limits with no swap past the memory limit, backups kept 7 days |
| `demo.env.example` | The demo settings. Copy to `demo.env` and fill in the values marked `CHANGE-ME` with new secrets (never production's); `PUBLIC_URL` is the public address from the start |
| `legal/` | Templates of the terms of service, privacy policy (Korean and English) and the sign-up notice and tick boxes (`signup.json`). The documents still contain `{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`, `{{SERVICE_URL}}` and `{{EFFECTIVE_DATE}}`: the server warns at every start until they are filled in |

First mount a filesystem of its own for the demo's data and point `DEMO_VOLUME_ROOT` at it
([docs/DEMO.md](../../docs/DEMO.md), step 0). Deploy the demo from a checkout of its own, not from the folder the
production instance runs in:

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
