# 1050. Prebuilt multi-arch release images on GHCR, built on native runners

- Status: Accepted
- Date: 2026-11-07

## Context
Every install built the app from source (`docker compose up --build`). The build runs
`pnpm install` and the Vite build of the web app, which needs more memory than a 1 GB server has
and takes many minutes on small ARM instances; on those servers it is slow or fails. ADR 0881 left
image publishing out because no registry or release process existed. Releases are now tagged
(`v0.2.0`, `v0.3.0`, `v0.3.1`; v0.1.0 was released untagged at `9dc9a9b`), and servers run on both
x86-64 and ARM64 (deploy/DEPLOY.md).

## Decision
`.github/workflows/release-image.yml`, on a pushed `v*` tag (and by hand for an existing tag):
- **Registry**: `ghcr.io/prove1352/inkling` (lowercase; GHCR rejects the `PROVE1352` spelling).
  Pushed with the workflow's `GITHUB_TOKEN`; only the `build` and `merge` jobs get
  `packages: write`, everything else is `contents: read`.
- **Tags**: `X.Y.Z` for every release tag; `X.Y` only when the tag is the highest stable release of
  that minor line, `latest` only when it is the highest stable release overall (computed from
  `git tag`), so a late patch of an older line or a manual backfill never moves them. Pre-releases
  (`vX.Y.Z-rc.1`) get `X.Y.Z-rc.1` only. Tags without the `v`, the usual container convention.
- **Architectures**: `linux/amd64` on `ubuntu-24.04` and `linux/arm64` on `ubuntu-24.04-arm`, each
  building natively and pushing by digest; a `merge` job joins the two digests into one manifest list
  with `docker buildx imagetools create` and fails unless both platforms are in it.
- **Same build on both**: `INKLING_BUILD=vX.Y.Z-<sha7>` is passed to both architectures, so the
  build id clients compare (ADR 0990) does not depend on the server's CPU and a re-run of the same tag
  does not announce a new version.
- **Gate**: on a tag push nothing is published unless `upgrade.yml` (ADR 1052) passes for that
  commit. A manual run skips the gate: it is for backfilling releases that already shipped.
- **Labels**: OCI `source`, `version`, `revision`, `licenses` on each image and `source`/`description`
  annotations on the index; `org.opencontainers.image.source` links the package to the repository.
- Actions are pinned by major version, as in ci.yml (Dependabot updates them monthly, ADR 0882).
  Build caches use one GitHub Actions cache scope per architecture.

## Alternatives considered
- **QEMU emulation on one amd64 runner**: one job and no merge step, but `pnpm install` and the Vite
  build under emulation take several times longer than natively, and native modules
  (`@node-rs/argon2`, esbuild, lightningcss, tailwind oxide) run emulated. Native ARM runners are free
  for public repositories.
- **Docker Hub**: needs an account and a secret, and has pull rate limits for anonymous users; GHCR
  works with the built-in token and sits next to the code.
- **`latest` on every stable tag (`docker/metadata-action` `latest=auto`)**: a patch release of an
  older minor line would become `latest`. Computing it from the tag list avoids that.
- **Publishing `main` as `edge`**: untested between releases and would invite running schema
  versions no release supports; left out until someone needs it.
- **Signing / SBOM**: buildx's default provenance attestation is kept; cosign signing is not added yet.

## Trade-offs
- A release takes longer: the upgrade gate (four legs) runs before the image builds.
- `X.Y.Z` tags are mutable in principle (a manual re-run republishes them); they are only re-run for
  a failed or missing publish of the same commit.
- The first package push may create a private package; its visibility has to be set to public once.

## Consequences
- `compose.yaml` can default to the published image (ADR 1051); a 1 GB server only pulls.
- deploy/DEPLOY.md's claim that every image is multi-arch now also holds for the app image.
- Releases for v0.2.0–v0.3.1 can be backfilled from the Actions tab (Release image → Run workflow).
