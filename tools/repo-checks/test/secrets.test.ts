// Hard rule 6: never commit secrets. CI also runs gitleaks; this catches the obvious ones on a laptop.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    const envFiles = repoFiles().filter((file) => /(^|\/)\.env(\..+)?$/.test(file));
    expect(envFiles.filter((file) => !file.endsWith('.env.example'))).toEqual([]);
  });
});

// A localhost address, a short lowercase word (like "fake" or a bucket name), or a number.
const LAPTOP_VALUE =
  /^([a-z]+:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)([:/].*)?|[a-z][a-z0-9-]{0,30}|\d+)$/;

describe('.env.example', () => {
  const path = join(root, '.env.example');

  it('exists', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('holds names only, apart from laptop settings that point at docker-compose', () => {
    const problems: string[] = [];
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
        if (!match) {
          problems.push(`line ${index + 1}: not NAME=value`);
          return;
        }
        const [, name = '', value = ''] = match;
        if (!value) return;
        // LOCAL_ names are the throwaway passwords of the laptop containers, never real keys.
        if (name.startsWith('LOCAL_')) return;
        if (/(KEY|SECRET|TOKEN|PASSWORD|CERT)$/.test(name)) {
          problems.push(`line ${index + 1}: ${name} must be empty here; set it in your own .env`);
        } else if (!LAPTOP_VALUE.test(value)) {
          problems.push(`line ${index + 1}: ${name} has a value that is not a laptop setting`);
        }
      });
    expect(problems).toEqual([]);
  });
});
