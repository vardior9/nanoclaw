/**
 * scripts/pr-reviewer/dispatch.ts — single-tick PR review dispatcher.
 *
 * Run by launchd every 5 minutes (StartInterval 300; see install.ts). Not a
 * daemon — this process runs one tick and exits. All the token-costly work
 * (discovery, git plumbing, Slack bookkeeping, reminders) happens here so
 * the agent container is only ever woken for review work.
 *
 * Usage:
 *   pnpm exec tsx scripts/pr-reviewer/dispatch.ts [--dry-run] [--once <owner>/<repo>#<n>]
 *
 * A top-level failure is never surfaced to Slack (would risk a posting
 * loop on a systemic failure) — it goes to stderr, which launchd redirects
 * to logs/pr-dispatch.log.
 */
import fs from 'fs';
import path from 'path';

import {
  type Config,
  type PrDetail,
  type PrRef,
  type PrState,
  type StateFile,
  REPOS_ROOT,
  acquireLock,
  containerBarePath,
  containerWorktreePath,
  ensureBareClone,
  fetchPrRefs,
  getBotUserId,
  getPrDetail,
  getThreadReplies,
  hasForeignActivity,
  injectCliEvent,
  loadConfig,
  loadState,
  parsePrKey,
  postRootMessage,
  postThreadMessage,
  prKey,
  releaseLock,
  removeWorktreeAndPrune,
  repoPaths,
  saveState,
  searchOpenPRs,
} from './lib.js';

interface Args {
  dryRun: boolean;
  once: string | null;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let once: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--once') once = argv[++i] ?? null;
  }
  return { dryRun, once };
}

interface TickCtx {
  cfg: Config;
  args: Args;
  state: StateFile;
  bootstrapCount: number;
  failedRepoClones: Set<string>;
}

function repoLogKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function formatRootMessage(owner: string, repo: string, pr: PrDetail): string {
  return (
    `*<${pr.html_url}|${owner}/${repo}#${pr.number}: ${pr.title}>*\n` +
    `Author: ${pr.user.login}  |  +${pr.additions}/-${pr.deletions}  |  ${pr.changed_files} files`
  );
}

function formatKickoffMessage(owner: string, repo: string, pr: PrDetail): string {
  return [
    `New PR ready for review: ${pr.html_url}`,
    `owner/repo: ${owner}/${repo}`,
    `PR number: ${pr.number}`,
    `title: ${pr.title}`,
    `author: ${pr.user.login}`,
    `head sha: ${pr.head.sha}`,
    `base ref: ${pr.base.ref}`,
    `bare clone (host clone of the repo, no PR checked out): ${containerBarePath(owner, repo)}`,
    `expected worktree path for this PR (create it if missing): ${containerWorktreePath(owner, repo, pr.number)}`,
    '',
    'This is a fresh session with no other context. Follow your pr-review skill to check out ' +
      'the PR (creating the worktree above from the bare clone if it does not exist yet) and review it.',
  ].join('\n');
}

function formatReReviewMessage(owner: string, repo: string, pr: PrDetail): string {
  return [
    `New commits pushed to ${owner}/${repo}#${pr.number} — head is now ${pr.head.sha}.`,
    `Re-fetch into the existing worktree at ${containerWorktreePath(owner, repo, pr.number)} (bare clone: ${containerBarePath(owner, repo)}) and re-review.`,
  ].join('\n');
}

function formatActivityMessage(owner: string, repo: string, pr: PrDetail): string {
  return `New activity on ${owner}/${repo}#${pr.number} (comments/reviews, no new commits). Please check in and respond if a follow-up is warranted.`;
}

/**
 * One repo's bare clone, ensured at most once per tick regardless of how
 * many PRs in that repo are processed this tick.
 */
function ensureBareCloneOnce(owner: string, repo: string, ctx: TickCtx): { ok: true } | { ok: false; error: string } {
  const key = repoLogKey(owner, repo);
  if (ctx.failedRepoClones.has(key)) {
    return { ok: false, error: 'bare clone already failed earlier this tick' };
  }
  const res = ensureBareClone(owner, repo, ctx.args.dryRun);
  if (!res.ok) ctx.failedRepoClones.add(key);
  return res;
}

