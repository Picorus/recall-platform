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
      ['ad-1280x640.png', 'png'],
      ['ad-1280x640.jpg', 'jpeg'],
      ['ad-1280x640.webp', 'webp'],
    ] as const)
      expect(adFacts(file(name)), name).toMatchObject({
        kind,
        width: 1280,
        height: 640,
        durationMs: null,
      });
    expect(adFacts(file('ad-15s-1280x640.mp4'))).toMatchObject({
      kind: 'mp4',
      width: 1280,
      height: 640,
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
    expect(checkAd(adFacts(file('ad-15s-1280x640.mp4')))).toEqual([
      { check: 'kind', outcome: 'pass', detail: 'MP4 video' },
      { check: 'content', outcome: 'pass', detail: 'has a video track' },
      { check: 'size', outcome: 'pass', detail: '0.0 MB' },
      { check: 'pixels', outcome: 'pass', detail: '1280 × 640' },
      { check: 'shape', outcome: 'pass', detail: 'fits the screen' },
      { check: 'length', outcome: 'pass', detail: '15.0 s' },
      { check: 'codec', outcome: 'pass', detail: 'avc1' },
    ]);
    expect(worst(checkAd(adFacts(file('ad-1280x640.jpg'))))).toBe('pass');
  });

  it('fails what cannot run, warns what a person should look at', () => {
    const short = checkAd(adFacts(file('ad-3s-1280x640.mp4')));
    expect(short.find((c) => c.check === 'length')).toEqual({
      check: 'length',
      outcome: 'fail',
      detail: '3.0 s: a video must last 15 s',
    });
    // The screen is 2:1 (1280 × 640): a 16:9 ad would be framed or cropped, so it fails.
    expect(short.find((c) => c.check === 'shape')?.outcome).toBe('pass');
    expect(checkAd(adFacts(file('ad-15s-1280x720.mp4'))).find((c) => c.check === 'shape')).toEqual({
      check: 'shape',
      outcome: 'fail',
      detail: 'shape 1.78 : 1: the screen is 2.00 : 1 (make it 1280 × 640)',
    });
    expect(worst(checkAd(adFacts(file('ad-1280x720.png'))))).toBe('fail');
    // Sound: the screens play none, a person checks the picture works without it.
    expect(
      checkAd(adFacts(file('ad-15s-with-sound.mp4'))).find((c) => c.check === 'sound'),
    ).toEqual({
      check: 'sound',
      outcome: 'warn',
      detail: 'it has sound: the screens play none (the picture must work without it)',
    });
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
      media: true,
    };
    expect(checkAd(tiny).find((c) => c.check === 'pixels')).toMatchObject({ outcome: 'fail' });
    const huge = { ...tiny, width: 1280, height: 640, bytes: 31 * 1024 * 1024 };
    expect(checkAd(huge).find((c) => c.check === 'size')).toEqual({
      check: 'size',
      outcome: 'fail',
      detail: '31.0 MB: at most 30.0 MB',
    });
    const hevc = { ...adFacts(file('ad-15s-1280x640.mp4')), codec: 'hvc1' };
    expect(checkAd(hevc).find((c) => c.check === 'codec')?.outcome).toBe('warn');
    // The rules are settings, checked before they can be saved.
    expect(checkAdRules(DEFAULT_AD_RULES)).toEqual([]);
    expect(checkAdRules({ ...DEFAULT_AD_RULES, maxVideoBytes: 100 * 1024 * 1024 })).not.toEqual([]);
  });

  it('never breaks on any bytes (a damaged or hostile upload)', () => {
    const real = file('ad-15s-1280x640.mp4');
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
            // Whatever the header says, what is kept fits the database (whole numbers, int4).
            for (const n of [f.width, f.height, f.durationMs])
              if (n !== null) expect(Number.isSafeInteger(n) && n >= 0 && n < 2 ** 31).toBe(true);
          }
          expect(adKind(junk.slice(0, 4))).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not believe a header alone: crafted, empty or mislabelled files fail', () => {
    const png = file('ad-1280x640.png');
    const mp4 = file('ad-15s-1280x640.mp4');
    const outcome = (b: Uint8Array, check: string) =>
      checkAd(adFacts(b)).find((c) => c.check === check)?.outcome;
    const set32 = (b: Uint8Array, at: number, v: number) =>
      new DataView(b.buffer, b.byteOffset).setUint32(at, v);
    const find = (b: Uint8Array, type: string) =>
      Buffer.from(b).indexOf(Buffer.from(type, 'ascii')) - 4;

    // A PNG header with no picture data in it; an absurd size is not believed.
    expect(outcome(png.slice(0, 33), 'content')).toBe('fail');
    const wide = png.slice();
    set32(wide, 16, 0xffffffff);
    set32(wide, 20, 0xffffffff);
    expect(adFacts(wide)).toMatchObject({ width: null, height: null });
    expect(outcome(wide, 'pixels')).toBe('fail');
    // Only the full PNG signature counts.
    const fake = png.slice();
    fake[4] = 0;
    expect(adKind(fake)).toBeNull();

    // A video's header without its frames (no mdat): fails.
    const noData = mp4.slice(0, find(mp4, 'mdat'));
    expect(outcome(noData, 'content')).toBe('fail');
    // A header that claims 15 minutes, or "unknown", over 15 seconds of frames: not believed.
    const mvhd = find(mp4, 'mvhd') + 8;
    for (const dur of [15 * 60 * 1000, 0xffffffff]) {
      const lie = mp4.slice();
      const scale = new DataView(lie.buffer).getUint32(mvhd + 12);
      set32(lie, mvhd + 16, dur === 0xffffffff ? dur : (dur / 1000) * scale);
      expect(adFacts(lie).durationMs).toBeNull();
      expect(outcome(lie, 'length')).toBe('fail');
    }
    // Other ftyp files (an AVIF picture, a QuickTime movie) are not MP4 videos.
    for (const brand of ['avif', 'qt  ']) {
      const other = mp4.slice();
      other.set(new TextEncoder().encode(brand), 8);
      other.set(new TextEncoder().encode(brand.repeat(4)), 16);
      expect(adKind(other)).toBeNull();
    }
  });

  it('names why a real video cannot run; reads a turned video as upright', () => {
    const fail = (name: string, check: string) =>
      checkAd(adFacts(file(name))).find((c) => c.check === check);
    expect(fail('ad-long-sound.mp4', 'length')).toEqual({
      check: 'length',
      outcome: 'fail',
      detail: 'the sound or another track runs 17.0 s, longer than the video (15.0 s)',
    });
    expect(fail('ad-fragmented.mp4', 'content')).toEqual({
      check: 'content',
      outcome: 'fail',
      detail: 'a fragmented (streaming) MP4: export it as a normal MP4',
    });
    // Recorded wide but marked to play turned a quarter: it plays tall.
    expect(adFacts(file('ad-15s-rotated.mp4'))).toMatchObject({ width: 640, height: 1280 });
    expect(fail('ad-15s-rotated.mp4', 'shape')?.outcome).toBe('fail');
  });

  it('reads a large hostile file quickly (a bounded number of boxes)', () => {
    // 16 MB of empty 8-byte boxes after a real header.
    const many = new Uint8Array(16 * 1024 * 1024);
    many.set(file('ad-15s-1280x640.mp4').slice(0, 32));
    for (let at = 32; at + 8 <= many.length; at += 8) {
      many[at + 3] = 8;
      many.set([0x66, 0x72, 0x65, 0x65], at + 4);
    }
    const t = performance.now();
    expect(adFacts(many).media).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
