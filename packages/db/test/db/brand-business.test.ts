// P5.2: a business sets itself up on the brand portal: its GST number looked up (the record's
// legal name, state and address, never typed ones), or typed details when the lookup service is
// off or down, or no GST number; one account per GST number; the person becomes its owner; a few
// lookups and set-ups a day; the free week while the business has not had it.
import { fakeGst } from '@recall/adapters';
import { DEFAULT_BRAND_SIGN_IN as R, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessPage,
  lookUpGst,
  setUpBusiness,
  type NewBusiness,
} from '../../src/brand-business.js';
import { portalAccounts } from '../../src/brand-sign-in.js';
import { savePriceBook } from '../../src/bookings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const ASHA = '+919848011111';

/** A GSTIN with its right check character, from its first 14. */
export function gstin(first14: string): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = chars.indexOf(first14[i] ?? '') * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return `${first14}${chars[(36 - (sum % 36)) % 36]}`;
}

const CHAI = gstin('36AAPFU0939F1Z');
const base: NewBusiness = {
  asker: ASHA,
  gstin: CHAI,
  name: 'Chai Co',
  kind: 'brand',
  businessType: 'food',
  invoiceEmail: 'accounts@chaico.in',
  phone: ASHA,
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
}, 60_000);
afterAll(async () => db.drop());

