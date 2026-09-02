/**
 * PR reviewer action-only Slack agent sessions.
 *
 * Each PR starts in a synthetic DM thread that cannot exist in Slack, so
 * background review creates neither a Slack session nor a notification. The
 * first user-facing agent output becomes the DM root and is registered as a
 * suspended native agent session. A central alias sends replies back to the
 * original isolated NanoClaw session.
 */
import { Buffer } from 'buffer';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import type { AgentSessionStatus } from '../../channels/adapter.js';
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { setAgentSessionStoppedHandler } from '../../channels/chat-sdk-bridge.js';
import { registerQuestionRenderResolver } from '../../channels/question-render-registry.js';
import { DATA_DIR } from '../../config.js';
import { killContainer } from '../../container-runner.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSession } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import type { Session } from '../../types.js';

const TABLE = 'reviewer_agent_session_aliases';
const VERDICTS_TABLE = 'reviewer_verdict_requests';
const PENDING_MARKER = 'pending-pr-';
const VERDICT_PREFIX = 'PR_REVIEW_VERDICT ';

interface AliasRow {
  session_id: string;
  alias_thread_id: string;
  channel_type: string;
  platform_id: string;
  thread_ts: string;
  title: string;
  root_message_out_id: string;
  status_created_at: string | null;
  closed_at: string | null;
}

interface DeliverableMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

interface VerdictRequestRow {
  question_id: string;
  session_id: string;
  pr_key: string;
  head_sha: string;
  recommendation: 'APPROVE' | 'REQUEST_CHANGES';
  title: string;
  question: string;
  options_json: string;
  created_at: string;
  closed_at: string | null;
}

registerMigration({
  version: 1,
  name: 'module:pr-reviewer-agent-sessions:aliases',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE ${TABLE} (
        session_id           TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        alias_thread_id      TEXT NOT NULL UNIQUE,
        channel_type         TEXT NOT NULL,
        platform_id          TEXT NOT NULL,
        thread_ts            TEXT NOT NULL,
        title                TEXT NOT NULL,
        root_message_out_id  TEXT NOT NULL,
        status_created_at    TEXT,
        closed_at            TEXT,
        created_at           TEXT NOT NULL
      );
      CREATE INDEX idx_reviewer_agent_alias_thread ON ${TABLE}(alias_thread_id);
    `);
  },
});

registerMigration({
  version: 2,
  name: 'module:pr-reviewer-agent-sessions:verdict-requests',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE ${VERDICTS_TABLE} (
        question_id    TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        pr_key         TEXT NOT NULL,
        head_sha       TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        title          TEXT NOT NULL,
        question       TEXT NOT NULL,
        options_json   TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_reviewer_verdict_one_per_head
        ON ${VERDICTS_TABLE}(pr_key, head_sha);
    `);
  },
});

registerMigration({
  version: 3,
  name: 'module:pr-reviewer-agent-sessions:cleanup-closed-verdicts',
  up(db: Database.Database) {
    db.exec(`
      DELETE FROM ${VERDICTS_TABLE}
       WHERE session_id IN (
         SELECT session_id FROM ${TABLE} WHERE closed_at IS NOT NULL
       );
    `);
  },
});

/**
 * Slack fixes an agent session's title at creation: `agents.sessions.setStatus`
 * accepts a `title` only on the call that creates the session and silently
 * ignores it afterwards (verified live — it echoes the original back). So the
 * title is an IDENTIFIER, never a status: "approved" can never appear there.
 * Resolution is signalled in-thread (the host's one-line verdict receipt) and
 * by the session status below.
 *
 * Slack also rewrites unsafe characters in the stored title (`apiiro/lim#48766`
 * came back as `apiiro_lim_48766`), so the title is pre-reduced here to the
 * character set Slack keeps verbatim — what we compose is what Slack shows.
 */
const TITLE_MAX = 120;

function titleSafe(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The dispatcher's state file — the only place a PR's title is known host-side. */
function prTitleForKey(key: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'pr-reviewer', 'state.json'), 'utf8');
    const title = (JSON.parse(raw) as Record<string, { pr_title?: unknown }>)[key]?.pr_title;
    return typeof title === 'string' && title.trim() ? title : null;
  } catch {
    return null; // no state file, unreadable, or a PR tracked before pr_title existed
  }
}

