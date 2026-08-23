import fs from 'fs';

import { describe, expect, it } from 'vitest';

import { isPendingVerdictMessage } from './lib.js';

describe('PR reviewer notification policy', () => {
  it('only treats an explicit final-verdict request as reminder-eligible', () => {
    expect(isPendingVerdictMessage('<@U1> Ready for final verdict')).toBe(true);
    expect(isPendingVerdictMessage('No follow-up warranted; required CI passed.')).toBe(false);
    expect(isPendingVerdictMessage('One blocking issue remains.')).toBe(false);
    expect(isPendingVerdictMessage(undefined)).toBe(false);
  });

  it('keeps the durable template explicit about silent no-op turns', () => {
    const persona = fs.readFileSync('templates/pr-reviewer/ai.nanoco.nanoclaw/context/instructions.md', 'utf8');
    const skill = fs.readFileSync('templates/pr-reviewer/skills/pr-review/SKILL.md', 'utf8');

    expect(persona).toContain('Silence is the default');
    expect(persona).toContain('<internal>no user-visible update</internal>');
    expect(skill).toContain('Never report that no reply or follow-up was warranted');
    expect(skill).toContain('A new head alone does not justify another verdict request');
  });
});
