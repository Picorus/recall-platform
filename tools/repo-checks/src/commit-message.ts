// CLAUDE.md: commit messages start with the step id, e.g. "P1.1.2: version areas".

// One step id, or a range of them for a commit that covers several ("P5.3–P5.4: …", en dash or "-").
const STEP = 'P\\d+(?:\\.\\d+)*';
const STEP_SUBJECT = new RegExp(`^${STEP}(?:[–-]${STEP})?: \\S`);
// Git's own wording, or "Merge main" (the base brought into a step branch).
const MERGE_SUBJECT = /^Merge ((branch|pull request|remote-tracking branch) |main$)/;
const REVERT_SUBJECT = /^Revert "P\d/;

/** `parents` is the commit's parent count: git's own "Merge …" wording is only allowed on real merges. */
export function isValidCommitSubject(subject: string, parents = 1): boolean {
  if (STEP_SUBJECT.test(subject) || REVERT_SUBJECT.test(subject)) return true;
  return parents >= 2 && MERGE_SUBJECT.test(subject);
}
