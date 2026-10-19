import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  countOutstandingReviewMessages,
  isPendingVerdictMessage,
  loadConfig,
  reviewerWakeReason,
  type Config,
} from './lib.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reviewer configuration', () => {
  it('requires explicit identities and a DM before it can dispatch', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'test-token');
    vi.stubEnv('PR_SELF_LOGIN', '');
    vi.stubEnv('PR_REVIEWS_DM', '');
    vi.stubEnv('PR_OWNER_SLACK_ID', '');
    expect(() => loadConfig()).toThrow(
      'Missing reviewer configuration: PR_SELF_LOGIN, PR_REVIEWS_DM, PR_OWNER_SLACK_ID',
    );
  });

  it('targets the configured reviewer and DM without personal fallbacks', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'test-token');
    vi.stubEnv('PR_SELF_LOGIN', 'reviewer-test');
    vi.stubEnv('PR_REVIEWS_DM', 'DOWNER');
    vi.stubEnv('PR_OWNER_SLACK_ID', 'UOWNER');
    vi.stubEnv('PR_SEARCH_QUERY', '');
    vi.stubEnv('PR_REVIEWS_CHANNEL', '');
    expect(loadConfig()).toMatchObject({
      selfLogin: 'reviewer-test',
      ownerSlackId: 'UOWNER',
      reviewsDm: 'DOWNER',
      reviewsChannel: 'DOWNER',
      prSearchQuery: 'is:pr review-requested:reviewer-test org:apiiro state:open',
    });
    vi.stubEnv('PR_REVIEWS_DM', 'CCHANNEL');
    expect(() => loadConfig()).toThrow('PR_REVIEWS_DM must be a Slack DM ID');
  });
});

describe('PR reviewer notification policy', () => {
  it('wakes only when review is first requested or re-requested', () => {
    const current = (reviewRequested: boolean, reviewRequestId: string, headSha: string, updatedAt: string) => ({
      reviewRequested,
      reviewRequestId,
      headSha,
      updatedAt,
    });

    expect(reviewerWakeReason(null, current(true, 'request-1', 'a', '1'))).toBe('initial_request');
    expect(reviewerWakeReason(current(true, 'request-1', 'a', '1'), current(true, 'request-1', 'b', '2'))).toBeNull();
    expect(reviewerWakeReason(current(true, 'request-1', 'a', '1'), current(false, 'request-1', 'b', '2'))).toBeNull();
    expect(reviewerWakeReason(current(false, 'request-1', 'b', '2'), current(false, 'request-1', 'c', '3'))).toBeNull();
    expect(reviewerWakeReason(current(false, 'request-1', 'b', '2'), current(true, 'request-2', 'c', '3'))).toBe(
      'review_rerequested',
    );
    expect(reviewerWakeReason(current(true, 'request-1', 'b', '2'), current(true, 'request-2', 'c', '3'))).toBe(
      'review_rerequested',
    );
    expect(
      reviewerWakeReason(
        { reviewRequested: undefined, reviewRequestId: undefined, headSha: 'b', updatedAt: '2' },
        current(true, 'request-2', 'c', '3'),
      ),
    ).toBeNull();
  });

  it('only treats an explicit final-verdict request as reminder-eligible', () => {
    expect(isPendingVerdictMessage('<@U1> Ready for final verdict')).toBe(true);
    expect(isPendingVerdictMessage('No follow-up warranted; required CI passed.')).toBe(false);
    expect(isPendingVerdictMessage('One blocking issue remains.')).toBe(false);
    expect(isPendingVerdictMessage(undefined)).toBe(false);
  });

  it('counts only unfinished native reviewer messages', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-capacity-'));
    tempDirs.push(dataDir);
    const central = new Database(path.join(dataDir, 'v2.db'));
    central.exec('CREATE TABLE sessions (id TEXT, agent_group_id TEXT, thread_id TEXT)');
    central
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run('review-session', 'reviewer', 'slack:D1:pending-pr-YWNtZS93aWRnZXRzIzE');
    central.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('chat-session', 'reviewer', 'slack:D1:ordinary');
    central.close();

    for (const [session, status] of [
      ['review-session', 'pending'],
      ['chat-session', 'pending'],
    ] as const) {
      const dir = path.join(dataDir, 'v2-sessions', 'reviewer', session);
      fs.mkdirSync(dir, { recursive: true });
      const inbound = new Database(path.join(dir, 'inbound.db'));
      inbound.exec('CREATE TABLE messages_in (status TEXT)');
      inbound.prepare('INSERT INTO messages_in VALUES (?)').run(status);
      inbound.close();
    }

    expect(countOutstandingReviewMessages({ reviewsDm: 'D1' } as Config, dataDir)).toBe(1);
  });

  it('keeps findings GitHub-only and limits Slack to the three allowed cases', () => {
    const persona = fs.readFileSync('templates/pr-reviewer/ai.nanoco.nanoclaw/context/instructions.md', 'utf8');
    const skill = fs.readFileSync('templates/pr-reviewer/skills/pr-review/SKILL.md', 'utf8');
    const dispatcher =
      fs.readFileSync('scripts/pr-reviewer/dispatch.ts', 'utf8') +
      fs.readFileSync('scripts/pr-reviewer/prompts.ts', 'utf8');

    expect(persona).toContain('Silence is the default');
    expect(persona).toContain('Produce visible Slack output only when');
    expect(persona).toContain('Findings and finding changes are GitHub-only');
    expect(persona).toContain('<internal>no user-visible update</internal>');
    expect(skill).toContain('The model recommends; the host acts');
    expect(skill).toContain('PR_REVIEW_VERDICT');
    expect(persona).toContain('The model never submits');
    expect(persona).toContain('completion receipts');
    expect(dispatcher).toContain('Findings and finding changes are GitHub-only');
    expect(persona).toContain('one final-verdict card is needed');
    expect(dispatcher).toContain('pendingSlackReviewThreadId');
    expect(dispatcher).not.toContain('postRootMessage');
  });
});
