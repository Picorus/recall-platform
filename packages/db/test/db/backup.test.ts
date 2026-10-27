// P7.4: a backup restores to exactly what was backed up (every table's rows, the ledger's totals,
// the migrations), the time-split tables included; a damaged file or an existing database is never
// restored into.
import { generateKeyPairSync, sign } from 'node:crypto';
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  playBytes,
  PRICE_BOOK_V1,
  type PlayReport,
} from '@recall/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { backupDatabase, checkRestore, restoreDatabase } from '../../src/backup.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { addScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { chooseAds, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let url = '';
let dir = '';
const restored: string[] = [];
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const LINE = lineIdOf('BK-B1', 'hyd-madhapur', DATE, 18);
const SIX = lineStartsAt({ date: DATE, startHour: 18 });

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  url = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
  dir = await mkdtemp(join(tmpdir(), 'recall-backup-'));
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  // A paid booking (money in the ledger) and a screen's signed plays and minute summary (the
  // time-split tables).
  await createBooking(
    pool,
    {
      bookingId: 'BK-B1',
      brandId: 'brand-b1',
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour: 18, bikes: 5 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, 'BK-B1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, 'BK-B1', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await chooseAds(pool, 'BK-B1');
  await moveBooking(pool, 'BK-B1', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await addScreenKey(
    pool,
    's1',
    'k1',
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
  const batch = Array.from({ length: 20 }, (_, i) => {
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref: LINE,
      adId: 'ad-1',
      startAt: SIX + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: 'inside:hyd-madhapur@1',
      people: 0,
    };
    const sig = sign('sha256', Buffer.from(playBytes('s1', i + 1, body)), {
      key: privateKey,
      dsaEncoding: 'der',
    }).toString('base64');
    return { seq: i + 1, at: body.startAt + 15, report: { ...body, sig } };
  });
  await storeUpload(pool, 's1', batch, 1, SIX + 3500);
}, 120_000);

afterAll(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const name of restored) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await db.drop();
});

describe('backups (P7.4)', () => {
  it('restore to exactly what was backed up, the money and the plays included', async () => {
    const plays = await pool.query<{ n: string }>('SELECT count(*) AS n FROM plays');
    expect(Number(plays.rows[0]?.n)).toBe(20);
    const file = join(dir, 'recall.dump');
    const hash = await backupDatabase(url, file);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const name = `recall_restore_${Date.now()}`;
    restored.push(name);
    const copy = await restoreDatabase(file, url, name);
    const check = await checkRestore(url, copy);
    expect(check.differences).toEqual([]);
    expect(check.tables).toBeGreaterThan(80);
    // The restored database works as the original: its plays and its money are there.
    const c = new pg.Client({ connectionString: copy });
    await c.connect();
    try {
      const n = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM plays WHERE counts <> 'no'",
      );
      expect(Number(n.rows[0]?.n)).toBe(20);
      const held = await c.query<{ n: string }>(
        "SELECT sum(credit) - sum(debit) AS n FROM ledger_postings WHERE account = 'campaign-held'",
      );
      expect(Number(held.rows[0]?.n)).toBeGreaterThan(0);
      // Still append-only after a restore.
      await expect(c.query('DELETE FROM ledger_postings')).rejects.toThrow();
    } finally {
      await c.end();
    }
  });

  it('a changed backup file, or a database that exists, is never restored into', async () => {
    const file = join(dir, 'again.dump');
    await backupDatabase(url, file);
    await expect(restoreDatabase(file, url, new URL(url).pathname.slice(1))).rejects.toThrow(
      'exists already',
    );
    await appendFile(file, 'x');
    await expect(restoreDatabase(file, url, 'recall_never_made')).rejects.toThrow(
      'does not match its .sha256',
    );
    await expect(restoreDatabase(file, url, 'Robert; DROP')).rejects.toThrow('small letters');
  });

  it('a restore that differs from its source is reported', async () => {
    const file = join(dir, 'before.dump');
    await backupDatabase(url, file);
    const name = `recall_restore_old_${Date.now()}`;
    restored.push(name);
    const copy = await restoreDatabase(file, url, name);
    await pool.query(
      `INSERT INTO booking_notes (booking_id, note, by, at) VALUES ('BK-B1', 'after the backup', 'priya', now())`,
    );
    const check = await checkRestore(url, copy);
    expect(check.differences).toEqual(['rows in booking_notes: 1 in the source, 0 restored']);
  });
});
