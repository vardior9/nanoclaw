import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { hasForeignActivity, isPendingVerdictMessage } from './lib.js';

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

  it('does not wake the model for an empty approval-only review event', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-activity-gh-'));
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\ncase "$*" in\n  *"/reviews"*) printf '[{"user":{"login":"teammate"},"state":"APPROVED","body":"","submitted_at":"2026-09-02T08:00:00Z"}]' ;;\n  *) printf '[]' ;;\nesac\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(hasForeignActivity('apiiro', 'guardian', 123, '2026-09-02T07:00:00Z', 'vardior9')).toEqual({
        ok: true,
        foreign: false,
        nonActionableAutomationOnly: false,
        context: '',
      });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('classifies repeated green CI summaries as non-actionable automation', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-activity-gh-'));
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!/bin/sh\ncase "$*" in\n  *"issues"*) printf '[{"user":{"login":"apiirobot","type":"User"},"body":":green_circle: **Feature-branch CI passed.** All required checks completed successfully.","created_at":"2026-09-02T08:00:00Z"}]' ;;\n  *) printf '[]' ;;\nesac\n`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      expect(hasForeignActivity('apiiro', 'lim', 123, '2026-09-02T07:00:00Z', 'vardior9')).toMatchObject({
        ok: true,
        foreign: true,
        nonActionableAutomationOnly: true,
      });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});
