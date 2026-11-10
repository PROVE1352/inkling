# 2342. Rename test: an old-name install upgraded and moved in CI, the same script locally

- Status: Accepted
- Date: 2026-11-10

## Context
The upgrade-path legs (ADR 1052) start containers by hand with `docker run`: they check migrations and
data across releases, not compose, `.env`, volume names, roles or the deploy scripts. The 0.19 rename
(ADR 2340, 2341) is all of those, and its main promise — an old install that upgrades without reading
anything never comes up empty — can only be shown with the old release's own `compose.yaml`.

## Decision
- **`scripts/upgrade-test/rename.sh OLD_TREE NEW_TREE OLD_IMAGE NEW_IMAGE`** builds an install the way a
  production server has it: a copied folder (no `.git`), `.env`, and a `compose.override.yaml` with
  `image: inkling:local` and `pull_policy: never`. It prints PASS/FAIL per step and stops at the first
  FAIL:
  1. the old release on the old names; an account, pages, a comment thread, collection rows
     (`seed-verify.mjs`), an attachment and a share link (`rename-extra.mjs`, kept out of
     `seed-verify.mjs`, which every upgrade leg since v0.1.0 runs against old APIs);
  2. the new files and image with `.env` untouched: `up -d` refuses with the `INKLING_DATA_NAME`
     message with the override, with the Caddy and rclone overlays and with `-p`; `pull` refuses; the
     old containers and volumes are the same and still serve the data;
  3. `INKLING_DATA_NAME=nodian`: the new release on the old data; `deploy/signup-key.sh` works;
  4. `--dry-run` changes nothing (`.env`, volumes, the running app);
  5. the rename: no old name in containers, volumes, networks, roles or databases; the data through the
     API, the attachment's bytes, the share link on `/api/public/<token>` (the `/s/` page answers 200
     even for a dead link), password login, a backup under the new role, `./deploy/backup.sh`;
  6. rollback after a finished rename; runs killed with `SIGKILL` right after the volume copy and right
     after the role rename (`INKLING_RENAME_TEST_KILL`), each run again to the end; a rollback from an
     interrupted run;
  7. a new install from `.env.example`: no old name anywhere; `signup-key.sh`, `reset-password.sh`,
     `cli-token.sh`, `backup.sh` and `restore.sh --dry-run` work.
- **CI**: a `rename` job in `.github/workflows/upgrade.yml`, one leg per old-name release worth
  covering (the newest of each minor that changed `compose.yaml`: v0.16.0 and v0.17.1), separate from
  the per-release `upgrade` matrix that 0.18 extends. Its paths include `compose.yaml`, `deploy/**` and
  `.env.example`.
- **Locally** the same script runs with `FROM`/`TO` set to other names, because a developer machine
  may already run a real `nodian` project (the development database). The old tree's files are
  rewritten to `FROM`; `docker compose config` shows separately that the new file with
  `INKLING_DATA_NAME=nodian` resolves to v0.17.1's names.

## Alternatives considered
- **Extend `run.sh`**: it has no compose, and its matrix is per release; the rename needs one leg per
  `compose.yaml` shape, not per schema.
- **Test the script against a hand-made `nodian` volume**: misses the old file's own behaviour (its
  project name, its healthcheck, its role) and the "upgrade without reading" step.

## References
- scripts/upgrade-test/rename.sh, scripts/upgrade-test/rename-extra.mjs, .github/workflows/upgrade.yml
- ADR 1052 (upgrade-path CI), 2340, 2341
