import { describe, expect, it } from 'vitest';
import { isValidCommitSubject } from '../src/commit-message.ts';

describe('commit subjects', () => {
  it.each([
    'P0.2: repository set-up',
    'P1.1.2: version areas',
    'P7: launch',
    "Merge branch 'main' into claude/festive-meitner-kb0teg",
    'Merge pull request #4 from picorus/claude/x',
    'Revert "P1.1.2: version areas"',
  ])('accepts %s', (subject) => {
    expect(isValidCommitSubject(subject)).toBe(true);
  });

  it.each([
    'Initial commit',
    'fix stuff',
    'P1.1.2 version areas',
    'P1.1.2:version areas',
    'p1.1: lower case',
    'P1.: trailing dot',
    'WIP P1.1: later',
  ])('rejects %s', (subject) => {
    expect(isValidCommitSubject(subject)).toBe(false);
  });
});
