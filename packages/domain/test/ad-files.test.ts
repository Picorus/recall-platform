import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adFilesText,
  MAX_AD_FILES,
  MAX_AD_LIST_BYTES,
  MAX_KEEP_SECONDS,
  parseAdFiles,
  type AdFile,
} from '../src/ad-files.js';
import { downTopic, topicAllowed } from '../src/screen-link.js';

interface Vectors {
  maxFiles: number;
  maxListBytes: number;
  list: { made: number; files: AdFile[]; text: string };
  refused: { text: string; problem: string }[];
}
const V = JSON.parse(
  readFileSync(new URL('../test-vectors/ad-files.json', import.meta.url), 'utf8'),
) as Vectors;
const ME = 'SCR-0123456Z';
const MADE = 1789990000000;
const file = (o: Partial<AdFile> = {}): AdFile => ({
  ad: 'AD-1',
  sha256: 'a'.repeat(64),
  bytes: 1000,
  url: 'https://files.recall.example/a',
  keepUntil: 1790000000,
  ...o,
});

describe('ad file lists (P2.4): the shared cases the Kotlin player also passes', () => {
  it('the list text, and every refusal with its reason', () => {
    expect(adFilesText(V.list.files, V.list.made)).toBe(V.list.text);
    expect(parseAdFiles(V.list.text)).toEqual({ made: V.list.made, files: V.list.files });
    for (const r of V.refused) expect(parseAdFiles(r.text), r.text).toEqual({ problem: r.problem });
  });

  it('travels on the screen own down/files topic, which only that screen may hear', () => {
    expect(downTopic(ME, 'files')).toBe('recall/v1/s/SCR-0123456Z/down/files');
    expect(topicAllowed(ME, downTopic(ME, 'files'), 'subscribe')).toBe(true);
    expect(topicAllowed(ME, downTopic(ME, 'files'), 'publish')).toBe(false);
    expect(topicAllowed(ME, downTopic('SCR-00000000', 'files'), 'subscribe')).toBe(false);
  });

  it('the cloud can never send a list the box would refuse', () => {
    const text = (files: AdFile[]) => () => adFilesText(files, MADE);
    expect(text([file({ url: 'http://files.recall.example/a' })])).toThrow(/HTTPS/);
    expect(text([file({ url: 'https://files.recall.example/café' })])).toThrow(/HTTPS/);
    expect(text([file(), file()])).toThrow(/twice/);
    expect(text([file(), file({ ad: 'AD-2', bytes: 999 })])).toThrow(/two sizes/);
    expect(text([file({ sha256: 'xyz' })])).toThrow(/fingerprint/);
    // A wrong date can never lock a box's storage: at most 400 days past the list's time.
    expect(text([file({ keepUntil: MADE / 1000 + MAX_KEEP_SECONDS + 1 })])).toThrow(/keep-until/);
    expect(() => adFilesText([file()], 1.5)).toThrow(/list time/);
    const many = Array.from({ length: MAX_AD_FILES + 1 }, (_, i) => file({ ad: `A${i}` }));
    expect(text(many)).toThrow(/at most/);
    // Review S2: 600 files fit (a full POC is 200 alone), as the box reads them; 1 MB at most.
    expect(V.maxFiles).toBe(MAX_AD_FILES);
    expect(V.maxListBytes).toBe(MAX_AD_LIST_BYTES);
    expect(MAX_AD_FILES).toBe(600);
    const full = adFilesText(many.slice(0, MAX_AD_FILES), MADE);
    expect('files' in parseAdFiles(full) && parseAdFiles(full)).toMatchObject({ made: MADE });
    const long = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        file({ ad: `A${i}`, url: `https://files.recall.example/${'x'.repeat(2000)}` }),
      );
    expect(text(long(MAX_AD_FILES))).toThrow(/too big/);
    expect(parseAdFiles(' '.repeat(MAX_AD_LIST_BYTES + 1))).toEqual({ problem: 'too big' });
  });

  it('property: every list reads back exactly as written', () => {
    const entry = fc.record({
      ad: fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
      sha256: fc.stringMatching(/^[0-9a-f]{64}$/),
      bytes: fc.integer({ min: 1, max: 64 * 1024 * 1024 }),
      url: fc
        .webUrl({ validSchemes: ['https'] })
        .filter((u) => /^[\x21-\x7E]+$/.test(u) && u.length <= 2048),
      keepUntil: fc.integer({ min: 1, max: MADE / 1000 + MAX_KEEP_SECONDS }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(entry, { selector: (f) => f.ad, maxLength: 20 }),
        fc.integer({ min: 1, max: 2 ** 45 }),
        (files, made) => {
          // One file, one size (as the cloud's own records guarantee).
          const sizes = new Map(files.map((f) => [f.sha256, f.bytes]));
          const fixed = files.map((f) => ({
            ...f,
            bytes: sizes.get(f.sha256) ?? f.bytes,
            keepUntil: Math.min(f.keepUntil, Math.floor(made / 1000) + MAX_KEEP_SECONDS),
          }));
          expect(parseAdFiles(adFilesText(fixed, made))).toEqual({ made, files: fixed });
        },
      ),
    );
  });
});
