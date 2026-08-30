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

import type Database from 'better-sqlite3';

import { setAgentSessionStoppedHandler } from '../../channels/chat-sdk-bridge.js';
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
import type { Session } from '../../types.js';

const TABLE = 'reviewer_agent_session_aliases';
const PENDING_MARKER = 'pending-pr-';

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

  if (!alias) {
    platformMessageId = await adapter.deliver(
      channelType,
      platformId,
      null,
      msg.kind,
      msg.content,
      undefined,
      mg?.instance,
    );
    if (!platformMessageId) throw new Error('Slack did not return a message timestamp for agent-session root');
    const title = `${key} - human signoff`.slice(0, 200);
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
      msg.kind,
      msg.content,
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
  log.info('Reviewer agent session awaiting human action', { sessionId: session.id, key, threadTs: alias.thread_ts });
  return { handled: true, platformMessageId };
}

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
