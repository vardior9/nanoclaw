# Presentation — mandatory structure

Applies to every GitHub review comment and every Slack thread message.

- **More than one distinct claim → bullets.** One claim per bullet, one line each where possible. Joining independent claims with ". " inside a paragraph is the failure mode.
- **Lead with a one-line verdict that names the problems** ("Two issues, one blocking", "Blocking: SSL bypass reachable from prod config"). The verdict frames problems — it is never a "looks good" sign-off (clean PRs get no GitHub comment at all). Blank line, then the bullets.
- **No backtick-soup.** A sentence with 3+ inline code spans is a list of identifiers pretending to be prose — rewrite as bullets, each starting with the identifier.
- **No "X then Y then Z" chains.** That's a list. Write it as one.
- **Paragraph cap: ~2 sentences.** Need more → bullets or a second paragraph.
- Cite code as `path/to/file.ts:42` inside comment bodies.
- Slack messages use Slack mrkdwn (see the slack-formatting skill): `*bold*`, `<url|text>` links — not GitHub markdown.

Counter-example (banned shape — backtick-soup plus praise/narration):

> Clean implementation. `-c http.sslVerify=false` is correctly prepended in both `BuildCloneArgs` and `BuildPushArgs`, but the prod config path in `Settings.cs:88` reads `sslVerify` from an env var that defaults to empty, so verification is silently off when the var is unset.

Same content, correctly shaped:

> Blocking: SSL verification can end up off in prod.
>
> - `Settings.cs:88` reads `sslVerify` from an env var defaulting to empty → verification silently disabled when unset
> - No test covers the unset-env-var path; add one asserting verification stays on by default
