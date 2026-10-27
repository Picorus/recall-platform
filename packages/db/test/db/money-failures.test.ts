// P7.3: when something fails in the middle of a money run. One booking line that cannot be closed
// or settled never stops the others and leaves nothing half-posted; the next run finishes it. An
// upload that meets another in the database is tried again and stored once; one that keeps failing
// stores nothing. Failures are made on purpose with a database trigger.
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  playBytes,
  PRICE_BOOK_V1,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { closeEarnings } from '../../src/earnings.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import { settleDue } from '../../src/makeups.js';
import { addScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { chooseAds, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const GOOD = lineIdOf('BK-G1', 'hyd-madhapur', DATE, 18);
const BAD = lineIdOf('BK-G2', 'hyd-madhapur', DATE, 19);
const SIX = lineStartsAt({ date: DATE, startHour: 18 });
const SEVEN = lineStartsAt({ date: DATE, startHour: 19 });

const keys = new Map<string, ReturnType<typeof generateKeyPairSync>['privateKey']>();
const seqs = new Map<string, number>();
async function screen(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  keys.set(id, privateKey);
  await addScreenKey(
    pool,
    id,
    'k1',
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
}
/** `n` signed plays from one screen for `ref`, 15 s apart from `start`, inside Madhapur. */
function plays(id: string, n: number, start: number, ref: string): Numbered[] {
  const k = keys.get(id);
  if (!k) throw new Error('no key');
  return Array.from({ length: n }, (_, i) => {
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref,
      adId: 'ad-1',
      startAt: start + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: 'inside:hyd-madhapur@1',
      people: 0,
    };
    const sig = sign('sha256', Buffer.from(playBytes(id, seq, body)), {
      key: k,
      dsaEncoding: 'der',
    });
    return { seq, at: body.startAt + 15, report: { ...body, sig: sig.toString('base64') } };
  });
}

async function book(id: string, startHour: number) {
  await createBooking(
    pool,
    {
      bookingId: id,
      brandId: `brand-${id}`,
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour, bikes: 5 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, id, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, id, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await chooseAds(pool, id);
  await moveBooking(pool, id, 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
}

const revenueFor = async (ref: string) => {
  const t = await accountTotals(pool, 'revenue', { ref });
  return t.credit - t.debit;
};

/** Makes every insert into `table` whose `column` starts with `prefix` fail, until removed. */
async function failInserts(table: string, column: string, prefix: string) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.${column} LIKE '${prefix}%' THEN RAISE EXCEPTION 'failure made by the test'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_${table} BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION test_fail_${table}();`);
  return () => pool.query(`DROP TRIGGER test_fail_${table} ON ${table}`);
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  await book('BK-G1', 18);
  await book('BK-G2', 19);
  for (const s of ['s1', 's2']) await screen(s);
  // Both lines delivered: 200 plays each from each of two screens (400 of 1,000).
  for (const s of ['s1', 's2']) {
    await storeUpload(pool, s, plays(s, 200, SIX, GOOD), 1, SIX + 3500);
    await storeUpload(pool, s, plays(s, 200, SEVEN, BAD), 1, SEVEN + 3500);
  }
}, 60_000);
afterAll(async () => db.drop());

describe('money runs when something fails (P7.3)', () => {
  it('hour close: a line that fails is rolled back alone; the others are closed; the next run finishes it', async () => {
    const after = SEVEN + 3600 + 600;
    const heal = await failInserts('ledger_entries', 'ref', 'BK-G2/');
    const first = await closeEarnings(pool, after);
    expect(first.failed).toEqual([{ lineId: BAD, error: 'failure made by the test' }]);
    expect(await revenueFor(GOOD)).toBeGreaterThan(0);
    // Nothing of the failed line was posted, and the books still balance.
    expect(await revenueFor(BAD)).toBe(0);
    const tb = await trialBalance(pool);
    expect(tb.debit).toBe(tb.credit);
    await heal();
    const second = await closeEarnings(pool, after);
    expect(second.failed).toEqual([]);
    expect(await revenueFor(BAD)).toBe(await revenueFor(GOOD));
  });

  it("make-ups and refunds: a line that fails is rolled back alone; the others' decisions stand", async () => {
    const at = SEVEN + 3600 + 600;
    const heal = await failInserts('line_settlements', 'line_id', 'BK-G2/');
    const first = await settleDue(pool, at);
    expect(first.failed.map((f) => f.lineId)).toEqual([BAD]);
    const decided = async (lineId: string) =>
      Number(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*) AS n FROM line_settlements WHERE line_id = $1',
            [lineId],
          )
        ).rows[0]?.n,
      );
    expect(await decided(GOOD)).toBeGreaterThan(0);
    expect(await decided(BAD)).toBe(0);
    // No make-up was opened for the failed line either (its decision and its make-up go together).
    const madeUp = await pool.query('SELECT 1 FROM make_ups WHERE line_id = $1', [BAD]);
    expect(madeUp.rowCount).toBe(0);
    await heal();
    expect((await settleDue(pool, at)).failed).toEqual([]);
    expect(await decided(BAD)).toBe(await decided(GOOD));
  });
});

describe('uploads that meet another in the database (P7.3)', () => {
  /** Makes the next `times` inserts of reports fail as a deadlock would. */
  async function deadlock(times: number) {
    await pool.query(`
      DROP SEQUENCE IF EXISTS test_deadlocks;
      CREATE SEQUENCE test_deadlocks;
      GRANT USAGE ON SEQUENCE test_deadlocks TO recall_app;
      CREATE OR REPLACE FUNCTION test_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('test_deadlocks') <= ${times} THEN
          RAISE EXCEPTION 'deadlock made by the test' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_deadlock BEFORE INSERT ON screen_reports
        FOR EACH STATEMENT EXECUTE FUNCTION test_deadlock();`);
    return () => pool.query('DROP TRIGGER test_deadlock ON screen_reports');
  }
  const stored = async (screenId: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM screen_reports WHERE screen_id = $1',
          [screenId],
        )
      ).rows[0]?.n,
    );

  it('tried again, and stored once', async () => {
    await screen('s3');
    const heal = await deadlock(2);
    const r = await storeUpload(pool, 's3', plays('s3', 4, SIX, GOOD), 1, SIX + 3500);
    await heal();
    expect(r.ack).toBe(4);
    expect(await stored('s3')).toBe(4);
  });

  it('still failing after 3 tries: nothing is stored and the box sends it again later', async () => {
    await screen('s4');
    const heal = await deadlock(3);
    await expect(storeUpload(pool, 's4', plays('s4', 4, SIX, GOOD), 1, SIX + 3500)).rejects.toThrow(
      'deadlock made by the test',
    );
    await heal();
    expect(await stored('s4')).toBe(0);
  });
});
