# PR Reviewer

A personal GitHub PR reviewer for Apiiro engineers, built on [NanoClaw](https://github.com/nanocoai/nanoclaw). Each engineer runs their own instance with their own GitHub identity and Slack app.

The host finds PRs requesting your review, prepares a local checkout, and starts an isolated agent session per PR. The agent posts actionable findings on GitHub. When a review converges, you get a Slack card to approve, request changes, or hold. The host checks that the reviewed commit is still current before submitting your choice.

## Set up with an agent

Clone **this company fork**, then open Codex or Claude Code in the checkout and ask:

> Help me set up this PR reviewer. Follow docs/pr-reviewer.md, use my accounts, and verify one test PR before enabling automatic reviews.

Both agents read the same repository instructions: `AGENTS.md` links to `CLAUDE.md`, and `.agents/skills` links to `.claude/skills`. Setup starts with:

```bash
NANOCLAW_NO_DIAGNOSTICS=1 bash nanoclaw.sh --template-path pr-reviewer --agent-provider codex
```

This command disables upstream setup telemetry for that run. Run the interactive installer in your terminal. Your coding agent can guide the account setup and finish the reviewer configuration using the [setup guide](docs/pr-reviewer.md). Setup recovery built into the installer uses Claude Code; a Codex session can inspect the same logs when Claude Code is unavailable.

You need:

- macOS for the included launchd scheduler; Docker Desktop running.
- Git and authenticated [GitHub CLI](https://cli.github.com/), with access to the repositories you review and `read:org` for team requests.
- A Codex account or API credential, stored through the installer's OneCLI vault flow.
- Your own Slack app with Socket Mode and Agents & AI Apps enabled, installed in your workspace. App creation or installation may require a workspace administrator.

Node.js 20+ and pnpm are bootstrapped by the installer. The Slack adapter, Codex provider, and reviewer template are already included in this fork. The included reviewer setup targets Codex; using Claude Code to guide installation does not change the runtime provider.

## Behavior

- New requests and explicit re-requests trigger review; commits and comments are checkpointed silently.
- Findings go to GitHub. Slack is reserved for questions requiring your input and the final verdict card.
- The model recommends a verdict. Your card click authorizes the host to submit it against the exact reviewed commit.
- Each review starts with fresh model context. Shared memory keeps transferable lessons, with optional daily consolidation.
- Repository clones, messages, credentials, and review state belong to your installation and are ignored by Git.

The reviewer can post GitHub `COMMENT` reviews while it investigates. Use a disposable test PR for the first live run. It runs code with access to mounted repository checkouts and sends review context to the configured model provider; give it only the repositories and credentials you intend it to use.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm exec tsc -p scripts/pr-reviewer/tsconfig.json --noEmit
pnpm test
cd container/agent-runner && bun install --frozen-lockfile && bun test
```

The [setup guide](docs/pr-reviewer.md) includes validation, activation, and troubleshooting. The inherited NanoClaw architecture is documented in [docs/architecture.md](docs/architecture.md); contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Upstream and license

This fork includes NanoClaw plus the PR dispatcher, Slack verdict handling, and reviewer template. Upstream NanoClaw supports additional channels and providers through skills; those are outside the reviewer setup path.

[MIT](LICENSE). Original NanoClaw attribution and license are retained.
