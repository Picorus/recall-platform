// P7.5: the POC readiness check reads the live system and says, item by item, what is ready and
// what to do; it changes nothing.
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { pocReadiness } from '../../src/readiness.js';
import { saveSetting } from '../../src/settings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Tue 24 Aug 2027, noon India time.
const NOW = Date.UTC(2027, 7, 24, 6, 30) / 1000;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
}, 60_000);
afterAll(async () => db.drop());

const ready = async (services = [] as { service: string; state: 'on' | 'stand-in' | 'off' }[]) =>
  Object.fromEntries((await pocReadiness(pool, services, NOW)).map((i) => [i.item, i.ok] as const));

describe('POC readiness (P7.5)', () => {
  it('a new system: nothing ready, each with what to do', async () => {
    const items = await pocReadiness(pool, [{ service: 'Brand payments', state: 'stand-in' }], NOW);
    expect(items.every((i) => !i.ok)).toBe(true);
    expect(items.every((i) => i.todo.length > 10)).toBe(true);
    expect(items.map((i) => i.item)).toEqual([
      "RECALL's company details",
      'Prices in force',
      'Areas on sale',
      'Business mode is POC',
      'Two super admins',
      'An admin for every area',
      'A fitting centre open',
      'Support phone numbers',
      '200 screens ready',
      '200 riders approved',
      'Brand payments',
    ]);
  });

  it('turns ready as each is set', async () => {
    await saveSetting(
      pool,
      'company',
      {
        legalName: 'RECALL Media Pvt Ltd',
        gstin: '36AABCU9603R1ZO',
        address: 'Hitech City, Hyderabad',
      },
      SUPER,
      'registered company',
      0,
    );
    await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
    for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
      await saveAreaVersion(pool, { ...a, draft: false }, 'system');
    await setBusinessMode(pool, 'poc', SUPER, 'POC starts', Date.UTC(2027, 6, 20, 6, 30) / 1000);
    await saveSetting(
      pool,
      'fittingCentres',
      [{ name: 'Madhapur centre', address: 'Road 36, Madhapur', on: true }],
      SUPER,
      'first centre open',
      0,
    );
    await saveSetting(
      pool,
      'support',
      {
        phones: [{ label: 'Riders', phone: '+919000011111', whatsapp: true }],
        days: [1, 2, 3, 4, 5, 6, 7],
        opens: '10:00',
        closes: '19:00',
      },
      SUPER,
      'support line',
      0,
    );
    expect(await ready([{ service: 'Brand payments', state: 'on' }])).toMatchObject({
      "RECALL's company details": true,
      'Prices in force': true,
      'Areas on sale': true,
      'Business mode is POC': true,
      'A fitting centre open': true,
      'Support phone numbers': true,
      'Brand payments': true,
      // No staff, screens or riders in this database.
      'Two super admins': false,
      '200 screens ready': false,
      '200 riders approved': false,
    });
  });
});
