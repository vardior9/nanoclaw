---
name: pr-worktree
description: Check out the session's PR into a local git worktree under /workspace/extra/repos, or move an existing worktree to a new head after a push. Use at the start of every PR review and again whenever a re-review message reports a new head sha.
---

# PR worktree

The host maintains a shared clone per repo under `/workspace/extra/repos/<owner>__<repo>/git` with all branches as `origin/*` and every assigned PR's head at `refs/pr/<n>/head`. Objects are pre-fetched — **never run any git command that touches the network** (`fetch`, `pull`, `push`, `clone`); they will fail and aren't needed.

One command, idempotent (creates the worktree, or moves an existing one to the current head):

```bash
bash /workspace/agent/.agents/skills/pr-worktree/bin/worktree.sh <owner>/<repo> <pr-number>
```

On success it prints two lines:

```
WT=/workspace/extra/repos/<owner>__<repo>/wt/pr-<n>
BARE=/workspace/extra/repos/<owner>__<repo>/git
```

Use `$WT` as the working tree for diffs, greps, and reads (`references/investigation.md` in the pr-review skill), and `$BARE` only when a command needs the shared clone explicitly.

Exit 2 means the repo or PR ref isn't on the mount (host hasn't fetched it) — say so in-thread and stop; do not try to fetch anything yourself.
