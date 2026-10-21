// CLAUDE.md: commit messages start with the step id, e.g. "P1.1.2: version areas".

const STEP_SUBJECT = /^P\d+(\.\d+)*: \S/;
const GIT_GENERATED = /^(Merge (branch|pull request|remote-tracking branch) |Revert "P\d)/;

export function isValidCommitSubject(subject: string): boolean {
  return STEP_SUBJECT.test(subject) || GIT_GENERATED.test(subject);
}
