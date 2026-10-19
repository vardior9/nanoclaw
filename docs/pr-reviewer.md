# PR reviewer setup

Follow this guide when a colleague asks Codex or Claude Code to set up a fresh clone. Use the colleague's accounts and a separate Slack app. The included scheduler is macOS launchd; Linux scheduling is not packaged here.

## 1. Bootstrap this checkout

Run in an interactive terminal from the cloned company fork:

```bash
NANOCLAW_NO_DIAGNOSTICS=1 bash nanoclaw.sh --template-path pr-reviewer --agent-provider codex
```

Choose a **local image build** so the image contains this fork's runtime. Authenticate Codex through the OneCLI vault flow. Select Slack for the reviewer, using its own app with Socket Mode, the Messages tab, message events, and Agents & AI Apps enabled. The Slack setup skill lists the required scopes in `.claude/skills/add-slack/SKILL.md`.

The Slack adapter and Codex provider are already installed in source. Preserve them: do not fetch registry payloads over this fork's files just to configure accounts. The installer may request an upstream remote for other skills; this repository's `origin` can point to the company fork.

The wizard needs terminal input and browser authentication. Coding agents should guide that step and resume configuration after it finishes. Its automatic failure recovery invokes Claude Code; when using only Codex, inspect `logs/setup.log` and the named `logs/setup-steps/` file, fix the demonstrated failure, and rerun the same command.

Verify Docker is running, the host service is healthy, and the selected reviewer group exists:

```bash
gh auth status
gh api user --jq .login
pnpm run ncl groups list
pnpm run ncl groups config get --id <group-id>
```

Record the group ID. If the wizard did not stamp the template, run `pnpm run ncl groups create --template pr-reviewer` while the host is running. Use `groups config update --id <group-id> --provider codex --model <available-model> --effort medium` to select a model available to your account.

## 2. Configure your identities

Copy `.env.example` to `.env` only if `.env` does not exist. Otherwise merge the reviewer settings without overwriting credentials created by setup. Enter tokens through the local installer or a private secret-input UI, never through agent chat or committed files.

| Setting | Value |
| --- | --- |
| `SLACK_BOT_TOKEN` | Your Slack app's bot token, written by Slack setup |
| `SLACK_APP_TOKEN` | Your app's Socket Mode token, written by Slack setup |
| `PR_SELF_LOGIN` | Your GitHub login, matching `gh api user --jq .login` and the reviewer vault credential |
| `PR_OWNER_SLACK_ID` | Your Slack member ID (`U…`), from your Slack profile's **Copy member ID** |
| `PR_REVIEWS_DM` | Your direct-message conversation ID with this bot (`D…`), resolved during first-agent setup |
| `PR_SEARCH_QUERY` | Optional; defaults to `is:pr review-requested:<your-login> org:apiiro state:open` |
| `PR_REVIEWS_CHANNEL` | Optional legacy-thread destination; defaults to `PR_REVIEWS_DM` |
| `CROSS_SESSION_CONTEXT` | `off`, so independent PRs do not inherit sibling conversations |

Use `.claude/skills/init-first-agent/SKILL.md` to resolve your bot DM and seed your owner role. Never reuse another install's IDs. `PR_REVIEWS_DM` is a conversation ID, not your member ID or a public channel ID. If you choose a different GitHub organization, set `PR_SEARCH_QUERY` explicitly.

Optional limits retain their defaults: `PR_BOOTSTRAP_PER_TICK=2`, `PR_MAX_OUTSTANDING_REVIEWS=1`, `MAX_NUDGES=1`, `REMIND_AFTER_HOURS=24`, `MAX_WORKTREES_PER_REPO=6`, `MAX_WORKTREES_TOTAL=20`.

Missing reviewer identities stop dispatch with an actionable error. They never fall back to another person's account or destination. When upgrading an existing install that relied on old personal defaults, explicitly save its current identities and destinations in its ignored `.env` before applying the change.

## 3. Wire the owner DM

Follow `.claude/skills/manage-channels/SKILL.md`. The host must be running for `ncl`. Resolve or create the messaging group for `slack:<your-DM-ID>`, then wire it to the reviewer with:

```bash
pnpm run ncl wirings create --messaging-group-id <dm-messaging-group-id> --agent-group-id <group-id> --session-mode per-thread --threads true --engage-mode pattern --engage-pattern .
```

Use pattern engagement: injected CLI events do not carry Slack's native mention flag. If the wizard already created the wiring, update that wiring using the same policy. Ensure the owner's Slack identity has an owner role and is allowed to access this group. Keep the DM's unknown-sender policy strict.

List destinations and ensure the reviewer's `owner-dm` destination points to this messaging group:

```bash
pnpm run ncl destinations list --agent-group-id <group-id>
pnpm run ncl destinations add --agent-group-id <group-id> --local-name owner-dm --target-type channel --target-id <dm-messaging-group-id>
```

