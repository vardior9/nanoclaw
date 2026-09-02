# PR Reviewer — host-side dispatcher

Automates the token-costly bookkeeping around reviewing PRs requesting
`vardior9`'s review in the `apiiro` org, so the agent container is only woken
for actual review work. Runs as a **single-tick script on a 5-minute launchd
timer** (`StartInterval 300`) — not a daemon.

## What it does each tick

1. **Discovery** — `gh search/issues` for open PRs requesting review from
   `vardior9` in `org:apiiro`, minus anything labeled `apiiro-autofix`.
2. **New PR** — ensures a bare clone, fetches the PR's head + base refs, and
   injects a silent kickoff into a synthetic per-PR session. Slack materializes
   only when a human question or final-verdict card is emitted.
3. **Known PR** — detects new pushes (re-review), new activity without a
   push (fresh exact-delta re-review), external activity (fresh bounded
   ping-pong context), overdue verdicts (one plain Slack reminder, no model
   involvement), and closed/merged/review-request-cleared PRs (silent
   worktree cleanup + state drop).
4. **GC** — LRU-evicts worktree checkouts over `MAX_WORKTREES_PER_REPO` /
   `MAX_WORKTREES_TOTAL` (worktrees are cheap to recreate from the bare
   clone, so this is safe even for a PR still under review).

State lives at `data/pr-reviewer/state.json` (gitignored, single writer —
this script only). An mkdir-based lock at `data/pr-reviewer/dispatch.lock`
keeps overlapping launchd ticks from racing; a lock older than 15 minutes is
treated as stale and broken.

## Files

| Path                                              | Purpose                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scripts/pr-reviewer/lib.ts`                      | Shared helpers: config, state I/O, lock, `gh`/`git` wrappers, Slack Web API calls, CLI-socket injection |
| `scripts/pr-reviewer/dispatch.ts`                 | The tick itself — run by launchd                                                                        |
| `scripts/pr-reviewer/install.ts`                  | One-time idempotent installer (mount + launchd plist)                                                   |
| `scripts/pr-reviewer/tsconfig.json`               | Standalone typecheck project (root `tsconfig.json` only covers `src/`)                                  |
| `launchd/com.nanoclaw.pr-dispatch.plist.template` | Rendered by `install.ts` into `~/Library/LaunchAgents/`                                                 |

## Prerequisites

- `gh` CLI installed and authenticated as the host operator (`gh auth
status`) — the dispatcher never uses a token from anywhere else.
- `SLACK_BOT_TOKEN` in `.env`, with the bot in `#or-pr-reviewer` and the
  `channels:history` / `groups:history` scopes needed for
  `conversations.replies`.
- An agent group already wired to the `#or-pr-reviewer` Slack channel (via
  `/manage-channels`), with an engage mode that doesn't require a
  platform-native mention — injected CLI events never set `isMention`, so a
  `mention`/`mention-sticky` wiring would silently drop the kickoff message
  on the first message of each new thread. Use `pattern` engagement (e.g.
  pattern `.`) for this wiring.
- The mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) already
  containing a read-write root for `<install root>/repos` — `install.ts`
  checks this and prints the exact JSON to add; it never edits the file
  itself.

## Config (`.env`, all optional — defaults shown)

```
PR_SEARCH_QUERY=is:pr review-requested:vardior9 org:apiiro state:open
PR_REVIEWS_CHANNEL=C0BR29QUFEG
PR_OWNER_SLACK_ID=U010NV4PV29
PR_SELF_LOGIN=vardior9
MAX_NUDGES=1
REMIND_AFTER_HOURS=24
PR_BOOTSTRAP_PER_TICK=2
MAX_WORKTREES_PER_REPO=6
MAX_WORKTREES_TOTAL=20
```

