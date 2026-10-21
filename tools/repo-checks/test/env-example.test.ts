import { describe, expect, it } from 'vitest';
import { checkEnvExample } from '../src/env-example.ts';

const LAPTOP = `# comment
LOCAL_POSTGRES_PASSWORD=recall
DATABASE_URL=postgres://recall:recall@localhost:5432/recall
REDIS_URL=redis://localhost:6379
S3_BUCKET=recall-media
S3_SECRET_KEY=
ADAPTER_MAPS=fake
PORT=3000
`;

describe('.env.example rule', () => {
  it('accepts names only plus laptop settings', () => {
    expect(checkEnvExample(LAPTOP)).toEqual([]);
  });

  it.each([
    ['secret-like name anywhere in it', 'SMTP_PASS=hunter2'],
    ['secret-like name with a suffix', 'WHATSAPP_TOKEN_V2=abc'],
    ['credentials', 'GOOGLE_CREDENTIALS=abc'],
    ['long random value', 'SOME_ID=x9f3kq2m7p1z8w4r6t0y5u3i2o1a7s9d8f7g6h'],
    [
      'remote host hidden after localhost',
      'DATABASE_URL=postgres://localhost:S3cr3t@prod.db.example.com/recall',
    ],
    [
      'real password on a localhost URL',
      'DATABASE_URL=postgres://recall:Real-Pa55word@localhost:5432/recall',
    ],
    ['remote URL', 'API_URL=https://api.example.com'],
    ['LOCAL_ value that is not a short word', 'LOCAL_POSTGRES_PASSWORD=Zx81!kq@Lw'],
    ['not NAME=value', 'export FOO=bar'],
  ])('rejects %s', (_, line) => {
    expect(checkEnvExample(`LOCAL_POSTGRES_PASSWORD=recall\n${line}\n`)).toHaveLength(1);
  });
});
