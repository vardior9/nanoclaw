# pr-reviewer template

GitHub PR reviewer for the Apiiro org. One Slack thread per PR (thread = session = conversation), local git worktree investigation, owner-gated verdicts, autonomous memory of transferable review lessons.

## Architecture

A host-side dispatcher (`scripts/pr-reviewer/dispatch.ts`, launchd, every 5 min) does everything the model shouldn't burn tokens on: PR discovery (GitHub search), bare-clone + PR-ref fetching under `repos/`, posting one Slack root message per PR in `#or-pr-reviewer`, injecting the kickoff into a fresh per-thread session via `data/cli.sock`, re-review/ping-pong nudges, overdue-verdict reminders, and worktree GC. The agent (this template) reviews one PR per session against a local worktree and posts findings via the GitHub REST API through the OneCLI gateway.

## Stamping

```bash
pnpm run ncl -- groups create --template pr-reviewer
pnpm run ncl -- groups config update --id <gid> --provider codex --model gpt-5.6-sol --effort medium
```

Then: wire `#or-pr-reviewer` per-thread (see docs/pr-reviewer.md), run `scripts/pr-reviewer/install.ts --group <gid>` (RW mount + launchd job), resume the `consolidate-memory` task, and grant the group's OneCLI agent the GitHub PAT secret (NOT the `GitHub Git HTTPS` secret — the container must not do network git).

## Deliberate deviations from upstream

- `container/cli-tools.json` pins `@openai/codex` **0.146.0** (skill's canonical pin is older): ≥0.144 is required for `gpt-5.6-sol`, and 0.146.0 fixes `codex app-server` hanging forever on a rejected ChatGPT websocket (wss 405). Re-running `/add-codex` or `/update-skills` resets this pin — restore it after.
- `container/agent-runner/src/providers/codex.ts` drops the payload's generated-image `file` events (trunk v2.2.0 has no `file` event type; the block didn't typecheck and nothing could consume it). Revisit when trunk grows file events.
