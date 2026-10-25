import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ackText,
  downTopic,
  helloText,
  MAX_BATCH,
  parseHello,
  parseUpload,
  parseUpTopic,
  timeText,
  topicAllowed,
  uploadText,
  upTopic,
  type DownKind,
  type UpKind,
} from '../src/screen-link.js';
import type { Numbered } from '../src/screen-reports.js';

interface Vectors {
  topics: { screenId: string; kind: UpKind; up: string }[];
  downTopics: { screenId: string; kind: DownKind; down: string }[];
  upload: { oldestHeld: number; batch: Numbered[]; text: string };
  refused: { text: string; problem: string }[];
  hello: { app: string; mono: number; text: string };
  ack: { ack: number; text: string };
  time: { utcMs: number; echo: number; text: string };
}
const V = JSON.parse(
  readFileSync(new URL('../test-vectors/screen-link.json', import.meta.url), 'utf8'),
) as Vectors;
const bytes = (t: string) => new TextEncoder().encode(t);
const ME = 'SCR-0123456Z';

describe('screen line (P2.3): the shared cases the Kotlin player also passes', () => {
  it('topics, upload text, refusals, hello, ack and time', () => {
    for (const t of V.topics) {
      expect(upTopic(t.screenId, t.kind)).toBe(t.up);
      expect(parseUpTopic(t.up)).toEqual({ screenId: t.screenId, kind: t.kind });
    }
    for (const t of V.downTopics) expect(downTopic(t.screenId, t.kind)).toBe(t.down);
    expect(uploadText(V.upload.batch, V.upload.oldestHeld)).toBe(V.upload.text);
    expect(parseUpload(bytes(V.upload.text))).toEqual({
      batch: V.upload.batch,
      oldestHeld: V.upload.oldestHeld,
    });
    for (const r of V.refused)
      expect([r.text, parseUpload(bytes(r.text))]).toEqual([r.text, { problem: r.problem }]);
    expect(helloText(V.hello.app, V.hello.mono)).toBe(V.hello.text);
    expect(parseHello(bytes(V.hello.text))).toEqual({
      app: V.hello.app,
      code: null,
      mono: V.hello.mono,
    });
    const hc = V.helloCode as { app: string; code: number; mono: number; text: string };
    expect(helloText(hc.app, hc.mono, hc.code)).toBe(hc.text);
    expect(parseHello(bytes(hc.text))).toEqual({ app: hc.app, code: hc.code, mono: hc.mono });
    expect(parseHello(bytes('{"v":1,"app":"1.0","code":0,"mono":1}'))).toEqual({
      problem: 'bad app version',
    });
    expect(ackText(V.ack.ack)).toBe(V.ack.text);
    expect(timeText(V.time.utcMs, V.time.echo)).toBe(V.time.text);
  });

  it('a screen may only send on its own up topics and listen on its own down topics', () => {
    expect(topicAllowed(ME, `recall/v1/s/${ME}/up/upload`, 'publish')).toBe(true);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/down/#`, 'subscribe')).toBe(true);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/down/ack`, 'subscribe')).toBe(true);
    // Someone else's topics, wildcards, the wrong direction, unknown kinds, a bad id.
    expect(topicAllowed(ME, 'recall/v1/s/SCR-00000000/up/upload', 'publish')).toBe(false);
    expect(topicAllowed(ME, 'recall/v1/s/+/up/upload', 'subscribe')).toBe(false);
    expect(topicAllowed(ME, 'recall/v1/s/#', 'subscribe')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/#`, 'subscribe')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/down/+`, 'subscribe')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/down/ack`, 'publish')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/up/upload`, 'subscribe')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/up/money`, 'publish')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/up/upload/x`, 'publish')).toBe(false);
    expect(topicAllowed(ME, `recall/v1/s/${ME}/up/+`, 'publish')).toBe(false);
    expect(topicAllowed('SCR-0123456A', 'recall/v1/s/SCR-0123456A/up/upload', 'publish')).toBe(
      false,
    );
    expect(parseUpTopic(`recall/v1/s/${ME}/up/money`)).toBeUndefined();
    expect(parseUpTopic('recall/v1/s/SCR-0123456A/up/upload')).toBeUndefined();
  });

  it('too big, too many, or not UTF-8 is refused whole', () => {
    const one = { seq: 1, at: 1790000000, report: { kind: 'live' } };
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ ...one, seq: i + 1 }));
    expect(parseUpload(bytes(uploadText(many, 1)))).toEqual({ problem: 'bad batch' });
    const huge = uploadText(
      [{ ...one, report: { kind: 'x', pad: 'a'.repeat(300_000) } } as never],
      1,
    );
    expect(parseUpload(bytes(huge))).toEqual({ problem: 'too big' });
    expect(parseUpload(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      problem: 'not a JSON object',
    });
    expect(parseHello(bytes('{"v":1,"app":"x y","mono":1}'))).toEqual({
      problem: 'bad app version',
    });
    expect(parseHello(bytes('{"v":1,"app":"1.0","mono":-1}'))).toEqual({ problem: 'bad counter' });
  });

  it('property: every upload reads back exactly as written', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1e9 }),
        fc.array(
          fc.record({
            at: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
            report: fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
          }),
          { maxLength: 20 },
        ),
        (oldestHeld, items) => {
          const batch = items.map((x, i) => ({
            seq: oldestHeld + i,
            ...x,
          })) as unknown as Numbered[];
          expect(parseUpload(bytes(uploadText(batch, oldestHeld)))).toEqual({ batch, oldestHeld });
        },
      ),
    );
  });
});
