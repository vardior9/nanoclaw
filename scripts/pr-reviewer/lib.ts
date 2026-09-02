/**
 * scripts/pr-reviewer/lib.ts — shared helpers for dispatch.ts and install.ts.
 *
 * No side effects at import time (no socket/DB connections opened here) —
 * both the dispatcher and the installer import this freely.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { readEnvFile } from '../../src/env.js';

export const PROJECT_ROOT = process.cwd();
export const REPOS_ROOT = path.join(PROJECT_ROOT, 'repos');
export const STATE_DIR = path.join(PROJECT_ROOT, 'data', 'pr-reviewer');
export const STATE_PATH = path.join(STATE_DIR, 'state.json');
export const LOCK_PATH = path.join(STATE_DIR, 'dispatch.lock');
export const STALE_LOCK_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  prSearchQuery: string;
  reviewsChannel: string; // Slack channel id
  reviewsDm: string; // Slack DM channel id used by the native Agent view
  ownerSlackId: string; // Slack user id (also senderId for injected events)
  /** GitHub login of the reviewer identity — the PAT user AND the human owner. */
  selfLogin: string;
  remindAfterHours: number;
  maxNudges: number;
  bootstrapPerTick: number;
  maxWorktreesPerRepo: number;
  maxWorktreesTotal: number;
  slackBotToken: string;
}

const ENV_KEYS = [
  'PR_SELF_LOGIN',
  'PR_SEARCH_QUERY',
  'PR_REVIEWS_CHANNEL',
  'PR_REVIEWS_DM',
  'PR_OWNER_SLACK_ID',
  'REMIND_AFTER_HOURS',
  'MAX_NUDGES',
  'PR_BOOTSTRAP_PER_TICK',
  'MAX_WORKTREES_PER_REPO',
  'MAX_WORKTREES_TOTAL',
  'SLACK_BOT_TOKEN',
];

function intOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const env = readEnvFile(ENV_KEYS);
  // Process env wins over .env — the runbook's `PR_SEARCH_QUERY=… dispatch.ts`
  // scoped-rollout override depends on it (readEnvFile only reads the file).
  for (const key of ENV_KEYS) {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined) env[key] = fromProcess;
  }
  const slackBotToken = env.SLACK_BOT_TOKEN;
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN is not set in .env — cannot post to Slack');
  }
  return {
    prSearchQuery: env.PR_SEARCH_QUERY || 'is:pr review-requested:vardior9 org:apiiro state:open',
    reviewsChannel: env.PR_REVIEWS_CHANNEL || 'C0BR29QUFEG',
    reviewsDm: env.PR_REVIEWS_DM || 'D0B5RV4BH37',
    ownerSlackId: env.PR_OWNER_SLACK_ID || 'U010NV4PV29',
    selfLogin: env.PR_SELF_LOGIN || 'vardior9',
    remindAfterHours: intOr(env.REMIND_AFTER_HOURS, 24),
    maxNudges: intOr(env.MAX_NUDGES, 1),
    bootstrapPerTick: intOr(env.PR_BOOTSTRAP_PER_TICK, 2),
    maxWorktreesPerRepo: intOr(env.MAX_WORKTREES_PER_REPO, 6),
    maxWorktreesTotal: intOr(env.MAX_WORKTREES_TOTAL, 20),
    slackBotToken,
  };
}

