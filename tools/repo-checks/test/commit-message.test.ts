import { describe, expect, it } from 'vitest';
import { isValidCommitSubject } from '../src/commit-message.ts';

describe('commit subjects', () => {
  it.each([
    'P0.2: repository set-up',
    'P1.1.2: version areas',
    'P7: launch',
    'P5.3–P5.4: my campaigns and book',
    'P4.4-P4.6: today, earnings, payouts',
    'Revert "P1.1.2: version areas"',
  ])('accepts %s', (subject) => {
    expect(isValidCommitSubject(subject)).toBe(true);
  });

  it.each([
    "Merge branch 'main' into claude/festive-meitner-kb0teg",
    'Merge pull request #4 from picorus/claude/x',
  ])('accepts git merge wording only on a real merge: %s', (subject) => {
    expect(isValidCommitSubject(subject, 2)).toBe(true);
    expect(isValidCommitSubject(subject, 1)).toBe(false);
  });

  it.each([
    'Initial commit',
    'fix stuff',
    'P1.1.2 version areas',
    'P1.1.2:version areas',
    'p1.1: lower case',
    'P1.: trailing dot',
    'WIP P1.1: later',
    'P5.3–: half a range',
    'P5.3–5.4: second id without P',
    'P5.3 – P5.4: spaces',
  ])('rejects %s', (subject) => {
    expect(isValidCommitSubject(subject)).toBe(false);
  });
});
