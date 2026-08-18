#!/usr/bin/env bash
# Idempotent PR worktree: create at refs/pr/<n>/head, or move an existing
# worktree to that ref (host may have fetched a newer head since creation).
# Usage: worktree.sh <owner>/<repo> <pr-number>
# Prints: WT=<worktree path> and BARE=<bare clone path>. Exit 2 = repo/ref
# not present on the mount (host hasn't fetched it) — caller must not fetch.
set -euo pipefail

REPOS_ROOT="${REPOS_ROOT:-/workspace/extra/repos}"

[ $# -eq 2 ] || { echo "usage: worktree.sh <owner>/<repo> <pr-number>" >&2; exit 1; }
SLUG="${1/\//__}"
N="$2"
BARE="$REPOS_ROOT/$SLUG/git"
WT="$REPOS_ROOT/$SLUG/wt/pr-$N"
REF="refs/pr/$N/head"

# The clone is host-owned; without this every git call fails on "dubious ownership".
git config --global --get-all safe.directory 2>/dev/null | grep -qx '\*' \
  || git config --global --add safe.directory '*'

[ -d "$BARE" ] || { echo "no clone for $1 at $BARE" >&2; exit 2; }
git -C "$BARE" rev-parse --verify --quiet "$REF" >/dev/null \
  || { echo "no $REF in $BARE" >&2; exit 2; }

if [ -d "$WT" ] && git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$WT" checkout --quiet --detach "$REF"
else
  # A leftover dir that isn't a functioning worktree blocks `worktree add`.
  rm -rf "$WT"
  git -C "$BARE" worktree prune
  mkdir -p "$(dirname "$WT")"
  git -C "$BARE" worktree add --quiet --detach "$WT" "$REF"
fi

echo "WT=$WT"
echo "BARE=$BARE"
