import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { resolveQuestionRender } from '../../channels/question-render-registry.js';
import type { Session } from '../../types.js';
import {
  deliverPendingReviewerAgentSession,
  findReviewerSessionByAlias,
  handleReviewerVerdict,
  pendingReviewerThreadId,
  prKeyFromPendingThread,
  reviewerSessionTitle,
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
  setDeliveryAdapter(adapter);
  return { adapter, counts: () => ({ rootCalls, threadCalls }) };
}

describe('reviewer agent session titles', () => {
  it('identifies the PR by repo, number and subject', () => {
    expect(reviewerSessionTitle('apiiro/lim#48766', 'Batch the per-artifact reads')).toBe(
      'lim 48766 Batch the per-artifact reads',
    );
  });

  it('falls back to repo and number when the PR title is unknown', () => {
    expect(reviewerSessionTitle('apiiro/lim#48766', null)).toBe('lim 48766');
  });

  it('reduces the title to characters Slack keeps verbatim', () => {
    // Slack stored `apiiro/lim#48766` as `apiiro_lim_48766`; anything it would
    // rewrite must be gone before we hand the title over.
    expect(reviewerSessionTitle('apiiro/lim#48766', '[LIM-1234] fix `parse()` — a/b (#9)')).toBe(
      'lim 48766 LIM-1234 fix parse a b 9',
    );
  });

  it('caps the title so Slack never truncates it for us', () => {
    const title = reviewerSessionTitle('apiiro/lim#48766', 'x'.repeat(400));
    expect(title.length).toBe(120);
  });
});

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
      expect.objectContaining({ title: 'guardian 123' }),
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

  it('turns a structured recommendation into a host-owned Slack card', async () => {
    const { adapter } = fakeAdapter();
    const signal = {
      ...msg,
      content: JSON.stringify({
        text:
          'PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"0123456789abcdef0123456789abcdef01234567"}\n' +
          '<@U010NV4PV29> Ready for final verdict\nhttps://github.com/apiiro/guardian/pull/123',
      }),
    };

    await deliverPendingReviewerAgentSession(signal, session, adapter);

    const delivery = vi.mocked(adapter.deliver).mock.calls[0];
    expect(delivery[3]).toBe('chat-sdk');
    expect(JSON.parse(String(delivery[4]))).toMatchObject({
      type: 'ask_question',
      title: 'Final PR verdict',
      question: 'Ready for final verdict\nhttps://github.com/apiiro/guardian/pull/123',
      options: expect.arrayContaining([expect.objectContaining({ value: 'APPROVE' })]),
    });
    expect(getDb().prepare('SELECT pr_key, head_sha, recommendation FROM reviewer_verdict_requests').get()).toEqual({
      pr_key: 'apiiro/guardian#123',
      head_sha: '0123456789abcdef0123456789abcdef01234567',
      recommendation: 'APPROVE',
    });
  });

  it('delivers only one active card for the same reviewed head', async () => {
    const { adapter, counts } = fakeAdapter();
    const signal = {
      ...msg,
      content: JSON.stringify({
        text: 'PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"0123456789abcdef0123456789abcdef01234567"}\nReady',
      }),
    };

    await deliverPendingReviewerAgentSession(signal, session, adapter);
    await deliverPendingReviewerAgentSession({ ...signal, id: 'out-2' }, session, adapter);

    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 0 });
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM reviewer_verdict_requests WHERE terminal_reason IS NULL').get(),
    ).toEqual({ n: 1 });
  });

  it('expires the prior card when a new head gets a verdict', async () => {
    const { adapter, counts } = fakeAdapter();
    const firstHead = '0123456789abcdef0123456789abcdef01234567';
    const secondHead = '89abcdef0123456789abcdef0123456789abcdef';
    await deliverPendingReviewerAgentSession(
      {
        ...msg,
        content: JSON.stringify({
          text: `PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"${firstHead}"}\nReady`,
        }),
      },
      session,
      adapter,
    );
    const old = getDb().prepare('SELECT question_id FROM reviewer_verdict_requests').get() as { question_id: string };
    await deliverPendingReviewerAgentSession(
      {
        ...msg,
        id: 'out-2',
        content: JSON.stringify({
          text: `PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"${secondHead}"}\nReady again`,
        }),
      },
      session,
      adapter,
    );

    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 2 });
    expect(vi.mocked(adapter.deliver).mock.calls[1][3]).toBe('chat-sdk');
    expect(JSON.parse(String(vi.mocked(adapter.deliver).mock.calls[1][4]))).toMatchObject({
      operation: 'edit',
      messageId: '1788000000.123456',
      terminalCard: { resolution: 'Expired — newer verdict available' },
    });
    expect(resolveQuestionRender(old.question_id)?.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ selectedLabel: 'Expired — newer verdict available' })]),
    );
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM reviewer_verdict_requests WHERE terminal_reason IS NULL').get(),
    ).toEqual({ n: 1 });
  });

  it('handles Hold entirely on the host without writing an agent message', async () => {
    const { adapter, counts } = fakeAdapter();
    const signal = {
      ...msg,
      content: JSON.stringify({
        text: 'PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"0123456789abcdef0123456789abcdef01234567"}\nReady',
      }),
    };
    await deliverPendingReviewerAgentSession(signal, session, adapter);
    const row = getDb().prepare('SELECT question_id FROM reviewer_verdict_requests').get() as { question_id: string };

    await expect(
      handleReviewerVerdict({
        questionId: row.question_id,
        value: 'HOLD',
        userId: 'U010NV4PV29',
        channelType: 'slack',
        platformId: '',
        threadId: null,
      }),
    ).resolves.toBe(true);

    expect(getDb().prepare('SELECT terminal_reason FROM reviewer_verdict_requests').get()).toEqual({
      terminal_reason: 'held',
    });
    expect(counts()).toEqual({ rootCalls: 1, threadCalls: 0 });
  });

  it('submits an approved card on the host with the exact reviewed commit', async () => {
    const { adapter } = fakeAdapter();
    const head = '0123456789abcdef0123456789abcdef01234567';
    await deliverPendingReviewerAgentSession(
      {
        ...msg,
        content: JSON.stringify({
          text: `PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"${head}"}\nReady`,
        }),
      },
      session,
      adapter,
    );
    const row = getDb().prepare('SELECT question_id FROM reviewer_verdict_requests').get() as { question_id: string };
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-gh-'));
    const logPath = path.join(bin, 'calls.log');
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_GH_LOG"\ncase "$*" in\n  *"@tsv"*) printf '${head}\\topen\\tfalse\\n' ;;\n  *) printf '{}\\n' ;;\nesac\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    const oldGhBin = process.env.PR_REVIEWER_GH_BIN;
    process.env.PATH = `${bin}:${oldPath}`;
    process.env.PR_REVIEWER_GH_BIN = ghPath;
    process.env.FAKE_GH_LOG = logPath;
    try {
      await expect(
        handleReviewerVerdict({
          questionId: row.question_id,
          value: 'APPROVE',
          userId: 'U010NV4PV29',
          channelType: 'slack',
          platformId: '',
          threadId: null,
        }),
      ).resolves.toBe(true);
      const calls = fs.readFileSync(logPath, 'utf8');
      expect(calls).toContain(`event=APPROVE -f commit_id=${head}`);
      expect(getDb().prepare('SELECT terminal_reason FROM reviewer_verdict_requests').get()).toEqual({
        terminal_reason: 'applied',
      });
    } finally {
      process.env.PATH = oldPath;
      if (oldGhBin === undefined) delete process.env.PR_REVIEWER_GH_BIN;
      else process.env.PR_REVIEWER_GH_BIN = oldGhBin;
      delete process.env.FAKE_GH_LOG;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('closes the card without submitting when GitHub says the PR is already merged', async () => {
    const { adapter } = fakeAdapter();
    const head = '0123456789abcdef0123456789abcdef01234567';
    await deliverPendingReviewerAgentSession(
      {
        ...msg,
        content: JSON.stringify({
          text: `PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"${head}"}\nReady`,
        }),
      },
      session,
      adapter,
    );
    const row = getDb().prepare('SELECT question_id FROM reviewer_verdict_requests').get() as { question_id: string };
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-gh-'));
    const logPath = path.join(bin, 'calls.log');
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_GH_LOG"\nprintf '${head}\\tclosed\\ttrue\\n'\n`,
      { mode: 0o755 },
    );
    const oldGhBin = process.env.PR_REVIEWER_GH_BIN;
    process.env.PR_REVIEWER_GH_BIN = ghPath;
    process.env.FAKE_GH_LOG = logPath;
    try {
      await expect(
        handleReviewerVerdict({
          questionId: row.question_id,
          value: 'APPROVE',
          userId: 'U010NV4PV29',
          channelType: 'slack',
          platformId: '',
          threadId: null,
        }),
      ).resolves.toBe(true);
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain('/reviews');
      expect(getDb().prepare('SELECT terminal_reason FROM reviewer_verdict_requests').get()).toEqual({
        terminal_reason: 'closed',
      });
      expect(adapter.setAgentSessionStatus).toHaveBeenLastCalledWith(
        'slack',
        'slack:DOWNER',
        'slack:DOWNER:1788000000.123456',
        'closed',
        'slack',
      );
    } finally {
      if (oldGhBin === undefined) delete process.env.PR_REVIEWER_GH_BIN;
      else process.env.PR_REVIEWER_GH_BIN = oldGhBin;
      delete process.env.FAKE_GH_LOG;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('retains expired card metadata so a late click renders a terminal result', async () => {
    const { adapter } = fakeAdapter();
    const head = '0123456789abcdef0123456789abcdef01234567';
    await deliverPendingReviewerAgentSession(
      {
        ...msg,
        content: JSON.stringify({
          text: `PR_REVIEW_VERDICT {"recommendation":"APPROVE","head_sha":"${head}"}\nReady`,
        }),
      },
      session,
      adapter,
    );
    const row = getDb().prepare('SELECT question_id FROM reviewer_verdict_requests').get() as { question_id: string };
    getDb()
      .prepare('UPDATE reviewer_agent_session_aliases SET closed_at = ? WHERE session_id = ?')
      .run('2026-09-02T13:14:53.294Z', session.id);

    expect(resolveQuestionRender(row.question_id)?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'APPROVE', selectedLabel: 'Expired — PR already closed' }),
      ]),
    );
    await expect(
      handleReviewerVerdict({
        questionId: row.question_id,
        value: 'APPROVE',
        userId: 'U010NV4PV29',
        channelType: 'slack',
        platformId: '',
        threadId: null,
      }),
    ).resolves.toBe(true);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM reviewer_verdict_requests').get()).toEqual({ n: 1 });
  });

  it('leaves an ordinary message awaiting the human', async () => {
    const { adapter } = fakeAdapter();
    await deliverPendingReviewerAgentSession(msg, session, adapter);
    const later = { ...msg, id: 'out-2', content: JSON.stringify({ text: 'Verdict submitted soon?' }) };

    await deliverPendingReviewerAgentSession(later, session, adapter);

    expect(adapter.setAgentSessionStatus).toHaveBeenLastCalledWith(
      'slack',
      'slack:DOWNER',
      'slack:DOWNER:1788000000.123456',
      'suspended',
      'slack',
      undefined,
    );
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
