// Which website builds the demo can reuse. A build is kept only while the code it was made from is
// the code checked out now: after `git pull` the staff and brand portals and the rider app are built
// again, so the demo never shows an old version. The commit each was built from is kept in
// tools/demo/.built.json (not committed). Without git the old rule holds: build only when missing.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Builds = Readonly<Record<string, string>>;

/** The commit checked out now, or null when git cannot say. */
export function codeVersion(root: string): string | null {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Build again when there is no build, or it was made from other code than `now`. */
export function needsBuild(present: boolean, builtFrom: string | undefined, now: string | null) {
  return !present || (now !== null && builtFrom !== now);
}

const file = (root: string) => join(root, 'tools', 'demo', '.built.json');

export function readBuilds(root: string): Builds {
  try {
    const v: unknown = JSON.parse(readFileSync(file(root), 'utf8'));
    return v && typeof v === 'object' ? (v as Builds) : {};
  } catch {
    return {};
  }
}

export function noteBuild(root: string, app: string, version: string | null): void {
  if (version === null) return;
  const next = { ...readBuilds(root), [app]: version };
  writeFileSync(file(root), `${JSON.stringify(next, null, 2)}\n`);
}
