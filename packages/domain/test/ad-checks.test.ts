// P3.9.1: the automatic ad checks read real files (made with ffmpeg) exactly, and never break on
// anything else a person might upload.
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adFacts,
  adKind,
  checkAd,
  checkAdRules,
  DEFAULT_AD_RULES,
  worst,
} from '../src/ad-checks.js';

const file = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/ads/${name}`, import.meta.url)));

describe('ad checks (P3.9.1)', () => {
  it('reads pictures and videos from their own bytes', () => {
    for (const [name, kind] of [
      ['ad-1280x720.png', 'png'],
      ['ad-1280x720.jpg', 'jpeg'],
      ['ad-1280x720.webp', 'webp'],
    ] as const)
      expect(adFacts(file(name)), name).toMatchObject({
        kind,
        width: 1280,
        height: 720,
        durationMs: null,
      });
    expect(adFacts(file('ad-15s-1280x720.mp4'))).toMatchObject({
      kind: 'mp4',
      width: 1280,
      height: 720,
      durationMs: 15_000,
      codec: 'avc1',
    });
    expect(adFacts(file('ad-3s-1280x640.mp4'))).toMatchObject({
      kind: 'mp4',
      width: 1280,
      height: 640,
      durationMs: 3_000,
    });
  });

  it('a 15-second H.264 video of the screen’s shape passes; a picture too', () => {
    expect(checkAd(adFacts(file('ad-15s-1280x720.mp4')))).toEqual([
      { check: 'kind', outcome: 'pass', detail: 'MP4 video' },
      { check: 'size', outcome: 'pass', detail: '0.0 MB' },
      { check: 'pixels', outcome: 'pass', detail: '1280 × 720' },
      { check: 'shape', outcome: 'pass', detail: 'fits the screen' },
      { check: 'length', outcome: 'pass', detail: '15.0 s' },
      { check: 'codec', outcome: 'pass', detail: 'avc1' },
    ]);
    expect(worst(checkAd(adFacts(file('ad-1280x720.jpg'))))).toBe('pass');
  });

  it('fails what cannot run, warns what a person should look at', () => {
    const short = checkAd(adFacts(file('ad-3s-1280x640.mp4')));
    expect(short.find((c) => c.check === 'length')).toEqual({
      check: 'length',
      outcome: 'fail',
      detail: '3.0 s: a video must last 15 s',
    });
    // 2:1 against a 16:9 screen: framed or cropped, a person decides.
    expect(short.find((c) => c.check === 'shape')?.outcome).toBe('warn');
    expect(checkAd(adFacts(new TextEncoder().encode('%PDF-1.7 not an ad at all')))).toEqual([
      { check: 'kind', outcome: 'fail', detail: 'not a PNG, JPEG or WebP picture or an MP4 video' },
    ]);
    const tiny = {
      kind: 'png' as const,
      bytes: 900,
      width: 320,
      height: 180,
      durationMs: null,
      codec: null,
    };
    expect(checkAd(tiny).find((c) => c.check === 'pixels')).toMatchObject({ outcome: 'fail' });
    const huge = { ...tiny, width: 1920, height: 1080, bytes: 11 * 1024 * 1024 };
    expect(checkAd(huge).find((c) => c.check === 'size')).toEqual({
      check: 'size',
      outcome: 'fail',
      detail: '11.0 MB: at most 10.0 MB',
    });
    const hevc = { ...adFacts(file('ad-15s-1280x720.mp4')), codec: 'hvc1' };
    expect(checkAd(hevc).find((c) => c.check === 'codec')?.outcome).toBe('warn');
    // The rules are settings, checked before they can be saved.
    expect(checkAdRules(DEFAULT_AD_RULES)).toEqual([]);
    expect(checkAdRules({ ...DEFAULT_AD_RULES, maxVideoBytes: 100 * 1024 * 1024 })).not.toEqual([]);
  });

  it('never breaks on any bytes (a damaged or hostile upload)', () => {
    const real = file('ad-15s-1280x720.mp4');
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4096 }),
        fc.integer({ min: 0, max: real.length }),
        (junk, cut) => {
          for (const b of [
            junk,
            real.slice(0, cut),
            Uint8Array.from([...real.slice(0, cut), ...junk]),
          ]) {
            const f = adFacts(b);
            expect(['pass', 'warn', 'fail']).toContain(worst(checkAd(f)));
          }
          expect(adKind(junk.slice(0, 4))).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });
});
