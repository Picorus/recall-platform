// P3.8.1: brand and agency accounts: opened, changed as versions, agencies and their brands,
// notes, one account's page; nothing edited or deleted.
import { PRICE_BOOK_V1, launchAreas, type AccountDetails } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import {
  accountList,
  accountPage,
  addAccountNote,
  createAccount,
  findAccount,
  reviseAccount,
} from '../../src/brands.js';
import { setBrandTaxProfile } from '../../src/gst.js';
import { setBrandContact } from '../../src/report-sends.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const plain = (name: string): AccountDetails => ({
  name,
  agencyId: null,
  referredBy: null,
  active: true,
});

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
});
afterAll(async () => db.drop());

describe('brand and agency accounts (P3.8.1)', () => {
  it('opened with why; an agency handles brands; a taken id or a wrong agency is refused', async () => {
    await createAccount(
      pool,
      {
        brandId: 'adwise',
        kind: 'agency',
        details: plain('Adwise Media'),
        by: 'Sana',
        reason: 'signed',
      },
      NOW,
    );
    await createAccount(
      pool,
      {
        brandId: 'chai-co',
        kind: 'brand',
        details: { ...plain('Chai Co'), agencyId: 'adwise', referredBy: 'rapido' },
        by: 'Sana',
        reason: 'first call',
      },
      NOW,
    );
    expect(await findAccount(pool, 'chai-co')).toMatchObject({
      kind: 'brand',
      version: 1,
      name: 'Chai Co',
      agencyId: 'adwise',
      referredBy: 'rapido',
      active: true,
    });
    const again = {
      brandId: 'chai-co',
      kind: 'brand' as const,
      details: plain('Chai 2'),
      by: 'S',
      reason: 'dup',
    };
    await expect(createAccount(pool, again, NOW)).rejects.toThrow('The id chai-co is taken');
    await expect(
      createAccount(
        pool,
        { ...again, brandId: 'dosa-co', details: { ...plain('Dosa Co'), agencyId: 'chai-co' } },
        NOW,
      ),
    ).rejects.toThrow('chai-co is a brand, not an agency');
    await expect(
      createAccount(
        pool,
        { ...again, brandId: 'dosa-co', details: { ...plain('Dosa Co'), agencyId: 'nobody' } },
        NOW,
      ),
    ).rejects.toThrow('no account nobody');
    await expect(
      createAccount(pool, { ...again, brandId: 'Dosa Co', details: plain('Dosa Co') }, NOW),
    ).rejects.toThrow('id: lower case');
  });

  it('a change is the next version, never over someone else’s; an agency with brands cannot close', async () => {
    const v = await reviseAccount(
      pool,
      {
        brandId: 'chai-co',
        baseVersion: 1,
        details: { ...plain('Chai Company'), agencyId: 'adwise', referredBy: 'rapido' },
        by: 'Sana',
        reason: 'legal name',
      },
      NOW + 60,
    );
    expect(v).toBe(2);
    await expect(
      reviseAccount(
        pool,
        {
          brandId: 'chai-co',
          baseVersion: 1,
          details: plain('Old'),
          by: 'Ravi',
          reason: 'stale page',
        },
        NOW + 120,
      ),
    ).rejects.toThrow('reload');
    await expect(
      reviseAccount(
        pool,
        {
          brandId: 'adwise',
          baseVersion: 1,
          details: { ...plain('Adwise Media'), active: false },
          by: 'S',
          reason: 'closing',
        },
        NOW + 120,
      ),
    ).rejects.toThrow('Move these brands to another agency first: Chai Company');
    await expect(pool.query("UPDATE brand_versions SET name = 'x'")).rejects.toThrow();
    await expect(pool.query('DELETE FROM brands')).rejects.toThrow();
  });

  it('the list and one account’s page: contact, tax details, notes, bookings, an agency’s brands', async () => {
    await setBrandContact(pool, 'chai-co', { phone: '+919876543210' }, 'Sana');
    await setBrandTaxProfile(
      pool,
      'chai-co',
      { legalName: 'Chai Co Pvt Ltd', gstin: '36AAPFU0939F1ZW', stateCode: '36' },
      'Farah',
    );
    await addAccountNote(pool, 'chai-co', 'Wants evenings in Madhapur', 'Sana', NOW + 200);
    await expect(addAccountNote(pool, 'chai-co', '   ', 'Sana', NOW)).rejects.toThrow('1 to 2,000');
    await createBooking(
      pool,
      {
        bookingId: 'BK-BR-1',
        brandId: 'chai-co',
        request: {
          lines: [
            { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 19, bikes: 30 },
            { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 20, bikes: 30 },
          ],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'Sana',
      },
      NOW,
    );
    const list = await accountList(pool);
    expect(list.map((a) => a.brandId)).toEqual(['adwise', 'chai-co']);
    expect(list[1]).toMatchObject({
      name: 'Chai Company',
      agencyName: 'Adwise Media',
      phone: '+919876543210',
      gstin: '36AAPFU0939F1ZW',
      bookings: 1,
    });
    const page = await accountPage(pool, 'chai-co');
    expect(page?.history.map((h) => [h.version, h.reason])).toEqual([
      [2, 'legal name'],
      [1, 'first call'],
    ]);
    expect(page?.tax).toMatchObject({ legalName: 'Chai Co Pvt Ltd', stateCode: '36', by: 'Farah' });
    expect(page?.notes).toEqual([
      { note: 'Wants evenings in Madhapur', by: 'Sana', at: NOW + 200 },
    ]);
    expect(page?.bookings).toEqual([
      expect.objectContaining({ bookingId: 'BK-BR-1', state: 'draft', totalPaise: 2_124_000 }),
    ]);
    expect((await accountPage(pool, 'adwise'))?.brands).toEqual([
      { brandId: 'chai-co', name: 'Chai Company', active: true },
    ]);
    expect(await accountPage(pool, 'nobody')).toBeUndefined();
  });
});
