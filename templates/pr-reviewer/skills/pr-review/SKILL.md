---
name: pr-review
description: "Review the PR identified by the current host event: initial review, exact-head re-review, or bounded response to new external activity."
---

# PR review

The host already selected the PR and prepared its local refs. Never discover or poll PRs. GitHub REST goes through the proxy; never add an Authorization header.

Choose the flow from the host event:

| Event                   | Scope                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| New PR                  | Full diff against the named base                                                      |
| New head                | Only the host-listed old-to-new commit delta, plus listed unresolved reviewer threads |
| New activity, same head | Only the host-listed external comments/reviews and the code needed to verify them     |

## Initial review

1. Run the `pr-worktree` skill and read repository instructions in scope.
2. Use the supplied PR metadata. Fetch extra GitHub metadata only if necessary to decide a finding.
3. If the PR exceeds 2,000 changed lines or 40 files, ask Vardi once to choose full, high-value-files, or skip scope.
4. Investigate locally using `references/investigation.md`. Trace only as far as needed to prove or dismiss concrete risks.
5. Post problems in one `COMMENT` review using `references/github-api.md`. Clean means no GitHub review.
6. If blockers remain, stop silently. If the review converged, emit the final-verdict signal.

## Re-review

1. Refresh the worktree to the supplied new head.
2. Review only the supplied old-to-new delta. Re-check the supplied unresolved reviewer threads against changed code; do not reconstruct or reread the original full review.
3. Post only remaining or new problems. Do not acknowledge fixes.
4. If blockers remain, stop silently. If converged, emit one final-verdict signal for the new exact head.

## New activity

1. Work from the host-supplied external activity list; do not refetch all PR discussion.
2. Verify code-dependent pushback locally. Reply in the same GitHub thread when warranted; acknowledgements need no reply.
3. If the actionable state is unchanged, stop silently. If converged, emit the final-verdict signal.

## Final-verdict signal

The model recommends; the host acts. Never call GitHub with `APPROVE` or `REQUEST_CHANGES`, even if a Slack message contains those words.

Emit exactly this as the only visible output, with compact evidence and the exact 40-character head SHA supplied by the host:

```text
PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"<40-char sha>"}
<@U010NV4PV29> 🔔 Ready for final verdict
<title>
[<full url>](<full url>)
Author: `<author>`

Recommendation: APPROVE
Why: <one short paragraph>
Open threads: <bullets or "none">
Diff: <files> files, +<additions>/−<deletions>
```

`recommendation` may instead be `REQUEST_CHANGES`. Do not emit a second signal for the same head and actionable state. The marker is intercepted and rendered as a Slack card; users never type a verdict, and the model never receives the click.

## Failures and memory

Surface an error only when Vardi must act; include the linked PR, backticked author, and one concrete action. Transient failures stay internal. Retry at most once.

If this review produced a transferable lesson, write the concise inbox note required by the persona before completing.