// ---------------------------------------------------------------------------
// PR key helpers — "<owner>/<repo>#<n>"
// ---------------------------------------------------------------------------

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export function parsePrKey(key: string): PrRef {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  if (!m) throw new Error(`invalid PR key: "${key}" (expected <owner>/<repo>#<n>)`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// ---------------------------------------------------------------------------
// State file — single writer, atomic write, mkdir-based lock
// ---------------------------------------------------------------------------

export interface PrState {
  thread_ts: string;
  head_sha: string;
  /**
   * PR title as of the tick that opened tracking. The only host-side source
   * for the Slack agent-session title, which the reviewer module reads from
   * this file — Slack fixes that title at creation, so it identifies the PR
   * (`lim 48766 <subject>`) rather than carrying review state. Optional:
   * entries written before this field existed fall back to `<repo> <number>`.
   */
  pr_title?: string;
  base_ref: string;
  opened_at: string;
  last_nudge_at: string | null;
  nudges: number;
  /**
   * PR's `updated_at` as of the last tick that saw it. Not in the task's
   * literal state shape, but structurally required to detect "new activity
   * without a new commit" (the alternative — diffing against `opened_at` —
   * can't tell "already nudged this update" from "brand new update").
   */
  last_seen_updated_at: string;
}

export type StateFile = Record<string, PrState>;

export function loadState(): StateFile {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    return JSON.parse(raw) as StateFile;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      console.error(`[pr-reviewer] state file unreadable, starting empty: ${String(err)}`);
    }
    return {};
  }
}

export function saveState(state: StateFile): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}

/** mkdir-based lock: atomic across processes, no extra deps. */
export function acquireLock(): boolean {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.mkdirSync(LOCK_PATH);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw err;
  }
  // Lock held — check staleness (a launchd tick that crashed without cleanup).
  try {
    const stat = fs.statSync(LOCK_PATH);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      console.error('[pr-reviewer] breaking stale lock (older than 15m)');
      fs.rmSync(LOCK_PATH, { recursive: true, force: true });
      fs.mkdirSync(LOCK_PATH);
      return true;
    }
  } catch {
    // lock disappeared between the mkdir failure and the stat — treat as free.
  }
  return false;
}

export function releaseLock(): void {
  fs.rmSync(LOCK_PATH, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// gh CLI — host's own `gh` auth, never a token from anywhere else
// ---------------------------------------------------------------------------

interface GhSearchItem {
  number: number;
  repository_url: string;
  title: string;
  html_url: string;
  labels?: Array<{ name: string }>;
  draft?: boolean;
}

/** Raw fields consumed from `gh api repos/{o}/{r}/pulls/{n}`. */
export interface PrDetail {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  title: string;
  html_url: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  user: { login: string };
  head: { sha: string };
  base: { ref: string };
  requested_reviewers?: Array<{ login: string }>;
}

function runGh(args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    return { ok: false, error: e.stderr ? String(e.stderr).trim() : e.message };
  }
}

/** Search for PRs, filtering out anything labeled `apiiro-autofix`. */
export function searchOpenPRs(query: string): PrRef[] {
  const res = runGh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '--paginate', '--jq', '.items[]']);
  if (!res.ok) throw new Error(`gh search failed: ${res.error}`);
  const items: GhSearchItem[] = res.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GhSearchItem);

  return items
    .filter((item) => !(item.labels ?? []).some((l) => l.name.toLowerCase() === 'apiiro-autofix'))
    .map((item) => {
      // repository_url: "https://api.github.com/repos/<owner>/<repo>"
      const parts = item.repository_url.split('/');
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1], number: item.number };
    });
}

export function getPrDetail(
  owner: string,
  repo: string,
  number: number,
): { ok: true; data: PrDetail } | { ok: false; error: string } {
  const res = runGh(['api', `repos/${owner}/${repo}/pulls/${number}`]);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, data: JSON.parse(res.stdout) as PrDetail };
  } catch (err) {
    return { ok: false, error: `unparseable gh response: ${String(err)}` };
  }
}

/**
 * State of selfLogin's most recent submitted review on the PR, or null when
 * selfLogin has never reviewed it. Distinguishes "review request cleared
 * because we submitted a review" (GitHub clears the request on ANY review,
 * COMMENT included) from "the author genuinely un-requested us".
 */
export function latestSelfReviewState(
  owner: string,
  repo: string,
  number: number,
  selfLogin: string,
): { ok: true; state: string | null } | { ok: false; error: string } {
  const res = runGh(['api', `repos/${owner}/${repo}/pulls/${number}/reviews`, '--paginate']);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const reviews = JSON.parse(res.stdout) as Array<{
      user?: { login?: string };
      state?: string;
      submitted_at?: string;
    }>;
    const mine = reviews
      .filter((r) => r.user?.login === selfLogin && r.submitted_at)
      .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
    return { ok: true, state: mine.length ? (mine[mine.length - 1].state ?? null) : null };
  } catch (err) {
    return { ok: false, error: `unparseable gh response: ${String(err)}` };
  }
}

