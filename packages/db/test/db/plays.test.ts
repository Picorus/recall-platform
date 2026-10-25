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
import { addScreenKey, countedPlaysFor, lineTotalsFor, revokeScreenKey } from '../../src/plays.js';
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
const totals = () => lineTotalsFor(pool, LINE);

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
  await moveBooking(pool, 'BK-P1', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
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
    expect([t.plays, t.bikes]).toEqual([20, 1]);
    expect((await countedPlaysFor(pool, LINE)).reduce((n, p) => n + p.people, 0)).toBe(40);
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

  it('an unknown key is refused; a revoked key still covers plays from before it was given up', async () => {
    const r1 = await upload('scr-c', [signed('scr-c', 1, { keyId: 'k9' })]);
    expect(r1.rejected).toBe(1);
    // The screen was lost at HOUR + 40: its play at HOUR + 30 still counts, the one at HOUR + 45 not.
    await revokeScreenKey(pool, 'scr-c', 'k1', 'prateek', 'screen stolen from bike', HOUR + 40);
    const r2 = await upload('scr-c', [signed('scr-c', 2), signed('scr-c', 3)]);
    expect(r2.rejected).toBe(1);
    const stored = await pool.query<{ seq: string }>(
      `SELECT seq FROM plays WHERE screen_id = 'scr-c'`,
    );
    expect(stored.rows.map((x) => Number(x.seq))).toEqual([2]);
  });

  it('plays already stored from a key later given up stop counting from that moment', async () => {
    keys.set('scr-g', newKey());
    await addScreenKey(pool, 'scr-g', 'k1', keys.get('scr-g')?.publicKey ?? '', 'fitter');
    const before = (await totals()).plays;
    await upload(
      'scr-g',
      Array.from({ length: 10 }, (_, i) => signed('scr-g', i + 1)),
    );
    expect((await totals()).plays).toBe(before + 10);
    // Stolen at HOUR + 76: plays from seq 5 (HOUR + 75) count, seq 6 on do not.
    await revokeScreenKey(pool, 'scr-g', 'k1', 'prateek', 'screen stolen from bike', HOUR + 76);
    expect((await totals()).plays).toBe(before + 5);
  });

  it('a line is named one way only: "…/08" for the 8 am line is not counted', async () => {
    keys.set('scr-h', newKey());
    await addScreenKey(pool, 'scr-h', 'k1', keys.get('scr-h')?.publicKey ?? '', 'fitter');
    const before = (await totals()).plays;
    await upload('scr-h', [signed('scr-h', 1, { ref: LINE.replace(/\/18$/, '/018') })]);
    expect((await totals()).plays).toBe(before);
    const kept = await pool.query<{ reason: string }>(
      `SELECT reason FROM plays WHERE screen_id = 'scr-h'`,
    );
    expect(kept.rows[0]?.reason).toBe('not a sold booking line');
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

  it('plays for a booking whose ads are not approved yet do not count', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-P2',
        brandId: 'brand-2',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: '2027-08-24', startHour: 18, bikes: 50 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-P2', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-P2', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    keys.set('scr-i', newKey());
    await addScreenKey(pool, 'scr-i', 'k1', keys.get('scr-i')?.publicKey ?? '', 'fitter');
    const line2 = lineIdOf('BK-P2', 'hyd-madhapur', '2027-08-24', 18);
    await upload('scr-i', [signed('scr-i', 1, { ref: line2 })]);
    expect((await lineTotalsFor(pool, line2)).plays).toBe(0);
  });

  it("a line's totals never change when a later price book changes the rules", async () => {
    const before = await totals();
    expect(before.edgeCounted).toBeGreaterThan(0);
    await savePriceBook(
      pool,
      {
        ...PRICE_BOOK_V1,
        version: 2,
        validFrom: '2027-09-01T00:00:00.000Z',
        plays: { ...PRICE_BOOK_V1.plays, edgeShareBp: 0 },
      },
      'prateek',
    );
    expect(await totals()).toEqual(before);
  });

  it('the database itself refuses a second play at the same time or under the same number', async () => {
    const dup = (seq: number, at: number) =>
      pool.query(
        `INSERT INTO plays (screen_id, seq, start_at, key_id, slot, ref, ad_id, length_s, lat_e6,
           lng_e6, accuracy_m, screen_place, cloud_place, counts, line_id, reason, people)
         VALUES ('scr-a', $1, to_timestamp($2), 'k1', 'brand', $3, 'ad-1', 15, 17448000, 78395000,
           8, 'x', 'x', 'inside', $3, NULL, 0)`,
        [seq, at, LINE],
      );
    // Same start time as seq 1, under another number; and seq 1 again at another time.
    await expect(dup(2, HOUR + 15)).rejects.toThrow();
    await expect(dup(1, HOUR + 2000)).rejects.toThrow(/already stored/);
  });

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
