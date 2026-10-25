import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkCharacter,
  enrolmentBytes,
  enrolmentProblem,
  isScreenId,
  newScreenId,
  numberPlate,
  screenIdFromQr,
  type EnrolmentRequest,
} from '../src/screen-identity.js';

interface Vectors {
  ids: { random: number[]; id: string }[];
  checkCharacterOf: { body: string; check: string };
  checks: { text: string; valid: boolean }[];
  qrs: { text: string; screenId: string | null }[];
  plates: { text: string; plate: string | null }[];
  enrolment: { request: EnrolmentRequest; bytes: string };
}
const V = JSON.parse(
  readFileSync(new URL('../test-vectors/screen-identity.json', import.meta.url), 'utf8'),
) as Vectors;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('screen identity (P2.1): the shared cases the Kotlin player also passes', () => {
  it('ids, checks, QR texts, number plates and enrolment bytes', () => {
    for (const x of V.ids) expect(newScreenId(x.random)).toBe(x.id);
    expect(checkCharacter(V.checkCharacterOf.body)).toBe(V.checkCharacterOf.check);
    for (const x of V.checks) expect([x.text, isScreenId(x.text)]).toEqual([x.text, x.valid]);
    for (const x of V.qrs) expect(screenIdFromQr(x.text) ?? null).toBe(x.screenId);
    for (const x of V.plates) expect(numberPlate(x.text) ?? null).toBe(x.plate);
    expect(enrolmentBytes(V.enrolment.request)).toBe(V.enrolment.bytes);
  });

  it('property: one wrong character anywhere in an id is always caught', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 31 }), { minLength: 7, maxLength: 7 }),
        fc.integer({ min: 4, max: 11 }),
        fc.integer({ min: 1, max: 31 }),
        (random, at, shift) => {
          const id = newScreenId(random);
          const c = ALPHABET[(ALPHABET.indexOf(id[at] ?? '0') + shift) % 32] ?? '0';
          expect(isScreenId(id.slice(0, at) + c + id.slice(at + 1))).toBe(false);
        },
      ),
    );
  });

  it('an enrolment request is checked before anything is stored', () => {
    const r = V.enrolment.request;
    expect(enrolmentProblem(r)).toBeUndefined();
    expect(enrolmentProblem({ ...r, hardwareSerial: 'a b' })).toBe('bad hardware serial');
    expect(enrolmentProblem({ ...r, playPublicKey: r.tlsPublicKey })).toBe(
      'the two keys must be different',
    );
    expect(() => newScreenId([1, 2, 3])).toThrow();
  });
});
