# GitHub REST — auth, endpoints, line anchoring

## Auth

All calls go to `https://api.github.com` through the proxy. **Never set an Authorization header** — the OneCLI gateway injects the PAT (scopes: contents read, PRs read+write, metadata read, statuses read). On `401`/`403`/`app_not_connected`, follow the onecli-gateway skill: surface the connect URL in-thread and stop. When `X-RateLimit-Remaining < 100`, postpone non-essential calls and say so in-thread.

Code access is **never** via the API — you have the worktree. The API is for PR metadata, reviews, and comment threads only.

## Endpoints

```bash
# Metadata (size guard, labels, body, author)
curl -s https://api.github.com/repos/{o}/{r}/pulls/{n}

# Post a review with inline comments (the ONLY way you post findings)
curl -s -X POST https://api.github.com/repos/{o}/{r}/pulls/{n}/reviews \
  -H 'Content-Type: application/json' -d '{
  "body": "",
  "event": "COMMENT",
  "comments": [
    { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}'
# Multi-line span: add "start_line" + "start_side".
# APPROVE / REQUEST_CHANGES only from the Verdict flow, never here.

# Comment threads
curl -s 'https://api.github.com/repos/{o}/{r}/issues/{n}/comments?since=<ISO ts>'
curl -s 'https://api.github.com/repos/{o}/{r}/pulls/{n}/comments?since=<ISO ts>'
curl -s -X POST https://api.github.com/repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies \
  -H 'Content-Type: application/json' -d '{"body": "..."}'
curl -s -X POST https://api.github.com/repos/{o}/{r}/issues/{n}/comments \
  -H 'Content-Type: application/json' -d '{"body": "..."}'

# Review states (dismissal detection)
curl -s https://api.github.com/repos/{o}/{r}/pulls/{n}/reviews
```

## Line anchoring

`line`/`side` refer to positions in the PR's unified diff. Generate the authoritative hunks locally:

```bash
git -C "$WT" diff "$BASE"...HEAD -- <file>
```

Each `@@ -A,B +C,D @@` header anchors a hunk: `+` lines map to RIGHT side counting from `C`, `-` lines to LEFT counting from `A`, context lines advance both. Use RIGHT-side numbers for comments on added/changed lines; LEFT only for pure deletions. A comment on a line **outside any hunk of that file's PR diff is rejected by the API** — if a finding concerns unchanged code, attach it to the nearest changed line that motivates it and name the real location in the body (`path/to/file.ts:42`).
