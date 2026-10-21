// Hard rule 6: never commit secrets. CI also runs gitleaks; this catches the obvious ones on a laptop.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEnvExample } from '../src/env-example.ts';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function repoFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return out.split('\0').filter((file) => file && existsSync(join(root, file)));
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Razorpay live key', /\brzp_live_[A-Za-z0-9]{10,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe-style live key', /\b[sr]k_live_[0-9A-Za-z]{16,}\b/],
];

describe('no secrets in the repository', () => {
  it('no file matches a known key pattern', () => {
    const hits: string[] = [];
    for (const file of repoFiles()) {
      const text = readFileSync(join(root, file), 'utf8');
      if (text.includes('\0')) continue; // binary
      for (const [name, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) hits.push(`${file}: looks like a ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no real .env file is tracked', () => {
    const envFiles = repoFiles().filter((file) =>
      /(^|\/)([^/]*\.env|\.env(\..+)?|\.envrc)$/.test(file),
    );
    expect(envFiles.filter((file) => !file.endsWith('.env.example'))).toEqual([]);
  });
});

describe('.env.example', () => {
  const path = join(root, '.env.example');

  it('exists and holds names only, apart from laptop settings', () => {
    expect(existsSync(path)).toBe(true);
    expect(checkEnvExample(readFileSync(path, 'utf8'))).toEqual([]);
  });
});