/**
 * Whether the PR saw activity from anyone OTHER than selfLogin since the
 * given timestamp. The reviewer's own review posts (same PAT identity as the
 * owner) advance `updated_at`, so waking the agent on every change would
 * burn one no-op model turn per review the agent itself posts. Comments and
 * review submissions carry authorship; a sha change is handled separately.
 */
export function hasForeignActivity(
  owner: string,
  repo: string,
  number: number,
  sinceIso: string,
  selfLogin: string,
): { ok: true; foreign: boolean; context: string } | { ok: false; error: string } {
  interface Authored {
    user?: { login?: string } | null;
    submitted_at?: string;
    created_at?: string;
    body?: string;
    state?: string;
    path?: string;
    line?: number | null;
    html_url?: string;
  }
  const foreignIn = (items: Authored[], after?: boolean): Authored[] =>
    items.filter(
      (item) =>
        (!after || (item.submitted_at ?? item.created_at ?? '') > sinceIso) &&
        item.user?.login !== undefined &&
        item.user.login !== selfLogin,
    );

  const issueComments = runGh(['api', `repos/${owner}/${repo}/issues/${number}/comments?since=${sinceIso}`]);
  if (!issueComments.ok) return { ok: false, error: issueComments.error };
  const reviewComments = runGh(['api', `repos/${owner}/${repo}/pulls/${number}/comments?since=${sinceIso}`]);
  if (!reviewComments.ok) return { ok: false, error: reviewComments.error };
  // The reviews list has no `since` param — filter on submitted_at client-side.
  const reviews = runGh(['api', `repos/${owner}/${repo}/pulls/${number}/reviews`]);
  if (!reviews.ok) return { ok: false, error: reviews.error };

  try {
    const items = [
      ...foreignIn(JSON.parse(issueComments.stdout) as Authored[]),
      ...foreignIn(JSON.parse(reviewComments.stdout) as Authored[]),
      ...foreignIn(JSON.parse(reviews.stdout) as Authored[], true).filter(
        (item) => item.state !== 'APPROVED' || Boolean(item.body?.trim()),
      ),
    ].sort((a, b) => String(a.submitted_at ?? a.created_at).localeCompare(String(b.submitted_at ?? b.created_at)));
    const context = items
      .slice(-30)
      .map((item) => {
        const where = item.path ? `${item.path}${item.line ? `:${item.line}` : ''}` : (item.state ?? 'conversation');
        const body = (item.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 800) || '(no body)';
        return `- ${item.user?.login} at ${where}: ${body}${item.html_url ? ` (${item.html_url})` : ''}`;
      })
      .join('\n');
    return { ok: true, foreign: items.length > 0, context };
  } catch (err) {
    return { ok: false, error: `unparseable gh response: ${String(err)}` };
  }
}

