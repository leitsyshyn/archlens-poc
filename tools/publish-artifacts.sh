#!/usr/bin/env bash
# Publishes a directory to the throw-away `poc-artifacts` branch so images can be referenced by raw URL.
# Usage: tools/publish-artifacts.sh <src dir> <dest path inside branch> <commit message>
# Paths always contain the commit sha, so GitHub's image proxy (camo) never serves a stale file.
set -euo pipefail
SRC="$(cd "$1" && pwd)"; DEST="$2"; MSG="$3"
REMOTE="${ARTIFACTS_REMOTE:-$(git remote get-url origin)}"
BRANCH=poc-artifacts
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -c init.defaultBranch=$BRANCH init -q "$WORK"
cd "$WORK"
git remote add origin "$REMOTE"
git config user.name "archlens-poc"
git config user.email "145194518+leitsyshyn@users.noreply.github.com"
for attempt in 1 2 3 4 5; do
  if git fetch -q --depth 1 origin "$BRANCH" 2>/dev/null; then git checkout -q -B $BRANCH FETCH_HEAD; else git checkout -q --orphan $BRANCH; fi
  mkdir -p "$DEST"
  cp -R "$SRC"/. "$DEST"/
  git add -A
  git commit -q -m "$MSG" || { echo "nothing to publish"; exit 0; }
  if git push -q origin "$BRANCH" 2>/dev/null; then echo "published $DEST"; exit 0; fi
  echo "push raced (attempt $attempt), retrying"; sleep $((attempt * 2))
  git checkout -q --detach; git branch -q -D $BRANCH || true
done
echo "could not publish artifacts" >&2; exit 1
