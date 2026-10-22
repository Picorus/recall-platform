import fc from 'fast-check';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  playBytes,
  PRICE_BOOK_V1,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { addScreenKey, lineTotalsFor, revokeScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Madhapur, Tue 24 Aug 2027, 6–7 pm India time; booked well ahead.
const HOUR = Date.UTC(2027, 7, 24, 12, 30) / 1000;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const LINE = lineIdOf('BK-P1', 'hyd-madhapur', '2027-08-24', 18);

function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  };
}
const keys = new Map<string, ReturnType<typeof newKey>>();

/** A play signed the way the screen signs it. */
function signed(
  screenId: string,
  seq: number,
  over: Partial<Omit<PlayReport, 'sig'>> = {},
  privateKey?: KeyObject,
): Numbered {
  const body: Omit<PlayReport, 'sig'> = {
    kind: 'play',
    keyId: 'k1',
    slot: 'brand',
    ref: LINE,
    adId: 'ad-1',
    startAt: HOUR + seq * 15,
    lengthS: 15,
    latE6: 17_448_000,
    lngE6: 78_395_000,
    accuracyM: 8,
    place: 'inside:hyd-madhapur@1',
    people: 2,
    ...over,
  };
  const k = privateKey ?? keys.get(screenId)?.privateKey;
  if (!k) throw new Error('no key');
  const sig = sign('sha256', Buffer.from(playBytes(screenId, seq, body)), {
    key: k,
    dsaEncoding: 'der',
  }).toString('base64');
  return { seq, at: body.startAt + 15, report: { ...body, sig } };
}
const upload = (screenId: string, batch: Numbered[], now = HOUR + 3700) =>
  storeUpload(pool, screenId, batch, 1, now);
const totals = () => lineTotalsFor(pool, LINE, HOUR + 3700);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createBooking(
    pool,
    {
      bookingId: 'BK-P1',
      brandId: 'brand-1',
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: '2027-08-24', startHour: 18, bikes: 50 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, 'BK-P1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, 'BK-P1', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  for (const s of ['scr-a', 'scr-b', 'scr-c', 'scr-d', 'scr-e']) {
    keys.set(s, newKey());
    await addScreenKey(pool, s, 'k1', keys.get(s)?.publicKey ?? '', 'fitter');
  }
});
afterAll(async () => db.drop());

describe('plays in the database (P1.5)', () => {
  it('signed plays inside the area count; the same upload sent again is not counted twice', async () => {
    const batch = Array.from({ length: 20 }, (_, i) => signed('scr-a', i + 1));
    const first = await upload('scr-a', batch);
    expect(first.rejected).toBe(0);
    await upload('scr-a', batch);
    await upload('scr-a', [...batch].reverse());
    const t = await totals();
    expect([t.plays, t.bikes, t.people]).toEqual([20, 1, 40]);
  });

  it('a forged or altered play is refused and set aside; the rest of the upload still counts', async () => {
    const good = signed('scr-b', 1);
    const altered = signed('scr-b', 2);
    const tampered = { ...altered, report: { ...(altered.report as PlayReport), people: 999 } };
    const otherKey = signed('scr-b', 3, {}, newKey().privateKey);
    const r = await upload('scr-b', [good, tampered, otherKey, signed('scr-b', 4)]);
    expect(r.rejected).toBe(2);
    const reasons = await pool.query<{ seq: string; reject_reason: string }>(
      `SELECT seq, reject_reason FROM screen_reports WHERE screen_id = 'scr-b' AND kind = 'rejected' ORDER BY seq`,
    );
    expect(reasons.rows.map((x) => [Number(x.seq), x.reject_reason])).toEqual([
      [2, 'bad signature'],
      [3, 'bad signature'],
    ]);
    expect((await totals()).bikes).toBe(2);
  });

  it('an unknown or revoked key is refused', async () => {
    const r1 = await upload('scr-c', [signed('scr-c', 1, { keyId: 'k9' })]);
    expect(r1.rejected).toBe(1);
    await revokeScreenKey(pool, 'scr-c', 'k1', 'prateek', 'screen stolen from bike');
    const r2 = await upload('scr-c', [signed('scr-c', 2)]);
    expect(r2.rejected).toBe(1);
  });

  it('a screen cannot play twice within 15 seconds, in one upload or across uploads', async () => {
    const r = await upload('scr-d', [
      signed('scr-d', 1, { startAt: HOUR + 100 }),
      signed('scr-d', 2, { startAt: HOUR + 110 }),
    ]);
    expect(r.rejected).toBe(1);
    const r2 = await upload('scr-d', [signed('scr-d', 3, { startAt: HOUR + 90 })]);
    expect(r2.rejected).toBe(1);
    const r3 = await upload('scr-d', [signed('scr-d', 4, { startAt: HOUR + 115 })]);
    expect(r3.rejected).toBe(0);
  });

  it('plays outside the area are kept but do not count; edge plays count up to 10% of the line', async () => {
    const before = await totals();
    // The line promises 50 × 200 = 10,000 plays: up to 1,000 from the edge zone. 30 here.
    const edge = Array.from({ length: 30 }, (_, i) =>
      signed('scr-e', i + 1, { latE6: 17_458_300 }),
    );
    const outside = Array.from({ length: 5 }, (_, i) =>
      signed('scr-e', i + 31, { latE6: 17_467_000, lngE6: 78_357_000 }),
    );
    await upload('scr-e', [...edge, ...outside]);
    const t = await totals();
    expect(t.plays - before.plays).toBe(30);
    expect(t.edgeCounted).toBe(30);
    const kept = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM plays WHERE screen_id = 'scr-e' AND counts = 'no'`,
    );
    expect(Number(kept.rows[0]?.n)).toBe(5);
  });

  it('property: however uploads are repeated, split and reordered, each play is stored and counted once', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 })), {
          minLength: 1,
          maxLength: 12,
        }),
        async (uploads) => {
          run += 1;
          const screen = `scr-prop-${run}`;
          keys.set(screen, newKey());
          await addScreenKey(pool, screen, 'k1', keys.get(screen)?.publicKey ?? '', 'fitter');
          const all = Array.from({ length: 30 }, (_, i) => signed(screen, i + 1));
          // Each upload sends a slice of the plays, sometimes backwards, sometimes again.
          for (const [a, b] of uploads) {
            const slice = all.slice(Math.min(a, b) - 1, Math.max(a, b));
            await upload(screen, a > b ? [...slice].reverse() : slice);
          }
          const sent = new Set(
            uploads.flatMap(([a, b]) =>
              all.slice(Math.min(a, b) - 1, Math.max(a, b)).map((n) => n.seq),
            ),
          );
          const stored = await pool.query<{ n: string; d: string }>(
            `SELECT count(*) AS n, count(DISTINCT seq) AS d FROM plays WHERE screen_id = $1`,
            [screen],
          );
          expect(Number(stored.rows[0]?.n)).toBe(sent.size);
          expect(Number(stored.rows[0]?.d)).toBe(sent.size);
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);

  it('a play cannot be edited or deleted', async () => {
    await expect(
      pool.query(`UPDATE plays SET people = 0 WHERE screen_id = 'scr-a'`),
    ).rejects.toThrow();
    await expect(pool.query(`DELETE FROM plays WHERE screen_id = 'scr-a'`)).rejects.toThrow();
  });

  it('only ECDSA P-256 keys are accepted for screens', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64');
    await expect(addScreenKey(pool, 'scr-f', 'k1', rsa, 'fitter')).rejects.toThrow(/P-256/);
  });
});