export function getCommitDelta(
  owner: string,
  repo: string,
  previousHead: string,
  currentHead: string,
): { ok: true; context: string } | { ok: false; error: string } {
  const { bare } = repoPaths(owner, repo);
  const stat = runGit(['-C', bare, 'diff', '--stat', '--compact-summary', previousHead, currentHead]);
  if (!stat.ok) return stat;
  const names = runGit(['-C', bare, 'diff', '--name-status', previousHead, currentHead]);
  if (!names.ok) return names;
  const changed = names.stdout.trim().split('\n').filter(Boolean);
  const shown = changed.slice(0, 80);
  return {
    ok: true,
    context: [
      `Previous reviewed head: ${previousHead}`,
      `Current head: ${currentHead}`,
      `Commit delta (${changed.length} paths):`,
      shown.join('\n') || '(no path changes)',
      changed.length > shown.length ? `... ${changed.length - shown.length} more paths` : '',
      'Delta stat:',
      stat.stdout.trim() || '(empty)',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function getUnresolvedSelfReviewThreads(
  owner: string,
  repo: string,
  number: number,
  selfLogin: string,
): { ok: true; context: string } | { ok: false; error: string } {
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){nodes{databaseId body author{login} url}}}}}}}`;
  const res = runGh([
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `repo=${repo}`,
    '-F',
    `number=${number}`,
  ]);
  if (!res.ok) return res;
  try {
    type Comment = { databaseId: number; body: string; author?: { login?: string }; url: string };
    type Thread = {
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line?: number;
      comments: { nodes: Comment[] };
    };
    const parsed = JSON.parse(res.stdout) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Thread[] } } } };
    };
    const threads = (parsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter(
      (thread) => !thread.isResolved && thread.comments.nodes[0]?.author?.login === selfLogin,
    );
    const context = threads
      .map((thread) => {
        const root = thread.comments.nodes[0];
        const replies = thread.comments.nodes
          .slice(1)
          .map((c) => `${c.author?.login ?? 'unknown'}: ${c.body.replace(/\s+/g, ' ').slice(0, 500)}`);
        return [
          `- ${thread.path}${thread.line ? `:${thread.line}` : ''}${thread.isOutdated ? ' (outdated)' : ''}`,
          `  reviewer #${root.databaseId}: ${root.body.replace(/\s+/g, ' ').slice(0, 800)}`,
          ...replies.map((reply) => `  reply: ${reply}`),
        ].join('\n');
      })
      .join('\n');
    return { ok: true, context: context || 'none' };
  } catch (err) {
    return { ok: false, error: `unparseable review-thread response: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// git — bare clone + per-PR ref fetch + worktree teardown (host side only;
// the worktree itself is created inside the container by the review agent)
// ---------------------------------------------------------------------------

export function repoDirName(owner: string, repo: string): string {
  return `${owner}__${repo}`;
}

export function repoPaths(owner: string, repo: string): { root: string; bare: string; wtDir: string } {
  const root = path.join(REPOS_ROOT, repoDirName(owner, repo));
  return { root, bare: path.join(root, 'git'), wtDir: path.join(root, 'wt') };
}

function runGit(args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const stdout = execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string };
    return { ok: false, error: e.stderr ? String(e.stderr).trim() : e.message };
  }
}

/** Idempotent: no-ops if the bare clone already exists. */
export function ensureBareClone(
  owner: string,
  repo: string,
  dryRun: boolean,
): { ok: true } | { ok: false; error: string } {
  const { bare } = repoPaths(owner, repo);
  if (fs.existsSync(path.join(bare, 'HEAD'))) return { ok: true };
  if (dryRun) {
    console.log(`[dry-run] would clone https://github.com/${owner}/${repo}.git bare into ${bare}`);
    return { ok: true };
  }
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  const res = runGit(['clone', '--bare', `https://github.com/${owner}/${repo}.git`, bare]);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export function fetchPrRefs(
  owner: string,
  repo: string,
  number: number,
  baseRef: string,
  dryRun: boolean,
): { ok: true } | { ok: false; error: string } {
  const { bare } = repoPaths(owner, repo);
  if (dryRun) {
    console.log(`[dry-run] would fetch PR #${number} head + base '${baseRef}' into ${bare}`);
    return { ok: true };
  }
  const res = runGit([
    '-C',
    bare,
    'fetch',
    '--prune',
    'origin',
    `+refs/pull/${number}/head:refs/pr/${number}/head`,
    `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export function removeWorktreeAndPrune(owner: string, repo: string, number: number, dryRun: boolean): void {
  const { bare, wtDir } = repoPaths(owner, repo);
  const wtPath = path.join(wtDir, `pr-${number}`);
  if (dryRun) {
    console.log(`[dry-run] would remove worktree ${wtPath} and prune`);
    return;
  }
  // Tolerate absence — the container agent may never have created it.
  runGit(['-C', bare, 'worktree', 'remove', '--force', wtPath]);
  runGit(['-C', bare, 'worktree', 'prune']);
  fs.rmSync(wtPath, { recursive: true, force: true });
}

/** Container-side paths for the kickoff message (mounted read-write at /workspace/extra/repos). */
export function containerBarePath(owner: string, repo: string): string {
  return `/workspace/extra/repos/${repoDirName(owner, repo)}/git`;
}

export function containerWorktreePath(owner: string, repo: string, number: number): string {
  return `/workspace/extra/repos/${repoDirName(owner, repo)}/wt/pr-${number}`;
}

// ---------------------------------------------------------------------------
// Slack Web API — modeled on the open-a2a-room.ts fetch pattern
// ---------------------------------------------------------------------------

const SLACK_API = 'https://slack.com/api';

async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`slack ${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

let cachedBotUserId: string | null = null;

export async function getBotUserId(cfg: Config): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const auth = await slackCall(cfg.slackBotToken, 'auth.test', {});
  const userId = typeof auth.user_id === 'string' ? auth.user_id : null;
  if (!userId) throw new Error('slack auth.test returned no user_id');
  cachedBotUserId = userId;
  return userId;
}

export async function postRootMessage(cfg: Config, text: string, dryRun: boolean): Promise<string> {
  if (dryRun) {
    console.log(`[dry-run] would post to #${cfg.reviewsChannel}:\n${text}`);
    return `dry-run-${Date.now()}`;
  }
  const res = await slackCall(cfg.slackBotToken, 'chat.postMessage', { channel: cfg.reviewsChannel, text });
  const ts = typeof res.ts === 'string' ? res.ts : null;
  if (!ts) throw new Error('chat.postMessage returned no ts');
  return ts;
}

export async function postThreadMessage(cfg: Config, threadTs: string, text: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would post in-thread (${threadTs}) on #${cfg.reviewsChannel}:\n${text}`);
    return;
  }
  await slackCall(cfg.slackBotToken, 'chat.postMessage', { channel: cfg.reviewsChannel, thread_ts: threadTs, text });
}

export async function postSlackThreadMessage(
  cfg: Config,
  channelId: string,
  threadTs: string,
  text: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would post in Slack thread ${channelId}/${threadTs}:\n${text}`);
    return;
  }
  await slackCall(cfg.slackBotToken, 'chat.postMessage', { channel: channelId, thread_ts: threadTs, text });
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

export function isPendingVerdictMessage(text: string | undefined): boolean {
  return typeof text === 'string' && text.includes('Ready for final verdict');
}

export async function getThreadReplies(cfg: Config, threadTs: string, dryRun: boolean): Promise<SlackMessage[]> {
  if (dryRun) return [];
  // Read methods like conversations.replies reject JSON bodies
  // (invalid_arguments) — they only take query/form params, so GET.
  const params = new URLSearchParams({ channel: cfg.reviewsChannel, ts: threadTs });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
    headers: { Authorization: `Bearer ${cfg.slackBotToken}` },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`slack conversations.replies failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return Array.isArray(json.messages) ? (json.messages as SlackMessage[]) : [];
}

export async function getSlackThreadReplies(
  cfg: Config,
  channelId: string,
  threadTs: string,
  dryRun: boolean,
): Promise<SlackMessage[]> {
  if (dryRun) return [];
  const params = new URLSearchParams({ channel: channelId, ts: threadTs });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
    headers: { Authorization: `Bearer ${cfg.slackBotToken}` },
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    throw new Error(`slack conversations.replies failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return Array.isArray(json.messages) ? (json.messages as SlackMessage[]) : [];
}

export function pendingSlackReviewThreadId(cfg: Config, key: string): string {
  return `slack:${cfg.reviewsDm}:pending-pr-${Buffer.from(key, 'utf8').toString('base64url')}`;
}

export function reviewDestination(cfg: Config, storedThread: string): InjectPayload['to'] {
  if (storedThread.startsWith(`slack:${cfg.reviewsDm}:pending-pr-`)) {
    return { channelType: 'slack', platformId: `slack:${cfg.reviewsDm}`, threadId: storedThread };
  }
  return {
    channelType: 'slack',
    platformId: `slack:${cfg.reviewsChannel}`,
    threadId: slackThreadId(cfg, storedThread),
  };
}

export interface MaterializedAgentSession {
  channelId: string;
  threadTs: string;
  aliasThreadId: string;
}

/** Resolve a pending reviewer thread after its first actionable Slack output. */
export function materializedAgentSession(pendingThreadId: string): MaterializedAgentSession | null {
  const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        `SELECT a.platform_id, a.thread_ts, a.alias_thread_id
           FROM reviewer_agent_session_aliases a
           JOIN sessions s ON s.id = a.session_id
          WHERE s.thread_id = ? AND a.closed_at IS NULL
          ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(pendingThreadId) as { platform_id: string; thread_ts: string; alias_thread_id: string } | undefined;
    if (!row) return null;
    return {
      channelId: row.platform_id.replace(/^slack:/, '').split(':')[0],
      threadTs: row.thread_ts,
      aliasThreadId: row.alias_thread_id,
    };
  } catch (err) {
    if (String(err).includes('no such table')) return null;
    throw err;
  } finally {
    db.close();
  }
}

export async function setMaterializedAgentSessionStatus(
  cfg: Config,
  pendingThreadId: string,
  status: 'active' | 'processing' | 'suspended' | 'closed',
  dryRun: boolean,
): Promise<boolean> {
  const session = materializedAgentSession(pendingThreadId);
  if (!session) return false;
  if (dryRun) {
    console.log(`[dry-run] would set Slack agent session ${session.channelId}/${session.threadTs} to ${status}`);
    return true;
  }
  await slackCall(cfg.slackBotToken, 'agents.sessions.setStatus', {
    channel_id: session.channelId,
    thread_ts: session.threadTs,
    status,
  });
  const db = new Database(path.join(DATA_DIR, 'v2.db'));
  try {
    if (status === 'closed') {
      db.prepare('UPDATE reviewer_agent_session_aliases SET closed_at = ? WHERE alias_thread_id = ?').run(
        new Date().toISOString(),
        session.aliasThreadId,
      );
    }
  } finally {
    db.close();
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI socket injection — src/channels/cli.ts wire format
// ---------------------------------------------------------------------------

export interface InjectPayload {
  text: string;
  to: { channelType: string; platformId: string; threadId: string | null };
  senderId: string;
}

/**
 * Slack-adapter thread id for a message ts in the reviews channel. The
 * adapter's thread ids are the composite `slack:<channelId>:<ts>` — this is
 * both what delivery decodes on the way out and what real in-thread Slack
 * replies carry on the way in, so injected sessions must be keyed by it (a
 * bare ts creates a session no Slack reply can ever reach).
 */
export function slackThreadId(cfg: Config, ts: string): string {
  return `slack:${cfg.reviewsChannel}:${ts}`;
}

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

/**
 * Write one routed event line to the CLI channel's admin socket
 * (src/channels/cli.ts). The wire format for an admin-transport injection is:
 *
 *   { "text": "...", "to": {"channelType": "slack", "platformId": "slack:<channelId>",
 *                            "threadId": "slack:<channelId>:<ts>"}, "senderId": "slack:<userId>" }
 *
 * This is fire-and-forget at the protocol level — routed ("to"-bearing)
 * lines never get a reply on this connection (only plain chat connections
 * do), so "success" here only means the socket accepted the write. Whether
 * routing/access checks passed inside the host is not observable from here.
 */
export function injectCliEvent(payload: InjectPayload, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[dry-run] would inject via cli.sock: ${JSON.stringify(payload)}`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath());
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timeout = setTimeout(() => fail(new Error('timed out writing to cli.sock')), 5000);
    socket.on('error', (err) => fail(err));
    socket.on('connect', () => {
      socket.end(JSON.stringify(payload) + '\n');
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    });
  });
}
