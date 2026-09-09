import fs from 'fs';

import { describe, expect, it } from 'vitest';

import { isPendingVerdictMessage, reviewerWakeReason } from './lib.js';

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

  it('keeps findings GitHub-only and limits Slack to the three allowed cases', () => {
    const persona = fs.readFileSync('templates/pr-reviewer/ai.nanoco.nanoclaw/context/instructions.md', 'utf8');
    const skill = fs.readFileSync('templates/pr-reviewer/skills/pr-review/SKILL.md', 'utf8');
    const dispatcher = fs.readFileSync('scripts/pr-reviewer/dispatch.ts', 'utf8');

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
