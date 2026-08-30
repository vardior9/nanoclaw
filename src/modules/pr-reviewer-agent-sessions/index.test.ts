import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import {
  deliverPendingReviewerAgentSession,
  findReviewerSessionByAlias,
  pendingReviewerThreadId,
  prKeyFromPendingThread,
} from './index.js';

const session: Session = {
  id: 'sess-review',
  agent_group_id: 'ag-reviewer',
  messaging_group_id: 'mg-dm',
  thread_id: pendingReviewerThreadId('DOWNER', 'apiiro/guardian#123'),
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-08-30T00:00:00.000Z',
};

const msg = {
  id: 'out-1',
  kind: 'chat',
  // The reviewer skill names its legacy channel destination. Pending review
  // sessions must still force the first visible output into their DM origin.
  platform_id: 'slack:CREVIEWS',
  channel_type: 'slack',
  thread_id: 'slack:CREVIEWS:legacy-thread',
  content: JSON.stringify({ text: 'Ready for final verdict' }),
};

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
    'ag-reviewer',
    'PR Reviewer',
    'pr-reviewer',
    session.created_at,
  );
  db.prepare(
    'INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('mg-dm', 'slack', 'slack:DOWNER', 'slack', 'owner DM', 0, 'strict', session.created_at);
  db.prepare(
    `INSERT INTO sessions
      (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
  ).run(session);
});

afterEach(() => closeDb());

function fakeAdapter() {
  let rootCalls = 0;
  let threadCalls = 0;
  const adapter: ChannelDeliveryAdapter = {
    deliver: vi.fn(async (type, platform, threadId) => {
      expect(type).toBe('slack');
      expect(platform).toBe('slack:DOWNER');
      if (threadId) {
        threadCalls++;
        return `reply-${threadCalls}`;
      }
      rootCalls++;
      return '1788000000.123456';
    }),
    setAgentSessionStatus: vi.fn(async () => {}),
  };
  return { adapter, counts: () => ({ rootCalls, threadCalls }) };
}

describe('reviewer action-only agent sessions', () => {
  it('round-trips the PR key in a synthetic thread id', () => {
    expect(prKeyFromPendingThread(session.thread_id)).toBe('apiiro/guardian#123');
  });

  it('materializes exactly one root and resolves the real thread as an alias', async () => {
    const { adapter, counts } = fakeAdapter();
    const result = await deliverPendingReviewerAgentSession(msg, session, adapter);

    expect(result).toEqual({ handled: true, platformMessageId: '1788000000.123456' });
    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 0 });
    expect(adapter.setAgentSessionStatus).toHaveBeenCalledWith(
      'slack',
      'slack:DOWNER',
      'slack:DOWNER:1788000000.123456',
      'suspended',
      'slack',
      expect.objectContaining({ title: 'apiiro/guardian#123 - human signoff' }),
    );
    expect(findReviewerSessionByAlias('ag-reviewer', 'mg-dm', 'slack:DOWNER:1788000000.123456')?.id).toBe(session.id);
  });

  it('does not duplicate the root when lifecycle creation fails after posting', async () => {
    const { adapter, counts } = fakeAdapter();
    vi.mocked(adapter.setAgentSessionStatus!).mockRejectedValueOnce(new Error('temporary Slack failure'));

    await expect(deliverPendingReviewerAgentSession(msg, session, adapter)).rejects.toThrow('temporary Slack failure');
    await expect(deliverPendingReviewerAgentSession(msg, session, adapter)).resolves.toEqual({
      handled: true,
      platformMessageId: '1788000000.123456',
    });
    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 0 });
    expect(getDb().prepare('SELECT status_created_at FROM reviewer_agent_session_aliases').get()).toEqual({
      status_created_at: expect.any(String),
    });
  });

  it('delivers later output inside the materialized agent session', async () => {
    const { adapter, counts } = fakeAdapter();
    await deliverPendingReviewerAgentSession(msg, session, adapter);
    const later = { ...msg, id: 'out-2', content: JSON.stringify({ text: 'One more thing' }) };

    await expect(deliverPendingReviewerAgentSession(later, session, adapter)).resolves.toEqual({
      handled: true,
      platformMessageId: 'reply-1',
    });
    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 1 });
  });
});
