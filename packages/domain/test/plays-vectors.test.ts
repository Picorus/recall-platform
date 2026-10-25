// P2.7: the shared play cases (test-vectors/plays.json) still match the cloud's own code, and their
// signatures check out the way the cloud checks a screen's (ECDSA P-256, SHA-256, DER).
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPlayShape, playBytes, type PlayReport } from '../src/plays.js';

interface Vectors {
  publicKey: string;
  cases: {
    name: string;
    screenId: string;
    seq: number;
    play: Omit<PlayReport, 'sig'>;
    bytes: string;
    sig: string;
  }[];
}
const v = JSON.parse(
  readFileSync(new URL('../test-vectors/plays.json', import.meta.url), 'utf8'),
) as Vectors;
const key = createPublicKey({
  key: Buffer.from(v.publicKey, 'base64'),
  format: 'der',
  type: 'spki',
});

describe('shared play cases (P2.7)', () => {
  it.each(v.cases)('$name', (c) => {
    expect(playBytes(c.screenId, c.seq, c.play)).toBe(c.bytes);
    expect(checkPlayShape({ ...c.play, sig: c.sig })).toBeUndefined();
    const ok = verify(
      'sha256',
      Buffer.from(c.bytes, 'utf8'),
      { key, dsaEncoding: 'der' },
      Buffer.from(c.sig, 'base64'),
    );
    expect(ok).toBe(true);
    // One changed byte (another sequence number) and the signature no longer holds.
    const other = playBytes(c.screenId, c.seq + 1, c.play);
    expect(
      verify(
        'sha256',
        Buffer.from(other, 'utf8'),
        { key, dsaEncoding: 'der' },
        Buffer.from(c.sig, 'base64'),
      ),
    ).toBe(false);
  });
});