async function bootstrapNewPr(key: string, ref: PrRef, pr: PrDetail, ctx: TickCtx): Promise<void> {
  const { owner, repo } = ref;
  let ts: string;
  try {
    ts = await postRootMessage(ctx.cfg, formatRootMessage(owner, repo, pr), ctx.args.dryRun);
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to post Slack root message`, err);
    return; // no state recorded — next tick retries cleanly
  }
  if (ctx.args.dryRun) {
    console.log(`[dry-run] ${key}: would bootstrap (root ts=${ts})`);
    return;
  }

  const clone = ensureBareCloneOnce(owner, repo, ctx);
  if (!clone.ok) {
    await postThreadMessage(ctx.cfg, ts, `Could not set up the local clone for ${owner}/${repo}: ${clone.error}`, ctx.args.dryRun);
    return; // no state recorded
  }
  const fetched = fetchPrRefs(owner, repo, pr.number, pr.base.ref, ctx.args.dryRun);
  if (!fetched.ok) {
    await postThreadMessage(ctx.cfg, ts, `Could not fetch refs for PR #${pr.number}: ${fetched.error}`, ctx.args.dryRun);
    return;
  }

  try {
    await injectCliEvent(
      {
        text: formatKickoffMessage(owner, repo, pr),
        to: { channelType: 'slack', platformId: `slack:${ctx.cfg.reviewsChannel}`, threadId: ts },
        senderId: `slack:${ctx.cfg.ownerSlackId}`,
      },
      ctx.args.dryRun,
    );
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to inject kickoff`, err);
    await postThreadMessage(
      ctx.cfg,
      ts,
      'Could not reach the agent to start this review session. Will retry next tick.',
      ctx.args.dryRun,
    );
    return; // no state recorded
  }

  const newState: PrState = {
    thread_ts: ts,
    head_sha: pr.head.sha,
    base_ref: pr.base.ref,
    opened_at: new Date().toISOString(),
    last_nudge_at: null,
    nudges: 0,
    last_seen_updated_at: pr.updated_at,
  };
  ctx.state[key] = newState;
  saveState(ctx.state);
}

async function handlePush(key: string, ref: PrRef, pr: PrDetail, known: PrState, ctx: TickCtx): Promise<void> {
  const { owner, repo } = ref;
  const clone = ensureBareCloneOnce(owner, repo, ctx);
  if (!clone.ok) {
    console.error(`[pr-reviewer] ${key}: bare clone unavailable, skipping re-review this tick: ${clone.error}`);
    return; // keep existing state, retry next tick
  }
  const fetched = fetchPrRefs(owner, repo, pr.number, pr.base.ref, ctx.args.dryRun);
  if (!fetched.ok) {
    await postThreadMessage(ctx.cfg, known.thread_ts, `Could not fetch new commits for PR #${pr.number}: ${fetched.error}`, ctx.args.dryRun);
    return; // keep existing state, retry next tick
  }

  try {
    await injectCliEvent(
      {
        text: formatReReviewMessage(owner, repo, pr),
        to: { channelType: 'slack', platformId: `slack:${ctx.cfg.reviewsChannel}`, threadId: known.thread_ts },
        senderId: `slack:${ctx.cfg.ownerSlackId}`,
      },
      ctx.args.dryRun,
    );
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to inject re-review`, err);
    await postThreadMessage(ctx.cfg, known.thread_ts, 'Could not reach the agent about new commits. Will retry.', ctx.args.dryRun);
    return;
  }

  if (ctx.args.dryRun) return;
  ctx.state[key] = { ...known, head_sha: pr.head.sha, last_nudge_at: null, nudges: 0, last_seen_updated_at: pr.updated_at };
  saveState(ctx.state);
}

async function handleActivity(key: string, ref: PrRef, pr: PrDetail, known: PrState, ctx: TickCtx): Promise<void> {
  // Skip wakes caused by the reviewer's own GitHub writes (same login as the
  // owner): if nothing since the baseline is authored by someone else, just
  // advance the baseline. On lookup failure, fall through and wake the agent
  // — a wasted turn beats a missed author reply.
  const activity = hasForeignActivity(ref.owner, ref.repo, ref.number, known.last_seen_updated_at, ctx.cfg.selfLogin);
  if (activity.ok && !activity.foreign) {
    if (ctx.args.dryRun) {
      console.log(`[dry-run] ${key}: updated_at advanced but no foreign activity — would advance baseline silently`);
      return;
    }
    ctx.state[key] = { ...known, last_seen_updated_at: pr.updated_at };
    saveState(ctx.state);
    return;
  }
  try {
    await injectCliEvent(
      {
        text: formatActivityMessage(ref.owner, ref.repo, pr),
        to: { channelType: 'slack', platformId: `slack:${ctx.cfg.reviewsChannel}`, threadId: known.thread_ts },
        senderId: `slack:${ctx.cfg.ownerSlackId}`,
      },
      ctx.args.dryRun,
    );
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to inject activity nudge`, err);
    return; // last_seen_updated_at left unchanged so we retry next tick
  }
  if (ctx.args.dryRun) return;
  ctx.state[key] = { ...known, last_seen_updated_at: pr.updated_at };
  saveState(ctx.state);
}

