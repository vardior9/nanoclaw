import { containerBarePath, containerWorktreePath, type PrDetail } from './lib.js';

const SLACK_NOTIFICATION_GATE =
  'Slack is silent by default. Do the review and GitHub writes without a Slack reply. ' +
  'Send Slack only if the owner personally must decide or act before you can proceed or the PR is ready for its single final-verdict request. ' +
  'Findings and finding changes are GitHub-only.';

const REPOSITORY_METHOD_GATE =
  'Before investigating, complete pr-review/references/repository-method.md against the exact host head. ' +
  'Discover review skills in the target checkout under both .agents/skills and .claude/skills; ' +
  'read and apply their current referenced review prompt, applicable rule selector and rules. ' +
  'Adopt repository review criteria and verification/refutation methods, including its claims ledger; ' +
  "retain this bot's prepared checkout, event scope, COMMENT posting, silent Slack policy and human verdict approval. " +
  'Do not invoke repository checkout, report-only delivery or nested-agent orchestration.';

export function formatKickoffMessage(owner: string, repo: string, pr: PrDetail, wakeId: string): string {
  return [
    `Reviewer wake id: ${wakeId}`,
    `New PR ready for review: ${pr.html_url}`,
    `owner/repo: ${owner}/${repo}`,
    `PR number: ${pr.number}`,
    `title: ${pr.title}`,
    `author: ${pr.user.login}`,
    `head sha: ${pr.head.sha}`,
    `base ref: ${pr.base.ref}`,
    `PR description (claims to verify): ${pr.body ?? '(no description)'}`,
    `bare clone (host clone of the repo, no PR checked out): ${containerBarePath(owner, repo)}`,
    `expected worktree path for this PR (create it if missing): ${containerWorktreePath(owner, repo, pr.number)}`,
    '',
    'This is a fresh session with no other context. Follow your pr-review skill to check out ' +
      'the PR (creating the worktree above from the bare clone if it does not exist yet) and review it.',
    REPOSITORY_METHOD_GATE,
    SLACK_NOTIFICATION_GATE,
  ].join('\n');
}

export function formatReReviewMessage(
  owner: string,
  repo: string,
  pr: PrDetail,
  deltaContext: string,
  unresolvedContext: string,
  wakeId: string,
): string {
  return formatContinuation(
    `Review re-requested on ${owner}/${repo}#${pr.number} — head is now ${pr.head.sha}.`,
    owner,
    repo,
    pr,
    deltaContext,
    unresolvedContext,
    wakeId,
  );
}

export function formatOwnerReplyMessage(
  owner: string,
  repo: string,
  pr: PrDetail,
  deltaContext: string | null,
  unresolvedContext: string,
  wakeId: string,
): string {
  return [
    formatContinuation('Owner reply for this PR.', owner, repo, pr, deltaContext, unresolvedContext, wakeId),
    'Use pr-review to continue the outstanding review at the exact host head above. The owner’s instruction answers any scope question it addresses, so apply that scope without asking again.',
    'Use the initial-review workflow for review work still outstanding. Use the re-review workflow to reconcile prior findings against any supplied delta and unresolved threads.',
    '',
    'Owner’s instruction for this PR:',
  ].join('\n');
}

function formatContinuation(
  event: string,
  owner: string,
  repo: string,
  pr: PrDetail,
  deltaContext: string | null,
  unresolvedContext: string,
  wakeId: string,
): string {
  return [
    `Reviewer wake id: ${wakeId}`,
    event,
    `owner/repo: ${owner}/${repo}`,
    `PR number: ${pr.number}`,
    `head sha: ${pr.head.sha}`,
    `Refresh the existing worktree locally at ${containerWorktreePath(owner, repo, pr.number)} from the host-prepared bare clone ${containerBarePath(owner, repo)}; never fetch or merge.`,
    `base ref: ${pr.base.ref}`,
    `PR description (claims to verify): ${pr.body ?? '(no description)'}`,
    REPOSITORY_METHOD_GATE,
    '',
    'This is a fresh model thread. The host-calculated continuation context below is authoritative; do not search old model transcripts.',
    ...(deltaContext === null ? [] : ['', deltaContext]),
    '',
    'Unresolved review threads opened by this reviewer:',
    unresolvedContext,
    '',
    SLACK_NOTIFICATION_GATE,
  ].join('\n');
}
