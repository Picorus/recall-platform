// The demo builds its websites again when the code has changed (after `git pull`), and reuses them
// otherwise.
import { describe, expect, it } from 'vitest';
import { codeVersion, needsBuild } from '../../src/builds.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('demo website builds', () => {
  it('builds when there is no build', () => {
    expect(needsBuild(false, A, A)).toBe(true);
    expect(needsBuild(false, undefined, null)).toBe(true);
  });
  it('reuses a build made from the code checked out now', () => {
    expect(needsBuild(true, A, A)).toBe(false);
  });
  it('builds again after the code changed, or when it is not known what it was built from', () => {
    expect(needsBuild(true, A, B)).toBe(true);
    expect(needsBuild(true, undefined, A)).toBe(true);
  });
  it('without git, keeps any build it has', () => {
    expect(needsBuild(true, undefined, null)).toBe(false);
  });
  it('reads the commit of this checkout', () => {
    expect(codeVersion(process.cwd())).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
