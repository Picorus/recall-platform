// Usage: node tools/repo-checks/src/check-commit-messages.ts <base-sha> <head-sha>
// Fails if any commit after base, up to head, does not start with a step id.
import { execFileSync } from 'node:child_process';
import { isValidCommitSubject } from './commit-message.ts';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: check-commit-messages.ts <base-sha> <head-sha>');
  process.exit(2);
}

const log = execFileSync('git', ['log', '--format=%h%x09%p%x09%s', `${base}..${head}`], {
  encoding: 'utf8',
});
const bad = log
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'))
  .filter(([, parents = '', ...subject]) => {
    const parentCount = parents.split(' ').filter(Boolean).length;
    return !isValidCommitSubject(subject.join('\t'), parentCount);
  });

if (bad.length > 0) {
  console.error('These commits do not start with a step id like "P1.1.2: ":');
  for (const [sha, , ...subject] of bad) console.error(`  ${sha} ${subject.join('\t')}`);
  process.exit(1);
}
console.log('All commit messages start with a step id.');
