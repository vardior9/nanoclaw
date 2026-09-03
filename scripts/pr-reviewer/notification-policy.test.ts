import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { classifyReviewerActivity, isPendingVerdictMessage } from './lib.js';

describe('PR reviewer notification policy', () => {
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

  it('suppresses an empty approval-only review event', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-activity-gh-'));
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\nprintf '%s' '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[]},"reviews":{"nodes":[{"author":{"login":"teammate"},"state":"APPROVED","body":"","submittedAt":"2026-09-02T08:00:00Z"}]},"reviewThreads":{"nodes":[]}}}}}'\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(classifyReviewerActivity('apiiro', 'guardian', 123, '2026-09-02T07:00:00Z', 'vardior9')).toEqual({
        ok: true,
        foreign: true,
        actionable: false,
        suppressionReason: 'irrelevant_external',
        context: '',
      });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('suppresses unrelated automation and human activity', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-activity-gh-'));
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\nprintf '%s' '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[{"author":{"login":"apiirobot"},"body":"CI passed","createdAt":"2026-09-02T08:00:00Z"},{"author":{"login":"teammate"},"body":"Looks good","createdAt":"2026-09-02T08:01:00Z"}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}'\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(classifyReviewerActivity('apiiro', 'lim', 123, '2026-09-02T07:00:00Z', 'vardior9')).toMatchObject({
        ok: true,
        foreign: true,
        actionable: false,
        suppressionReason: 'irrelevant_external',
      });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('wakes only for direct mentions and replies on unresolved self-authored threads', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-activity-gh-'));
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\nprintf '%s' '{"data":{"repository":{"pullRequest":{"comments":{"nodes":[{"author":{"login":"author"},"body":"@vardior9 please reconsider","createdAt":"2026-09-02T08:00:00Z","url":"https://example/direct"}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[{"isResolved":false,"path":"src/a.ts","line":12,"comments":{"nodes":[{"author":{"login":"vardior9"},"body":"finding","createdAt":"2026-09-02T06:00:00Z"},{"author":{"login":"author"},"body":"fixed in latest","createdAt":"2026-09-02T08:01:00Z","url":"https://example/reply"}]}},{"isResolved":true,"path":"src/b.ts","line":3,"comments":{"nodes":[{"author":{"login":"vardior9"},"body":"old","createdAt":"2026-09-02T06:00:00Z"},{"author":{"login":"author"},"body":"resolved reply","createdAt":"2026-09-02T08:02:00Z"}]}}]}}}}}'\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const result = classifyReviewerActivity('apiiro', 'lim', 123, '2026-09-02T07:00:00Z', 'vardior9');
      expect(result).toMatchObject({ ok: true, foreign: true, actionable: true, suppressionReason: null });
      if (result.ok) {
        expect(result.context).toContain('@vardior9 please reconsider');
        expect(result.context).toContain('src/a.ts:12: fixed in latest');
        expect(result.context).not.toContain('resolved reply');
      }
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
