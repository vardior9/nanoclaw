import { describe, expect, it } from 'vitest';

import { type PrDetail, isReviewRequested } from './lib.js';

const reviewer = { login: 'vardior9', teams: new Set(['apiiro/technical-leadership']) };

function prRequesting(users: string[], teams: string[]): PrDetail {
  return {
    requested_reviewers: users.map((login) => ({ login })),
    requested_teams: teams.map((slug) => ({ slug })),
  } as PrDetail;
}

describe('isReviewRequested', () => {
  it('matches a direct request regardless of login case', () => {
    expect(isReviewRequested('apiiro', prRequesting(['VardiOr9'], []), reviewer)).toBe(true);
  });

  it('matches a request to a team the reviewer belongs to', () => {
    expect(isReviewRequested('apiiro', prRequesting(['someone-else'], ['technical-leadership']), reviewer)).toBe(true);
  });

  it('ignores a team with the same slug in another org', () => {
    expect(isReviewRequested('other-org', prRequesting([], ['technical-leadership']), reviewer)).toBe(false);
  });

  it('ignores requests to other people and teams', () => {
    expect(isReviewRequested('apiiro', prRequesting(['someone-else'], ['platform']), reviewer)).toBe(false);
  });
});