/** `apiiro/lim#48766` + "Batch reads" → `lim 48766 Batch reads`. */
export function reviewerSessionTitle(key: string, prTitle: string | null): string {
  const parsed = /^[^/]+\/([^#]+)#(\d+)$/.exec(key);
  const head = parsed ? `${titleSafe(parsed[1])} ${parsed[2]}` : titleSafe(key);
  const subject = prTitle ? titleSafe(prTitle) : '';
  return `${subject ? `${head} ${subject}` : head}`.slice(0, TITLE_MAX).trim();
}

interface VerdictSignal {
  headSha: string;
  recommendation: 'APPROVE' | 'REQUEST_CHANGES';
  question: string;
}

function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    /* raw text */
  }
  return content;
}

function verdictSignal(content: string): VerdictSignal | null {
  const text = messageText(content);
  if (!text.startsWith(VERDICT_PREFIX)) return null;
  const newline = text.indexOf('\n');
  if (newline === -1) return null;
  try {
    const marker = JSON.parse(text.slice(VERDICT_PREFIX.length, newline)) as Record<string, unknown>;
    const recommendation = marker.recommendation;
    const headSha = marker.head_sha;
    const question = text.slice(newline + 1).trim();
    if (
      (recommendation !== 'APPROVE' && recommendation !== 'REQUEST_CHANGES') ||
      typeof headSha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(headSha) ||
      !question
    ) {
      return null;
    }
    return { recommendation, headSha, question: verdictCardQuestion(question) };
  } catch {
    return null;
  }
}

/** Slack cards render this field as rich text, not GitHub-flavoured Markdown. */
function verdictCardQuestion(question: string): string {
  return question
    .replace(/^(?:<|&lt;)@[A-Z0-9]+(?:>|&gt;)\s*/i, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) =>
      label === url ? url : `${label}: ${url}`,
    )
    .trim();
}

const VERDICT_OPTIONS: RawOption[] = [
  { label: 'Approve on GitHub', selectedLabel: 'Approve selected', value: 'APPROVE', style: 'primary' },
  {
    label: 'Request changes on GitHub',
    selectedLabel: 'Request changes selected',
    value: 'REQUEST_CHANGES',
    style: 'danger',
  },
  { label: 'Hold', selectedLabel: 'Held', value: 'HOLD' },
];

export function pendingReviewerThreadId(dmChannelId: string, key: string): string {
  const encoded = Buffer.from(key, 'utf8').toString('base64url');
  return `slack:${dmChannelId}:${PENDING_MARKER}${encoded}`;
}

