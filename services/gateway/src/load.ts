// P7.2: the load test. 15,500 screens each sending what a screen sends every 30 seconds (its
// position, the 2 plays it made, signed, and every other time its minute summary) through the
// gateway's own handling (handleUp), as many at once as one gateway takes (16), on a fresh
// database. Says how many messages a second were handled against how many arrive, and how long
// each took. Signing is done before the clock starts: screens sign their own plays.
//   DATABASE_URL=… pnpm --filter @recall/gateway load -- --screens 15500 --rounds 4
import {
  createBooking,
  moveBooking,
  addScreenKey,
  saveAreaVersion,
  savePriceBook,
} from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import {
  launchAreas,
  newScreenId,
  lineIdOf,
  playBytes,
  PRICE_BOOK_V1,
  uploadText,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { handleUp, LineMemory } from './line.js';

export interface LoadResult {
  readonly screens: number;
  readonly messages: number;
  readonly seconds: number;
  /** Handled per second, and what 15,500 screens every 30 s need. */
  readonly perSecond: number;
  readonly needed: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** Messages answered with something other than an ack (refused): must be 0. */
  readonly refused: number;
  readonly plays: number;
}

const pct = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** Runs the load test on a fresh database (dropped afterwards). */
export async function runLoad(o: {
  readonly screens: number;
  readonly rounds: number;
  readonly atOnce?: number;
  readonly log?: (line: string) => void;
}): Promise<LoadResult> {
  const log = o.log ?? (() => {});
  const atOnce = o.atOnce ?? 16;
  const db = await freshDatabase();
  const pool = db.pool;
  try {
    // Madhapur and the other launch areas, 6–7 pm India time on a Tuesday; one line per area.
    const date = '2027-08-24';
    const hour = Date.UTC(2027, 7, 24, 12, 30) / 1000;
    const areas = launchAreas('2026-11-01T00:00:00.000Z');
    for (const a of areas) await saveAreaVersion(pool, { ...a, draft: false }, 'system');
    await savePriceBook(pool, PRICE_BOOK_V1, 'load');
    const booked = Date.UTC(2027, 6, 1, 4, 30) / 1000;
    await createBooking(
      pool,
      {
        bookingId: 'BK-LOAD',
        brandId: 'load-brand',
        request: {
          lines: areas.map((a) => ({ areaId: a.areaId, date, startHour: 18, bikes: 100 })),
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'load',
      },
      booked,
    );
    const steps = [
      ['awaiting-payment', booked + 60],
      ['paid', booked + 120],
      ['ads-approved', booked + 180],
      ['running', hour],
    ] as const;
    for (const [s, at] of steps)
      await moveBooking(pool, 'BK-LOAD', s, { by: 'load', actor: 'system' }, at);
    // Each screen its own play key, as in real life.
    // Real screen ids (with their check character), numbered.
    const ids = Array.from({ length: o.screens }, (_, i) =>
      newScreenId(Array.from({ length: 7 }, (_, d) => Math.floor(i / 32 ** (6 - d)) % 32)),
    );
    log(`setting up ${o.screens} screens…`);
    const keys = ids.map(() => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
    const spki = (i: number) =>
      keys[i]?.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') ?? '';
    for (let i = 0; i < ids.length; i += 200)
      await Promise.all(
        ids.slice(i, i + 200).map((id, j) => addScreenKey(pool, id, 'k1', spki(i + j), 'load')),
      );

    // Every message, made (and signed) before the clock starts.
    log('making the messages…');
    const msgs: { topic: string; payload: Uint8Array; at: number }[] = [];
    const enc = new TextEncoder();
    for (let r = 0; r < o.rounds; r += 1) {
      const t = hour + r * 30;
      ids.forEach((id, i) => {
        const area = areas[i % areas.length];
        if (!area) return;
        const place = `inside:${area.areaId}@1`;
        const seq0 = r * 4;
        const batch: Numbered[] = [
          {
            seq: seq0 + 1,
            at: t,
            report: { kind: 'live', t, lat: 17.4485, lng: 78.3908, place, moving: true },
          },
        ];
        for (let k = 0; k < 2; k += 1) {
          const body: Omit<PlayReport, 'sig'> = {
            kind: 'play',
            keyId: 'k1',
            slot: 'brand',
            ref: lineIdOf('BK-LOAD', area.areaId, date, 18),
            adId: 'ad-load',
            startAt: t + k * 15,
            lengthS: 15,
            latE6: 17_448_500,
            lngE6: 78_390_800,
            accuracyM: 8,
            place,
            people: 3,
          };
          const seq = seq0 + 2 + k;
          const key = keys[i]?.privateKey;
          if (!key) throw new Error('no key');
          const sig = sign('sha256', Buffer.from(playBytes(id, seq, body)), {
            key,
            dsaEncoding: 'der',
          }).toString('base64');
          batch.push({ seq, at: t + k * 15 + 15, report: { ...body, sig } });
        }
        // Every other message carries the minute just ended (filler seq otherwise: a live report).
        batch.push(
          r % 2 === 1
            ? {
                seq: seq0 + 4,
                at: t,
                report: {
                  kind: 'minute',
                  minute: t - 30 - ((t - 30) % 60),
                  secondsAt: { [place]: 60 },
                  clockSeconds: 60,
                  clockAt: { [place]: 60 },
                  payClockSeconds: 60,
                  movingSeconds: 60,
                  distanceM: 300,
                  plays: 4,
                  people: 6,
                },
              }
            : {
                seq: seq0 + 4,
                at: t + 29,
                report: { kind: 'live', t: t + 29, lat: 17.4486, lng: 78.391, place, moving: true },
              },
        );
        msgs.push({
          topic: `recall/v1/s/${id}/up/upload`,
          payload: enc.encode(uploadText(batch, seq0 + 1)),
          at: (t + 30) * 1000,
        });
      });
    }

    log(`sending ${msgs.length} messages, ${atOnce} at once…`);
    // As the gateway runs: a connection for each message handled at once.
    const line = new pg.Pool({
      connectionString: (pool as unknown as { options: { connectionString: string } }).options
        .connectionString,
      max: atOnce,
    });
    const memory = new LineMemory();
    const took: number[] = [];
    let refused = 0;
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: atOnce }, async () => {
        for (;;) {
          const m = msgs[next];
          next += 1;
          if (!m) return;
          const t0 = performance.now();
          const replies = await handleUp(line, m.topic, m.payload, m.at, memory);
          took.push(performance.now() - t0);
          if (!replies.some((x) => x.topic.endsWith('/down/ack'))) refused += 1;
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    await line.end();
    const sorted = [...took].sort((a, b) => a - b);
    const plays = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM screen_reports WHERE kind = 'play'",
    );
    return {
      screens: o.screens,
      messages: msgs.length,
      seconds: Math.round(seconds * 10) / 10,
      perSecond: Math.round(msgs.length / seconds),
      needed: Math.ceil(15_500 / 30),
      p50Ms: Math.round(pct(sorted, 50)),
      p95Ms: Math.round(pct(sorted, 95)),
      p99Ms: Math.round(pct(sorted, 99)),
      maxMs: Math.round(sorted.at(-1) ?? 0),
      refused,
      plays: Number(plays.rows[0]?.n ?? 0),
    };
  } finally {
    // LOAD_KEEP=1 keeps the database to look into afterwards.
    if (!process.env.LOAD_KEEP) await db.drop();
  }
}

if (process.argv[1]?.endsWith('load.ts')) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      screens: { type: 'string', default: '15500' },
      rounds: { type: 'string', default: '4' },
      'at-once': { type: 'string', default: '16' },
    },
  });
  runLoad({
    screens: Number(values.screens),
    rounds: Number(values.rounds),
    atOnce: Number(values['at-once']),
    log: (l) => console.log(l),
  })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      console.log(
        r.perSecond >= r.needed && r.refused === 0
          ? `OK: ${r.perSecond} messages a second handled; ${r.needed} a second arrive from 15,500 screens.`
          : `NOT ENOUGH: ${r.perSecond} a second handled, ${r.needed} needed; ${r.refused} refused.`,
      );
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