Run `add` only if that name is absent. The template uses `owner-dm` for questions and verdict signals.

## 4. Grant GitHub access and install the dispatcher

Register your GitHub API credential in OneCLI for `api.github.com` and allow the reviewer's vault agent to use it. It needs repository read access and permission to post PR review comments. Match its GitHub identity to `PR_SELF_LOGIN`. The host uses your own `gh` authentication for repository fetches, discovery, and final verdicts. The container uses the vault-backed REST API for findings; it does not need a Git HTTPS credential or network git access.

Add `<absolute-checkout-path>/repos` as a read-write root in `~/.config/nanoclaw/mount-allowlist.json` via `.claude/skills/manage-mounts/SKILL.md`. Then:

```bash
pnpm exec tsx scripts/pr-reviewer/install.ts --group <group-id>
pnpm run ncl groups restart --id <group-id>
```

The installer checks configuration, merges the repository mount, selects fresh/focused turns, disables container `ncl`, caps batches at four and turns at fifteen minutes / 200 tool calls, and keeps only the OneCLI runtime skill alongside the template skills. Model and effort stay as selected. It writes a per-install launchd plist and prints its activation command; it does not load the job.

Restart the host service using the per-install label printed by setup so `.env` changes, including `CROSS_SESSION_CONTEXT=off`, take effect. Avoid generic service labels on machines running more than one install.

## 5. Verify before activation

Keep the launchd dispatcher unloaded until the following checks pass:

1. Run `pnpm exec tsx scripts/pr-reviewer/dispatch.ts --dry-run --once <owner>/<test-repo>#<number>`. It reads GitHub metadata and local state and prints planned actions. It does not post messages, fetch git, or persist review checkpoints; its local overlap lock is created and removed.
2. Run the same command without `--dry-run` on a disposable PR requesting your review. This can post GitHub findings and a Slack question or verdict card. Confirm the fetched checkout matches the PR head, the new session is separate from other PRs, and Slack output reaches your bot DM.
3. Use Hold to confirm the card is handled by the host. On another disposable review, submit an approval and verify GitHub records it as you. Change the PR head before clicking another card and confirm the stale verdict is rejected.
4. Re-request review and confirm it reviews the host-supplied delta. Confirm unrelated commits/comments do not generate review wakes or Slack progress messages.

A build or passing tests alone does not complete this validation. If account permissions, Slack app installation, model authentication, or a test PR are unavailable, report that exact blocker and leave activation pending.

Once verified, review the generated plist and run the exact `launchctl bootstrap` command printed by the installer. Confirm `data/pr-reviewer/last-tick` advances and `logs/pr-dispatch.log` shows completed ticks. Each tick discovers open direct/team review requests, excludes `apiiro-autofix`, prepares refs, dispatches bounded work, sends overdue verdict reminders, and cleans up old worktrees.

Optional: use `pnpm run ncl tasks list --agent-group-id <group-id>` to find and resume the paused `consolidate-memory` task. It wakes only when transferable review notes exist in the group's memory inbox.

## Troubleshooting

Check `logs/pr-dispatch.log` for dispatcher failures and `logs/nanoclaw.error.log` for routing or delivery failures. State is in `data/pr-reviewer/state.json`; repository clones and worktrees are under `repos/`. All are ignored by Git.

The host alerts the configured DM if the dispatcher stops completing ticks for thirty minutes. CLI injection has no routing acknowledgement: a successful socket write alone does not prove a review reached its container. Verify the session and actual Slack/GitHub behavior.

To pause automatic discovery, unload the dispatcher's exact per-install launchd label. The NanoClaw host can stay running. Do not delete state or another installation to debug a fresh setup.

## Repository review methods

Each initial review and re-review explicitly discovers the target checkout's review skills and loads their current prompt and applicable rules. Repository methods supply criteria and verification/refutation work, including claims ledgers; generic diff-only defaults do not truncate those requirements. The reviewer records the loaded paths, selected rules and incomplete checks privately.

The bot retains its exact host SHA, prepared checkout, delta scope, GitHub COMMENT delivery, silent Slack policy and human verdict approval. It does not invoke a repository skill's checkout, report-only wrapper or optional nested finder. A repository rules selector may run only as the inspected read-only version from the host-prepared base commit, never as author-controlled PR code. See [the adoption contract](../templates/pr-reviewer/skills/pr-review/references/repository-method.md).

After updating this template on an existing install, use `pnpm run ncl groups create --template pr-reviewer --id <group-id>` to inspect its update plan, then repeat with `--yes` to apply. Ensure `owner-dm` is registered before adopting the portable template, and restart the reviewer group to refresh its composed instructions and skills. Restart the host separately to load dispatcher code changes.