export function prKeyFromPendingThread(threadId: string | null): string | null {
  if (!threadId) return null;
  const markerAt = threadId.lastIndexOf(`:${PENDING_MARKER}`);
  if (markerAt === -1) return null;
  try {
    return Buffer.from(threadId.slice(markerAt + PENDING_MARKER.length + 1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function aliasForSession(sessionId: string): AliasRow | undefined {
  if (!hasTable(getDb(), TABLE)) return undefined;
  return getDb().prepare(`SELECT * FROM ${TABLE} WHERE session_id = ?`).get(sessionId) as AliasRow | undefined;
}

function prepareVerdictRequest(session: Session, key: string, msg: DeliverableMessage, signal: VerdictSignal): string {
  const existing = getDb()
    .prepare(`SELECT question_id FROM ${VERDICTS_TABLE} WHERE pr_key = ? AND head_sha = ?`)
    .get(key, signal.headSha) as { question_id: string } | undefined;
  if (existing) return existing.question_id;

  const questionId = `prv-${createHash('sha256').update(`${session.id}:${msg.id}`).digest('hex').slice(0, 24)}`;
  const options = normalizeOptions(VERDICT_OPTIONS);
  getDb()
    .prepare(
      `INSERT INTO ${VERDICTS_TABLE}
        (question_id, session_id, pr_key, head_sha, recommendation, title, question, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      questionId,
      session.id,
      key,
      signal.headSha,
      signal.recommendation,
      'Final PR verdict',
      signal.question,
      JSON.stringify(options),
      new Date().toISOString(),
    );
  return questionId;
}

function verdictCard(questionId: string, signal: VerdictSignal): string {
  return JSON.stringify({
    type: 'ask_question',
    questionId,
    title: 'Final PR verdict',
    question: signal.question,
    options: VERDICT_OPTIONS,
  });
}

export function findReviewerSessionByAlias(
  agentGroupId: string,
  messagingGroupId: string,
  aliasThreadId: string | null,
): Session | undefined {
  if (!aliasThreadId || !hasTable(getDb(), TABLE)) return undefined;
  return getDb()
    .prepare(
      `SELECT s.*
         FROM ${TABLE} a
         JOIN sessions s ON s.id = a.session_id
        WHERE a.alias_thread_id = ?
          AND s.agent_group_id = ?
          AND s.messaging_group_id = ?
          AND s.status = 'active'`,
    )
    .get(aliasThreadId, agentGroupId, messagingGroupId) as Session | undefined;
}

export async function deliverPendingReviewerAgentSession(
  msg: DeliverableMessage,
  session: Session,
  adapter: ChannelDeliveryAdapter,
): Promise<{ handled: false } | { handled: true; platformMessageId?: string }> {
  const key = prKeyFromPendingThread(session.thread_id);
  if (!key) return { handled: false };
  if (!adapter.setAgentSessionStatus) throw new Error('Slack adapter has no native agent-session lifecycle');

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || mg.channel_type !== 'slack' || !mg.platform_id.startsWith('slack:D')) {
    throw new Error(`Reviewer pending session ${session.id} is not rooted in a Slack DM`);
  }
  const channelType = mg.channel_type;
  const platformId = mg.platform_id;
  let alias = aliasForSession(session.id);
  let platformMessageId: string | undefined;
  const signal = verdictSignal(msg.content);
  const questionId = signal ? prepareVerdictRequest(session, key, msg, signal) : null;
  const deliveredKind = signal ? 'chat-sdk' : msg.kind;
  const deliveredContent = signal && questionId ? verdictCard(questionId, signal) : msg.content;

  if (!alias) {
    platformMessageId = await adapter.deliver(
      channelType,
      platformId,
      null,
      deliveredKind,
      deliveredContent,
      undefined,
      mg?.instance,
    );
    if (!platformMessageId) throw new Error('Slack did not return a message timestamp for agent-session root');
    const title = reviewerSessionTitle(key, prTitleForKey(key));
    const aliasThreadId = `${platformId}:${platformMessageId}`;
    getDb()
      .prepare(
        `INSERT INTO ${TABLE}
          (session_id, alias_thread_id, channel_type, platform_id, thread_ts, title,
           root_message_out_id, status_created_at, closed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        session.id,
        aliasThreadId,
        channelType,
        platformId,
        platformMessageId,
        title,
        msg.id,
        new Date().toISOString(),
      );
    alias = aliasForSession(session.id);
    if (!alias) throw new Error('Agent-session alias insert was not readable');
  } else if (alias.root_message_out_id === msg.id) {
    // The root reached Slack but lifecycle creation failed. Retry only the
    // idempotent status call; never duplicate the notification message.
    platformMessageId = alias.thread_ts;
  } else {
    platformMessageId = await adapter.deliver(
      channelType,
      platformId,
      alias.alias_thread_id,
      deliveredKind,
      deliveredContent,
      undefined,
      mg?.instance,
    );
  }

  const ownerSlackId = readEnvFile(['PR_OWNER_SLACK_ID']).PR_OWNER_SLACK_ID || 'U010NV4PV29';
  await adapter.setAgentSessionStatus(
    channelType,
    platformId,
    alias.alias_thread_id,
    'suspended',
    mg?.instance,
    alias.status_created_at ? undefined : { title: alias.title, initiatorUserId: ownerSlackId },
  );
  if (!alias.status_created_at) {
    getDb()
      .prepare(`UPDATE ${TABLE} SET status_created_at = ? WHERE session_id = ?`)
      .run(new Date().toISOString(), session.id);
  }
  log.info(signal ? 'Reviewer verdict card awaiting host action' : 'Reviewer agent session awaiting human action', {
    sessionId: session.id,
    key,
    threadTs: alias.thread_ts,
    ...(signal ? { recommendation: signal.recommendation, headSha: signal.headSha } : {}),
  });
  return { handled: true, platformMessageId };
}

function verdictRequest(questionId: string): VerdictRequestRow | undefined {
  if (!hasTable(getDb(), VERDICTS_TABLE)) return undefined;
  return getDb()
    .prepare(
      `SELECT v.*, a.closed_at
         FROM ${VERDICTS_TABLE} v
         JOIN ${TABLE} a ON a.session_id = v.session_id
        WHERE v.question_id = ?`,
    )
    .get(questionId) as VerdictRequestRow | undefined;
}

registerQuestionRenderResolver((questionId) => {
  const request = verdictRequest(questionId);
  if (!request) return undefined;
  const options = JSON.parse(request.options_json) as ReturnType<typeof normalizeOptions>;
  return {
    title: request.title,
    question: request.question,
    options: request.closed_at
      ? options.map((option) => ({ ...option, selectedLabel: 'Expired — PR already closed' }))
      : options,
  };
});

function parsePrKey(key: string): { owner: string; repo: string; number: number } {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
  if (!match) throw new Error(`invalid reviewer PR key: ${key}`);
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function gh(args: string[]): Promise<string> {
  const configured =
    process.env.PR_REVIEWER_GH_BIN || readEnvFile(['PR_REVIEWER_GH_BIN']).PR_REVIEWER_GH_BIN || undefined;
  const binary =
    configured ??
    ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find((candidate) => fs.existsSync(candidate)) ??
    'gh';
  return new Promise((resolve, reject) => {
    execFile(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });
}

async function deliverVerdictMessage(request: VerdictRequestRow, text: string): Promise<void> {
  const alias = aliasForSession(request.session_id);
  const session = getSession(request.session_id);
  const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const adapter = getDeliveryAdapter();
  if (!alias || !mg || !adapter) return;
  await adapter.deliver(
    mg.channel_type,
    alias.platform_id,
    alias.alias_thread_id,
    'chat',
    JSON.stringify({ text }),
    undefined,
    mg.instance,
  );
}

async function redeliverVerdictCard(request: VerdictRequestRow): Promise<void> {
  const alias = aliasForSession(request.session_id);
  const session = getSession(request.session_id);
  const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const adapter = getDeliveryAdapter();
  if (!alias || !mg || !adapter) return;
  await adapter.deliver(
    mg.channel_type,
    alias.platform_id,
    alias.alias_thread_id,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: request.question_id,
      title: request.title,
      question: request.question,
      options: VERDICT_OPTIONS,
    }),
    undefined,
    mg.instance,
  );
}

export async function handleReviewerVerdict(payload: ResponsePayload): Promise<boolean> {
  const request = verdictRequest(payload.questionId);
  if (!request) return false;
  if (request.closed_at) {
    log.info('Ignoring expired reviewer verdict click', { questionId: payload.questionId, pr: request.pr_key });
    return true;
  }

  const ownerSlackId = readEnvFile(['PR_OWNER_SLACK_ID']).PR_OWNER_SLACK_ID || 'U010NV4PV29';
  if (payload.channelType !== 'slack' || payload.userId !== ownerSlackId) {
    log.warn('Ignoring unauthorized reviewer verdict click', {
      questionId: payload.questionId,
      userId: payload.userId,
    });
    await redeliverVerdictCard(request);
    return true;
  }

  if (payload.value === 'HOLD') {
    getDb().prepare(`DELETE FROM ${VERDICTS_TABLE} WHERE question_id = ?`).run(payload.questionId);
    return true;
  }
  if (payload.value !== 'APPROVE' && payload.value !== 'REQUEST_CHANGES') {
    await redeliverVerdictCard(request);
    return true;
  }

  const ref = parsePrKey(request.pr_key);
  const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
  try {
    const [currentHead, state, merged] = (
      await gh(['api', endpoint, '--jq', '[.head.sha, .state, .merged] | @tsv'])
    ).split('\t');
    if (!currentHead || !state || !merged) throw new Error('GitHub returned incomplete PR state');
    if (state !== 'open' || merged === 'true') {
      getDb().prepare(`DELETE FROM ${VERDICTS_TABLE} WHERE question_id = ?`).run(payload.questionId);
      await deliverVerdictMessage(
        request,
        `ℹ️ Verdict not submitted: ${url} is already ${merged === 'true' ? 'merged' : state}.`,
      );
      const alias = aliasForSession(request.session_id);
      const session = getSession(request.session_id);
      const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
      const adapter = getDeliveryAdapter();
      if (alias && mg && adapter?.setAgentSessionStatus) {
        await adapter.setAgentSessionStatus(
          mg.channel_type,
          alias.platform_id,
          alias.alias_thread_id,
          'closed',
          mg.instance,
        );
        if (!alias.closed_at) {
          getDb()
            .prepare(`UPDATE ${TABLE} SET closed_at = ? WHERE session_id = ?`)
            .run(new Date().toISOString(), request.session_id);
        }
      }
      return true;
    }
    if (currentHead !== request.head_sha) {
      getDb().prepare(`DELETE FROM ${VERDICTS_TABLE} WHERE question_id = ?`).run(payload.questionId);
      await deliverVerdictMessage(
        request,
        `⚠️ Verdict not submitted: the reviewed head was \`${request.head_sha.slice(0, 12)}\`, but GitHub is now at \`${currentHead.slice(0, 12)}\`. A fresh re-review will run.`,
      );
      return true;
    }

    const body = payload.value === 'REQUEST_CHANGES' ? 'See unresolved review comments.' : '';
    await gh([
      'api',
      '-X',
      'POST',
      `${endpoint}/reviews`,
      '-f',
      `event=${payload.value}`,
      '-f',
      `commit_id=${request.head_sha}`,
      '-f',
      `body=${body}`,
    ]);
    getDb().prepare(`DELETE FROM ${VERDICTS_TABLE} WHERE question_id = ?`).run(payload.questionId);
    await deliverVerdictMessage(request, `✅ Verdict submitted: ${payload.value} — [${url}](${url})`);

    const alias = aliasForSession(request.session_id);
    const session = getSession(request.session_id);
    const mg = session?.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const adapter = getDeliveryAdapter();
    const status: AgentSessionStatus = payload.value === 'APPROVE' ? 'closed' : 'active';
    if (alias && mg && adapter?.setAgentSessionStatus) {
      await adapter.setAgentSessionStatus(
        mg.channel_type,
        alias.platform_id,
        alias.alias_thread_id,
        status,
        mg.instance,
      );
      if (status === 'closed' && !alias.closed_at) {
        getDb()
          .prepare(`UPDATE ${TABLE} SET closed_at = ? WHERE session_id = ?`)
          .run(new Date().toISOString(), request.session_id);
      }
    }
    log.info('Reviewer verdict applied by host', {
      pr: request.pr_key,
      headSha: request.head_sha,
      verdict: payload.value,
      userId: payload.userId,
    });
  } catch (err) {
    log.error('Host failed to apply reviewer verdict', { pr: request.pr_key, headSha: request.head_sha, err });
    await deliverVerdictMessage(
      request,
      `⚠️ Verdict failed on [${url}](${url}): ${err instanceof Error ? err.message : String(err)}`,
    );
    await redeliverVerdictCard(request);
  }
  return true;
}

registerResponseHandler(handleReviewerVerdict);

setAgentSessionStoppedHandler(async ({ instance, channelId, threadTs, userId }) => {
  if (!hasTable(getDb(), TABLE)) return;
  const aliasThreadId = `slack:${channelId}:${threadTs}`;
  const alias = getDb().prepare(`SELECT * FROM ${TABLE} WHERE alias_thread_id = ?`).get(aliasThreadId) as
    | AliasRow
    | undefined;
  if (!alias) return;
  const session = getSession(alias.session_id);
  if (!session) return;

  killContainer(session.id, `Slack agent session stopped by ${userId}`);
  const inDb = openInboundDb(session.agent_group_id, session.id);
  try {
    inDb.prepare("UPDATE messages_in SET status = 'cancelled' WHERE status IN ('pending', 'processing')").run();
  } finally {
    inDb.close();
  }
  const adapter = getDeliveryAdapter();
  await adapter?.setAgentSessionStatus?.('slack', alias.platform_id, alias.alias_thread_id, 'active', instance);
  log.info('Stopped reviewer work from native Slack control', { sessionId: session.id, threadTs, userId });
});