/** Overdue-verdict reminder. Plain Slack post only — no model involvement. */
async function maybeRemind(key: string, ref: PrRef, pr: PrDetail, known: PrState, ctx: TickCtx): Promise<void> {
  if (known.nudges >= ctx.cfg.maxNudges) return;

  let replies;
  try {
    replies = await getThreadReplies(ctx.cfg, known.thread_ts, ctx.args.dryRun);
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to read thread replies`, err);
    return;
  }
  if (replies.length === 0) return;
  const last = replies[replies.length - 1];

  let botUserId: string;
  try {
    botUserId = await getBotUserId(ctx.cfg);
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to resolve bot user id`, err);
    return;
  }
  const lastIsFromBot = last.bot_id !== undefined || last.user === botUserId;
  if (!lastIsFromBot) return;

  const lastTsMs = Number.parseFloat(last.ts) * 1000;
  const ageMs = Date.now() - lastTsMs;
  if (ageMs < ctx.cfg.remindAfterHours * 3600 * 1000) return;

  const text = `<@${ctx.cfg.ownerSlackId}> — no verdict yet on ${ref.owner}/${ref.repo}#${ref.number} after ${ctx.cfg.remindAfterHours}h (nudge ${known.nudges + 1}/${ctx.cfg.maxNudges}).`;
  await postThreadMessage(ctx.cfg, known.thread_ts, text, ctx.args.dryRun);
  if (ctx.args.dryRun) return;
  ctx.state[key] = { ...known, nudges: known.nudges + 1, last_nudge_at: new Date().toISOString() };
  saveState(ctx.state);
}

async function closeOutPr(
  key: string,
  ref: PrRef,
  known: PrState,
  reason: 'merged' | 'closed' | 'review-request-removed',
  ctx: TickCtx,
): Promise<void> {
  const line =
    reason === 'merged'
      ? `PR ${ref.owner}/${ref.repo}#${ref.number} was merged. Stopping tracking.`
      : reason === 'closed'
        ? `PR ${ref.owner}/${ref.repo}#${ref.number} was closed without merging. Stopping tracking.`
        : `Review request for this PR was removed. Stopping tracking.`;

  try {
    await postThreadMessage(ctx.cfg, known.thread_ts, line, ctx.args.dryRun);
  } catch (err) {
    console.error(`[pr-reviewer] ${key}: failed to post closing line`, err);
  }
  if (ctx.args.dryRun) {
    console.log(`[dry-run] ${key}: would remove worktree, prune, drop state (${reason})`);
    return;
  }
  removeWorktreeAndPrune(ref.owner, ref.repo, ref.number, ctx.args.dryRun);
  delete ctx.state[key];
  saveState(ctx.state);
}

async function processPr(key: string, isDiscovered: boolean, ctx: TickCtx): Promise<void> {
  const ref = parsePrKey(key);
  const known = ctx.state[key];

  const detail = getPrDetail(ref.owner, ref.repo, ref.number);
  if (!detail.ok) {
    console.error(`[pr-reviewer] ${key}: failed to fetch PR detail: ${detail.error}`);
    return; // keep state as-is, retry next tick
  }
  const pr = detail.data;
  const stillRequested = (pr.requested_reviewers ?? []).some((u) => u.login === ctx.cfg.selfLogin);
  const isClosed = pr.state === 'closed';

  if (!known) {
    if (!isDiscovered) return; // defensive — union only ever adds discovered or known keys
    if (pr.draft || isClosed || !stillRequested) return; // nothing to do, never tracked
    if (ctx.bootstrapCount >= ctx.cfg.bootstrapPerTick) return; // cap reached; retry next tick
    ctx.bootstrapCount++;
    await bootstrapNewPr(key, ref, pr, ctx);
    return;
  }

  if (isClosed) {
    await closeOutPr(key, ref, known, pr.merged ? 'merged' : 'closed', ctx);
    return;
  }
  if (!stillRequested) {
    await closeOutPr(key, ref, known, 'review-request-removed', ctx);
    return;
  }
  if (pr.draft) return; // became draft mid-review — leave state untouched

  if (pr.head.sha !== known.head_sha) {
    await handlePush(key, ref, pr, known, ctx);
    return;
  }
  if (pr.updated_at !== known.last_seen_updated_at) {
    await handleActivity(key, ref, pr, known, ctx);
    return;
  }
  await maybeRemind(key, ref, pr, known, ctx);
}

