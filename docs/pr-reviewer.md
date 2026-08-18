# PR Reviewer — host-side dispatcher

Automates the token-costly bookkeeping around reviewing PRs requesting
`vardior9`'s review in the `apiiro` org, so the agent container is only woken
for actual review work. Runs as a **single-tick script on a 5-minute launchd
timer** (`StartInterval 300`) — not a daemon.

## What it does each tick

1. **Discovery** — `gh search/issues` for open PRs requesting review from
   `vardior9` in `org:apiiro`, minus anything labeled `apiiro-autofix`.
2. **New PR** — posts a root Slack message in `#or-pr-reviewer`, ensures a
   bare clone of the repo, fetches the PR's head + base refs, and injects a
   kickoff message into NanoClaw (via the CLI channel's admin socket) so a
   fresh per-thread session spawns to review it.
3. **Known PR** — detects new pushes (re-review), new activity without a
   push (ping-pong nudge), overdue verdicts (plain Slack reminder, no model
   involvement), and closed/merged/review-request-cleared PRs (closing line
   + worktree cleanup + state drop).
4. **GC** — LRU-evicts worktree checkouts over `MAX_WORKTREES_PER_REPO` /
   `MAX_WORKTREES_TOTAL` (worktrees are cheap to recreate from the bare
   clone, so this is safe even for a PR still under review).

State lives at `data/pr-reviewer/state.json` (gitignored, single writer —
this script only). An mkdir-based lock at `data/pr-reviewer/dispatch.lock`
keeps overlapping launchd ticks from racing; a lock older than 15 minutes is
treated as stale and broken.

## Files

| Path | Purpose |
|------|---------|
| `scripts/pr-reviewer/lib.ts` | Shared helpers: config, state I/O, lock, `gh`/`git` wrappers, Slack Web API calls, CLI-socket injection |
| `scripts/pr-reviewer/dispatch.ts` | The tick itself — run by launchd |
| `scripts/pr-reviewer/install.ts` | One-time idempotent installer (mount + launchd plist) |
| `scripts/pr-reviewer/tsconfig.json` | Standalone typecheck project (root `tsconfig.json` only covers `src/`) |
| `launchd/com.nanoclaw.pr-dispatch.plist.template` | Rendered by `install.ts` into `~/Library/LaunchAgents/` |

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
MAX_NUDGES=3
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

Re-running `install.ts` is safe — every step (repos/ dir, mount merge,
plist write) is idempotent.

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
