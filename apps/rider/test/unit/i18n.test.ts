// P4.1: every word of the rider app in all three languages, in the right script; errors by their
// reason code; the API client's errors.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, call } from '../../src/api';
import { LANGUAGE_NAMES, say, sayError, WORDS, type Key } from '../../src/i18n';

const TELUGU = /[ఀ-౿]/;
const DEVANAGARI = /[ऀ-ॿ]/;
/** Keys whose words are names or symbols, the same in every language. */
const SAME: readonly Key[] = ['whatsapp', 'sms', 'upi', 'ifsc', 'hoursTimesRate'];

describe('rider app words (P4.1)', () => {
  it('every key in Telugu and Hindi, in their own script, with the same {blanks}', () => {
    const keys = Object.keys(WORDS.en) as Key[];
    const blanks = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      for (const [lang, script] of [
        ['te', TELUGU],
        ['hi', DEVANAGARI],
      ] as const) {
        const t = WORDS[lang][k];
        expect(t, `${lang} ${k}`).toBeTruthy();
        if (!SAME.includes(k)) expect(t, `${lang} ${k}`).toMatch(script);
        expect(blanks(t), `${lang} ${k}`).toEqual(blanks(WORDS.en[k]));
      }
    }
    expect(Object.keys(WORDS.te).sort()).toEqual(keys.sort());
    expect(Object.keys(WORDS.hi).sort()).toEqual(keys.sort());
    expect(LANGUAGE_NAMES.map(([l]) => l)).toEqual(['te', 'hi', 'en']);
  });

  it('blanks filled; errors by reason code, a plain one for the unknown', () => {
    expect(say('en', 'newCodeIn', { s: 12 })).toBe('New code in 12 s');
    expect(sayError('en', 'wrong-code', 3)).toBe('Wrong code. 3 tries left.');
    expect(sayError('en', 'wrong-code', 0)).toBe('Wrong code. Ask for a new one.');
    expect(sayError('te', 'too-many-number', 9)).toContain('9');
    expect(sayError('hi', 'something-new', undefined)).toBe(WORDS.hi['err.other']);
    expect(sayError('en', undefined, undefined)).toBe(WORDS.en['err.other']);
  });
});

describe('API client (P4.1)', () => {
  it('sends the token; an error keeps the reason code; no connection is "offline"', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(
        JSON.stringify({ error: 'Wrong code: 2 tries left', why: 'wrong-code', n: 2 }),
        {
          status: 400,
        },
      );
    });
    const e = await call('/rider/sign-in', {
      body: { code: '1' },
      token: 'abc',
      base: 'http://x',
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, why: 'wrong-code', n: 2 });
    expect(seen[0]?.headers).toMatchObject({ authorization: 'Bearer abc' });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Network request failed');
    });
    await expect(call('/rider/me', { base: 'http://x' })).rejects.toMatchObject({ why: 'offline' });
    vi.unstubAllGlobals();
  });
});