/** LRU-evict worktree checkouts over the configured caps. Worktrees are
 * cheap to recreate from the bare clone, so eviction is safe even for a
 * PR still under active review — the agent's pr-review skill re-creates
 * the worktree on its next invocation. */
function gcWorktrees(cfg: Config, dryRun: boolean): void {
  if (!fs.existsSync(REPOS_ROOT)) return;

  interface Entry {
    owner: string;
    repo: string;
    wtPath: string;
    mtimeMs: number;
  }
  const perRepo = new Map<string, Entry[]>();

  for (const repoDirName of fs.readdirSync(REPOS_ROOT)) {
    const sep = repoDirName.indexOf('__');
    if (sep === -1) continue;
    const owner = repoDirName.slice(0, sep);
    const repo = repoDirName.slice(sep + 2);
    const { wtDir } = repoPaths(owner, repo);
    if (!fs.existsSync(wtDir)) continue;

    const entries: Entry[] = [];
    for (const name of fs.readdirSync(wtDir)) {
      if (!name.startsWith('pr-')) continue;
      const wtPath = path.join(wtDir, name);
      const stat = fs.statSync(wtPath);
      entries.push({ owner, repo, wtPath, mtimeMs: stat.mtimeMs });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    perRepo.set(repoDirName, entries);
  }

  const evict = (entry: Entry) => {
    const number = Number.parseInt(path.basename(entry.wtPath).slice('pr-'.length), 10);
    if (dryRun) {
      console.log(`[dry-run] would GC-evict worktree ${entry.wtPath}`);
      return;
    }
    console.error(`[pr-reviewer] GC evicting worktree ${entry.wtPath} (over cap)`);
    removeWorktreeAndPrune(entry.owner, entry.repo, number, false);
  };

  for (const [, entries] of perRepo) {
    while (entries.length > cfg.maxWorktreesPerRepo) evict(entries.shift()!);
  }

  const all = Array.from(perRepo.values())
    .flat()
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let overTotal = all.length - cfg.maxWorktreesTotal;
  for (const entry of all) {
    if (overTotal-- <= 0) break;
    evict(entry);
  }
}

async function tick(cfg: Config, args: Args): Promise<void> {
  const state = loadState();

  let discovered: PrRef[];
  if (args.once) {
    discovered = [parsePrKey(args.once)];
  } else {
    try {
      discovered = searchOpenPRs(cfg.prSearchQuery);
    } catch (err) {
      console.error('[pr-reviewer] discovery failed, processing known PRs only this tick', err);
      discovered = [];
    }
  }

  const discoveredKeys = new Set(discovered.map(prKey));
  const keys = args.once
    ? [prKey(discovered[0])]
    : Array.from(new Set([...discoveredKeys, ...Object.keys(state)])).sort();

  const ctx: TickCtx = { cfg, args, state, bootstrapCount: 0, failedRepoClones: new Set() };

  for (const key of keys) {
    try {
      await processPr(key, discoveredKeys.has(key) || Boolean(args.once), ctx);
    } catch (err) {
      // One PR's failure must never abort the tick for the others.
      console.error(`[pr-reviewer] unhandled error processing ${key}`, err);
    }
  }

  if (!args.once) {
    try {
      gcWorktrees(cfg, args.dryRun);
    } catch (err) {
      console.error('[pr-reviewer] worktree GC failed', err);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (!acquireLock()) {
    // Overlapping launchd tick — exit quietly, the running tick owns this pass.
    return;
  }
  try {
    await tick(cfg, args);
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  console.error('[pr-reviewer] fatal', err);
  process.exit(1);
});
