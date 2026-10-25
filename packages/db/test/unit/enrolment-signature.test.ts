// The Kotlin player's enrolment request (made by its own code, kept in the shared cases) must pass
// the cloud's signature check: both sides speak the same bytes and the same signature format.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enrolmentSigned, type SignedEnrolment } from '../../src/screens.js';

const V = JSON.parse(
  readFileSync(
    new URL('../../../domain/test-vectors/screen-identity.json', import.meta.url),
    'utf8',
  ),
) as {
  kotlinSigned: {
    request: Omit<SignedEnrolment, 'tlsSignature' | 'playSignature'>;
    tlsSignature: string;
    playSignature: string;
  };
};

describe('enrolment signed by the Kotlin player (P2.1)', () => {
  it('is accepted; changed by one character, it is not', () => {
    const k = V.kotlinSigned;
    const req: SignedEnrolment = {
      ...k.request,
      tlsSignature: k.tlsSignature,
      playSignature: k.playSignature,
    };
    expect(enrolmentSigned(req)).toBe(true);
    expect(enrolmentSigned({ ...req, model: `${req.model}.` })).toBe(false);
    expect(enrolmentSigned({ ...req, playSignature: req.tlsSignature })).toBe(false);
  });
});