`PR_SELF_LOGIN` is the GitHub identity shared by the human owner and the
reviewer's PAT. Activity authored only by this login since the last baseline
(i.e. the agent's own review posts) advances `last_seen_updated_at` silently
instead of waking the agent — otherwise every review the agent posts would
cost one no-op model turn on the next tick. Side effect: comments the owner
makes directly on GitHub (rather than in the Slack thread) don't wake the
agent either.

The dispatcher only sends an overdue reminder when the latest bot message is
an actual `Ready for final verdict` card. Routine lifecycle changes are logged
and cleaned up without another Slack reply. Findings and finding changes stay
on GitHub; review progress, CI, and polling complete silently.

Every reviewer and memory-consolidation batch starts a fresh Codex thread. A
re-review does not reconstruct chat history: the host deterministically supplies
the old/new SHA delta and unresolved reviewer-owned GitHub threads. Same-head
activity wakes include only external items since the last checkpoint.

## Slack agent-session titles and resolution

The Slack agent session's title is fixed the moment the session is created —
`agents.sessions.setStatus` accepts a `title` only on the creating call and
silently ignores it afterwards (it echoes the original back), and Slack rewrites
characters it dislikes (`apiiro/lim#48766` is stored as `apiiro_lim_48766`). So
the title identifies the PR and never carries review state: it is composed as
`<repo> <number> <PR subject>`, reduced to the characters Slack keeps verbatim
(`src/modules/pr-reviewer-agent-sessions/index.ts`). The subject comes from
`pr_title` on each `state.json` entry — the dispatcher is the only host-side
component that knows it, and entries written before that field existed fall
back to `<repo> <number>`.

The agent emits a recommendation marker, which delivery replaces with a Slack
card. Button clicks are consumed by the host and never become model input. The
host re-reads GitHub's current head, compares it with the stored reviewed SHA,
and only then submits `APPROVE` or `REQUEST_CHANGES` with `gh`. A stale click is
rejected and waits for the dispatcher's fresh re-review. Successful submission
gets one host-written receipt and moves the session to `closed` (approval) or
`active` (changes requested).

## Install

```
pnpm exec tsx scripts/pr-reviewer/install.ts --group <agent_group_id>
```

Prints a `launchctl bootstrap` command at the end — run it yourself once
you've reviewed the generated plist at
`~/Library/LaunchAgents/com.nanoclaw.pr-dispatch.<install-slug>.plist`:

```
launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/com.nanoclaw.pr-dispatch.<slug>.plist
```

Re-running `install.ts` is safe. It also enforces the reviewer runtime profile:
Sol/medium is left untouched, continuation is fresh, context is focused, `ncl`
is disabled, batches are capped at four, and only the OneCLI gateway runtime
skill is enabled alongside the template's two reviewer skills.

## Debugging

```
# See planned actions without touching Slack/GitHub/git/state
pnpm exec tsx scripts/pr-reviewer/dispatch.ts --dry-run

# Force one PR through the full pipeline regardless of discovery
pnpm exec tsx scripts/pr-reviewer/dispatch.ts --once apiiro/some-repo#123
```

Logs: `logs/pr-dispatch.log` (both stdout and stderr — launchd routes both
there per the plist). A tick's own failures are never posted to Slack (to
avoid a posting loop on a systemic failure); check this log first.

## Cutover from the old install (`~/nanoclaws/pr-reviewer`)

Ordered — Slack delivers to exactly one place, so the Socket Mode flip is the
switch:

1. Verify this install end-to-end first (dispatcher `--dry-run`, a `--once`
   pass on `apiiro/test-repo`, container worktree smoke test).
2. Stop the old install: `launchctl bootout gui/$(id -u)/com.nanoclaw` and
   leave its files untouched for a rollback week.
3. In the Slack app config (api.slack.com/apps): Basic Information →
   App-Level Tokens → generate a token with `connections:write` (starts
   `xapp-`); put it in this install's `.env` as `SLACK_APP_TOKEN`. Then
   Socket Mode → Enable. From this moment the old webhook stops receiving.
4. Restart this install:
   `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-624103da`.
5. Load the dispatcher:
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.pr-dispatch.624103da.plist`.
6. The ngrok tunnel for the old webhook is no longer needed.

## Known limitations / things to watch

- CLI-socket injection (`data/cli.sock`, `src/channels/cli.ts`'s admin
  `to`-routed wire format) has no application-level acknowledgement — a
  successful write only means the socket accepted the line, not that
  routing/access checks passed inside the host. If a kickoff or re-review
  message silently never reaches a thread, check `logs/nanoclaw.error.log`
  on the host side, not this script's log.
- The "new activity" detection needs a per-PR `last_seen_updated_at`
  timestamp beyond the four fields sketched in the original design note —
  it's stored as an extra field on each `state.json` entry.
