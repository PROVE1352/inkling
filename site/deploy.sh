#!/usr/bin/env bash
# Build the site and publish site/_site to the gh-pages branch.
#
#   site/deploy.sh               build, commit to gh-pages, push to origin
#   DRY_RUN=1 site/deploy.sh     build and commit, print the commit, do not push
#   ALLOW_WARNINGS=1 ...         publish even if the build reports missing files or anchors
#   REMOTE=origin BRANCH=gh-pages NODE=node   (defaults)
#
# The commit is made in a temporary detached worktree with `git commit-tree`, so the current
# branch, its history, the index and the working tree are never touched, and no local branch is
# created. The first deploy creates gh-pages as an orphan branch; later deploys add one commit on
# top of the remote gh-pages. GitHub Pages: Settings > Pages > Deploy from a branch > gh-pages / (root).
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SITE_DIR" rev-parse --show-toplevel)"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-gh-pages}"
NODE="${NODE:-node}"

major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node 22 or newer is needed (found $("$NODE" -v)); set NODE=/path/to/node" >&2
  exit 1
fi

# 1. Build
if [ "${ALLOW_WARNINGS:-0}" = "1" ]; then
  "$NODE" "$SITE_DIR/build.mjs"
else
  "$NODE" "$SITE_DIR/build.mjs" --strict
fi
OUT="$SITE_DIR/_site"
[ -f "$OUT/index.html" ] || { echo "build produced no $OUT/index.html" >&2; exit 1; }
touch "$OUT/.nojekyll"

SRC_REV="$(git -C "$REPO" rev-parse --short HEAD)"
if [ -n "$(git -C "$REPO" status --porcelain -- site docs 2>/dev/null)" ]; then
  echo "note: site/ or docs/ has uncommitted changes; the published pages include them" >&2
  SRC_REV="$SRC_REV+dirty"
fi

# 2. Temporary worktree on the current gh-pages (or an empty tree for the first deploy)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/inkling-pages.XXXXXX")"
cleanup() {
  git -C "$REPO" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

PARENT=""
if git -C "$REPO" ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  git -C "$REPO" fetch --quiet "$REMOTE" "refs/heads/$BRANCH"
  PARENT="$(git -C "$REPO" rev-parse FETCH_HEAD)"
  git -C "$REPO" worktree add --quiet --detach "$WORK" "$PARENT"
else
  echo "$REMOTE/$BRANCH does not exist yet; creating it as an orphan branch"
  git -C "$REPO" worktree add --quiet --detach --no-checkout "$WORK" HEAD
fi

# 3. Replace the worktree contents with the build output
git -C "$WORK" read-tree --empty
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$OUT"/. "$WORK"/
git -C "$WORK" add --all --force .

TREE="$(git -C "$WORK" write-tree)"
if [ -n "$PARENT" ] && [ "$TREE" = "$(git -C "$REPO" rev-parse "$PARENT^{tree}")" ]; then
  echo "gh-pages is already up to date ($PARENT); nothing to publish"
  exit 0
fi

MSG="Deploy site from $SRC_REV"
if [ -n "$PARENT" ]; then
  COMMIT="$(git -C "$WORK" commit-tree "$TREE" -p "$PARENT" -m "$MSG")"
else
  COMMIT="$(git -C "$WORK" commit-tree "$TREE" -m "$MSG")"
fi
echo "commit $COMMIT: $MSG"

# 4. Push (fast-forward only; rerun if someone else deployed in between)
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1: not pushing. Inspect with: git -C \"$REPO\" show --stat $COMMIT"
  exit 0
fi
git -C "$REPO" push "$REMOTE" "$COMMIT:refs/heads/$BRANCH"
echo "pushed to $REMOTE/$BRANCH"
