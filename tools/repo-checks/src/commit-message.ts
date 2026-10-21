// CLAUDE.md: commit messages start with the step id, e.g. "P1.1.2: version areas".

const STEP_SUBJECT = /^P\d+(\.\d+)*: \S/;
const MERGE_SUBJECT = /^Merge (branch|pull request|remote-tracking branch) /;
const REVERT_SUBJECT = /^Revert "P\d/;

/** `parents` is the commit's parent count: git's own "Merge …" wording is only allowed on real merges. */
export function isValidCommitSubject(subject: string, parents = 1): boolean {
  if (STEP_SUBJECT.test(subject) || REVERT_SUBJECT.test(subject)) return true;
  return parents >= 2 && MERGE_SUBJECT.test(subject);
}
