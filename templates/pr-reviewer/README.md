# PR reviewer template

One isolated session per GitHub PR, local worktree investigation, GitHub findings, and owner-approved Slack verdicts.

Follow [the setup guide](../../docs/pr-reviewer.md) for bootstrap, personal account configuration, DM wiring, vault access, and a test PR before activation. This template is already included in the fork:

```bash
pnpm run ncl groups create --template pr-reviewer
```

Create a destination named `owner-dm` for the owner's bot DM. The template contains no personal identity; the host uses explicit `PR_SELF_LOGIN`, `PR_OWNER_SLACK_ID`, and `PR_REVIEWS_DM` settings in the ignored `.env`.

The host dispatcher runs every five minutes after activation. The optional `consolidate-memory` task is stamped paused; resume it only after the reviewer works.
