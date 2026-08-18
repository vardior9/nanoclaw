# Investigation — local git, and when to look beyond the diff

Everything is local. The `pr-worktree` skill gives you `$WT` (working tree at the PR head) and `$BARE` (the shared clone with `origin/*` branches and `refs/pr/<n>/head`). No tarballs, no contents-API fetches, no `git clone`, and never any git command that touches the network (`fetch`, `pull`, `push`) — objects are pre-fetched by the host.

## Reading the diff

```bash
BASE=$(git -C "$WT" merge-base "origin/<base_ref>" HEAD)
git -C "$WT" diff --stat "$BASE"...HEAD          # shape of the PR
git -C "$WT" diff "$BASE"...HEAD -- <paths>      # per-area, on demand
```

Exclude generated noise from any full-diff read (keep the filenames from `--stat` in view so you can note skipped files):

```bash
git -C "$WT" diff "$BASE"...HEAD -- . \
  ':(exclude)*.lock' ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' \
  ':(exclude)go.sum' ':(exclude)*.min.js' ':(exclude)*.min.css' \
  ':(exclude)*.snap' ':(exclude)*.svg' ':(exclude)dist/**' ':(exclude)vendor/**'
```

A PR over ~1500 diff lines: read `--stat` first, then per-directory or per-file diffs in priority order — never the whole thing in one gulp.

## When to look beyond the diff

Default is diff-only. Go wider **only when a trigger fires** — each names what you're checking, so investigation stays targeted:

- The diff **changes/removes/renames anything referenced outside it** (function, class, exported const, config key, DB field, API route, event name) → `grep -rn` the call sites and verify each still holds.
- A hunk's correctness **depends on unseen code** (a helper whose behavior decides whether this is a bug) → read that file at the relevant lines.
- A **convention question** the hunk context can't answer (where a module belongs, the established error/test pattern) → look at 1–2 sibling examples.
- **Ping-pong pushback** that hinges on code outside the diff → verify before conceding.

Stay diff-only for: docs/comment-only diffs; dependency bumps and lockfiles; bot-authored PRs; self-contained new files with no cross-references; test-only diffs; re-review deltas that directly answer your own comments.

## Budget — hard caps per PR

- ≤ 15 `grep`/`rg`/`find` invocations
- ≤ 20 file reads — read line ranges, never whole files over 400 lines
- History (`git log/blame`) only to settle a specific question, ≤ 3 invocations

Budget exhausted before you're sure → **stop and state it as an open question in the review** ("couldn't verify all call sites of X"). An honestly-flagged unverified concern beats a burned context window.
