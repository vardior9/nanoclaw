---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install NanoClaw, configure it, or go through first-time setup. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# PR reviewer setup

Follow `docs/pr-reviewer.md` for this fork. Start the interactive bootstrap with `NANOCLAW_NO_DIAGNOSTICS=1 bash nanoclaw.sh --template-path pr-reviewer --agent-provider codex` in the operator's terminal, then complete identity configuration, owner-DM wiring, vault access, dispatcher installation, and a disposable test PR.

Slack, Codex, and the reviewer template are already included. Preserve their source files. Codex and Claude Code can both guide setup; automatic installer recovery uses Claude Code. If recovery is unavailable, inspect the named setup-step log and resume the documented flow.

Finish only after the live test PR succeeds and the dispatcher completes a scheduled tick. If external accounts or a test PR are unavailable, report the blocker and leave activation pending.