describe('your business (P5.2)', () => {
  it('a GST number is looked up; the record fills the invoice details, the person owns it, the free week is open', async () => {
    const gst = fakeGst();
    const found = await lookUpGst(pool, gst, { gstin: CHAI, asker: ASHA }, NOW);
    expect(found).toMatchObject({
      status: 'found',
      legalName: 'Test Business AAPFU0939F Private Limited',
      stateCode: '36',
      stateName: 'Telangana',
    });
    // Typed details are ignored when the record was read.
    const id = await setUpBusiness(pool, { ...base, legalName: 'Something Else' }, NOW + 60);
    expect(id).toBe('chai-co');
    expect(await portalAccounts(pool, ASHA)).toEqual([
      { brandId: 'chai-co', name: 'Chai Co', kind: 'brand', role: 'owner' },
    ]);
    expect(await businessPage(pool, 'chai-co', NOW + 60)).toEqual({
      brandId: 'chai-co',
      name: 'Chai Co',
      kind: 'brand',
      businessType: 'food',
      legalName: 'Test Business AAPFU0939F Private Limited',
      gstin: CHAI,
      stateCode: '36',
      stateName: 'Telangana',
      address: 'Plot 1, Hitech City Road, Madhapur, Hyderabad, Telangana 500081',
      invoiceEmail: 'accounts@chaico.in',
      phone: ASHA,
      freeWeek: { days: PRICE_BOOK_V1.trialDays, bikeHours: PRICE_BOOK_V1.trialBikeHours },
    });
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE ref LIKE 'chai-co%' OR detail LIKE '%chai-co%' ORDER BY action`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'brand added',
        'brand details set',
        'business type set',
        'portal access set',
      ]),
    );
  });

  it('one account per GST number; a name already used gets the next free id', async () => {
    const other = '+919848022222';
    await expect(lookUpGst(pool, fakeGst(), { gstin: CHAI, asker: other }, NOW)).rejects.toThrow(
      'already has a RECALL account',
    );
    await expect(setUpBusiness(pool, { ...base, asker: other }, NOW)).rejects.toThrow(
      'already has a RECALL account',
    );
    const g = gstin('36AABCD1234E1Z');
    await lookUpGst(pool, fakeGst(), { gstin: g, asker: other }, NOW);
    expect(await setUpBusiness(pool, { ...base, asker: other, gstin: g }, NOW + 1)).toBe(
      'chai-co-2',
    );
  });

  it('not in the records or cancelled: refused; the service down or off: the typed details', async () => {
    const asker = 'media@adwise.in';
    const gone = gstin('36ZZZZZ1234E1Z');
    await expect(lookUpGst(pool, fakeGst(), { gstin: gone, asker }, NOW)).rejects.toThrow(
      'not in the GST records',
    );
    await expect(setUpBusiness(pool, { ...base, asker, gstin: gone }, NOW)).rejects.toThrow(
      'not in the GST records',
    );
    const cancelled = gstin('36YYYYY1234E1Z');
    await expect(lookUpGst(pool, fakeGst(), { gstin: cancelled, asker }, NOW)).rejects.toThrow(
      'cancelled or suspended',
    );
    await expect(setUpBusiness(pool, { ...base, asker, gstin: cancelled }, NOW)).rejects.toThrow(
      'cancelled or suspended',
    );
    await expect(
      lookUpGst(pool, fakeGst(), { gstin: '36AAPFU0939F1ZX', asker }, NOW),
    ).rejects.toThrow('This is not a GST number');
    // The service down: the business types its details (its state is the GSTIN's).
    const down = gstin('29XXXXX1234E1Z');
    expect(await lookUpGst(pool, fakeGst(), { gstin: down, asker }, NOW)).toEqual({
      status: 'type-it',
    });
    await expect(
      setUpBusiness(
        pool,
        { ...base, asker, gstin: down, name: 'Adwise Media', kind: 'agency' },
        NOW,
      ),
    ).rejects.toThrow('Legal name');
    const id = await setUpBusiness(
      pool,
      {
        ...base,
        asker,
        gstin: down,
        name: 'Adwise Media',
        kind: 'agency',
        businessType: 'other',
        legalName: 'Adwise Media LLP',
        address: 'Koramangala, Bengaluru',
        stateCode: '36',
      },
      NOW,
    );
    expect(await businessPage(pool, id, NOW)).toMatchObject({
      kind: 'agency',
      legalName: 'Adwise Media LLP',
      stateCode: '29',
      stateName: 'Karnataka',
      // An agency books for brands: no free week of its own.
      freeWeek: null,
    });
    // No lookup service at all (production until P6): typed.
    expect(
      await lookUpGst(pool, undefined, { gstin: gstin('36AABCE1234E1Z'), asker }, NOW),
    ).toEqual({
      status: 'type-it',
    });
  });

  it('no GST number: legal name and state typed; the free week offered', async () => {
    const asker = '+919848033333';
    await expect(
      setUpBusiness(pool, { ...base, asker, gstin: null, name: 'Dosa Cart' }, NOW),
    ).rejects.toThrow('Legal name');
    await expect(
      setUpBusiness(
        pool,
        { ...base, asker, gstin: null, name: 'Dosa Cart', legalName: 'Ravi Dosa', stateCode: '99' },
        NOW,
      ),
    ).rejects.toThrow('Which state');
    const id = await setUpBusiness(
      pool,
      {
        ...base,
        asker,
        gstin: null,
        name: 'Dosa Cart',
        legalName: 'Ravi Dosa',
        stateCode: '36',
        phone: asker,
      },
      NOW,
    );
    expect(await businessPage(pool, id, NOW)).toMatchObject({
      gstin: null,
      stateName: 'Telangana',
    });
    expect((await businessPage(pool, id, NOW))?.freeWeek).not.toBeNull();
    const id2 = await setUpBusiness(
      pool,
      {
        ...base,
        asker,
        gstin: null,
        name: 'Dosa Cart Two',
        legalName: 'Ravi Dosa',
        stateCode: '36',
        phone: asker,
      },
      NOW,
    );
    expect(id2).toBe('dosa-cart-two');
  });

  it('a few lookups and set-ups a day per person', async () => {
    const asker = '+919848044444';
    const gst = fakeGst();
    for (let i = 0; i < R.gstLookupsPerDay; i++)
      await lookUpGst(pool, gst, { gstin: gstin(`36ABCDE${String(1000 + i)}F1Z`), asker }, NOW);
    await expect(
      lookUpGst(pool, gst, { gstin: gstin('36ABCDE9999F1Z'), asker }, NOW),
    ).rejects.toThrow('Too many GST lookups today');
    for (let i = 0; i < R.businessesPerDay; i++)
      await setUpBusiness(
        pool,
        {
          ...base,
          asker,
          gstin: null,
          name: `Cart ${i}`,
          legalName: 'Cart Owner',
          stateCode: '36',
        },
        NOW,
      );
    await expect(
      setUpBusiness(
        pool,
        { ...base, asker, gstin: null, name: 'One More', legalName: 'Cart Owner', stateCode: '36' },
        NOW,
      ),
    ).rejects.toThrow('Too many businesses');
  });
});
