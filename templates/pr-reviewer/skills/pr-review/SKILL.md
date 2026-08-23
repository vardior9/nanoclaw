---
name: pr-review
description: Review the GitHub PR assigned to this session — new-PR review, re-review after a push, replying to review-thread comments (ping-pong), and escalating to vardi for the final verdict. Use whenever the session's kickoff message names a PR, or a follow-up message reports a new head sha, new activity, or vardi's verdict reply.
---

# PR review flows

The dispatcher already did discovery: your first message carries the PR (`<owner>/<repo>#<n>`), full URL, title, author, head sha, base ref, and container paths. Never search for PRs yourself, never re-poll. GitHub REST goes through the proxy — **do not set an Authorization header**; the gateway injects the PAT for `api.github.com`.

Pick the flow from the message:

| Message says | Flow |
|---|---|
| New PR assigned | **New PR** |
| New head sha (author pushed) | **Re-review** |
| New activity, same sha (comments) | **Ping-pong** |
| `approve` / `request changes` / `hold` from vardi | **Verdict** |

## New PR

1. Check out the code: follow the `pr-worktree` skill. It gives you a working tree at the PR head plus the base ref locally.
2. `GET /repos/{o}/{r}/pulls/{n}` — capture `additions`, `deletions`, `changed_files`, `body`, `labels[]`, `mergeable_state` (metadata only; the code you already have locally).
3. **Size guard**: `additions+deletions > 2000` or `changed_files > 40` → ask vardi in-thread:
   > PR is too large for a useful full pass (X files, +Y/−Z). (a) high-level pass, (b) most-important files only, or (c) skip?
   Wait for his reply; scope the review accordingly.
4. Read the diff locally (see `references/investigation.md` for the exact git commands, what to exclude, and the investigation budget). Read the repo's own `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md` (root + touched directories) — they are the conventions you review against.
5. Identify problems only: bugs, risks, missing tests, convention violations. For each, anchor to a file + RIGHT-side line number in the PR diff (see `references/github-api.md` for anchoring rules).
6. **No problems** → post nothing on GitHub. Go straight to **Escalate** with recommendation APPROVE.
7. **Problems** → post one review: `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event: "COMMENT"`, inline `comments[]`, `body` empty unless a genuinely PR-wide concern exists (shapes in `references/github-api.md`). Then post an in-thread summary: one verdict line naming the problems, then one bullet per finding (rules in `references/presentation.md`). If nothing blocks, continue to **Escalate**; if blockers exist, end the turn — the author's response comes back as ping-pong or re-review.

## Re-review

Triggered by a message reporting a new head sha.

1. Refresh the worktree (`pr-worktree` skill — it moves the checkout to the new head).
2. `git diff <prev_head>...<new_head>` scoped to what shifted; decide which previous concerns still stand and what's newly introduced. Don't re-investigate settled ground.
3. Comment **only on problems** that remain or are new — never "fixed ✓" acknowledgements; silence on a resolved thread is the acknowledgement. Post as a follow-up `event: "COMMENT"` review, inline only.
4. Apply the persona's Slack notification gate. Post an in-thread findings summary only when the actionable finding set changed. Converged (prior blockers resolved, nothing new) → **Escalate** with recommendation APPROVE only when an equivalent APPROVE request is not already pending in the thread. An unchanged finding set or unchanged pending recommendation completes silently.

## Ping-pong

Triggered by a message reporting new comments without a push.

1. Fetch what's new: `GET /repos/{o}/{r}/issues/{n}/comments?since=<ts>` and `GET /repos/{o}/{r}/pulls/{n}/comments?since=<ts>`; ignore your own (`vardior9`-authored review-bot comments are yours).
2. Pushback that hinges on code → verify in the worktree before conceding or holding your ground. If you've changed your mind, say so plainly.
3. Reply in the same thread: inline → `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies`; conversation-level → `POST /repos/{o}/{r}/issues/{n}/comments`. "Will fix" / acks get no reply.
4. Convergence check: all concerns addressed and no open questions → **Escalate** (APPROVE). Blockers remain and the author acked-but-won't-fix or pushed back unconvincingly → **Escalate** (REQUEST_CHANGES). Still active → post a one-line in-thread note of what you replied and end the turn.

If there is no GitHub reply to make and the actionable state is unchanged, complete silently. Never report that no reply or follow-up was warranted.

## Escalate

Before posting, compare with the whole Slack thread. If the same recommendation, open-thread state, and requested human action are already pending, do not post again. A new head alone does not justify another verdict request.

Post in-thread:

```
<@U010NV4PV29> 🔔 Ready for final verdict
<title>
[<full url>](<full url>)
Author: `<author>`

Recommendation: APPROVE | REQUEST_CHANGES

Why: <one short paragraph>

Open threads: <bullets, or "none">
Diff: <files> files, +<additions>/−<deletions>
```

## Verdict

Only ever in response to vardi's explicit reply in this thread:

- `approve` (+ optional note) → `POST .../reviews` `{"event": "APPROVE", "body": "<note or empty>"}`.
- `request changes` / `changes` (+ optional note) → same endpoint, `event: "REQUEST_CHANGES"`.
- `hold` → acknowledge in one line; wait.
- Anything else → one clarifying question.

After submitting, confirm in-thread — one line: ✅ Submitted as `<verdict>`, then the PR as `[<full url>](<full url>)`, then the backticked author. Then write your memory inbox note if the review taught you something transferable (persona: Memory).

## Edge cases

- **Bot-authored PRs** (dependabot/renovate): review terser — real risk only (breaking changes, CVEs), no nits.
- **Author is vardi**: still review; open with "you authored this — sanity check follows".
- **Your review got dismissed** (`GET .../pulls/{n}/reviews` → `state: "DISMISSED"`): say so in-thread and treat the next event as a fresh look.
- **401/403/app_not_connected from the API**: follow the OneCLI gateway skill — surface the connect URL in-thread once and stop. Stay silent on the same unchanged credential blocker until vardi responds or the error changes.
- **Mid-flow error**: post ⚠️ only when vardi must act. Include the PR as `[<full url>](<full url>)`, the backticked author, and `failed: <reason>` in-thread; don't retry more than once and never repeat an unchanged failure. Transient or self-recoverable failures stay internal.
