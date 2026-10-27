// P5.2: a business sets itself up on the brand portal: its GST number looked up (the record's
// legal name, state and address, never typed ones), or typed details when the lookup service is
// off or down, or no GST number; a GST number never blocks another account (staff see the clash);
// the person becomes its owner; a few lookups and set-ups a day; the free week while not had.
import { fakeGst, type GstAdapter } from '@recall/adapters';
import { DEFAULT_BRAND_SIGN_IN as R, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  businessPage,
  freeWeekKeys,
  lookUpGst,
  sameGstinAccounts,
  setUpBusiness,
  type NewBusiness,
} from '../../src/brand-business.js';
import { portalAccounts } from '../../src/brand-sign-in.js';
import { savePriceBook } from '../../src/bookings.js';
import { saveSetting } from '../../src/settings.js';
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

/** The free week is off until a super admin turns it on (Prateek, 27 Oct 2026). */
const freeWeek = (on: boolean, version: number) =>
  saveSetting(
    pool,
    'freeWeek',
    { on },
    { id: 'prateek', role: 'super-admin' },
    'offer it now',
    version,
  );
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
    // Off at first: no free week offered.
    expect((await businessPage(pool, 'chai-co', NOW + 60, ASHA))?.freeWeek).toBeNull();
    await freeWeek(true, 0);
    expect(id).toBe('chai-co');
    expect(await portalAccounts(pool, ASHA)).toEqual([
      { brandId: 'chai-co', name: 'Chai Co', kind: 'brand', role: 'owner' },
    ]);
    expect(await businessPage(pool, 'chai-co', NOW + 60, ASHA)).toEqual({
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

  it('someone else with the same GST number: never refused or told, both shown to staff; same name gets the next id', async () => {
    const other = '+919848022222';
    // The lookup says nothing about the number being with RECALL.
    expect(await lookUpGst(pool, fakeGst(), { gstin: CHAI, asker: other }, NOW)).toMatchObject({
      status: 'found',
    });
    const id = await setUpBusiness(pool, { ...base, asker: other }, NOW + 1);
    expect(id).toBe('chai-co-2');
    expect(await sameGstinAccounts(pool, 'chai-co')).toEqual([
      { brandId: 'chai-co-2', name: 'Chai Co' },
    ]);
    expect(await sameGstinAccounts(pool, 'chai-co-2')).toEqual([
      { brandId: 'chai-co', name: 'Chai Co' },
    ]);
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
    expect(await businessPage(pool, id, NOW, ASHA)).toMatchObject({
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
    expect(await businessPage(pool, id, NOW, ASHA)).toMatchObject({
      gstin: null,
      stateName: 'Telangana',
    });
    expect((await businessPage(pool, id, NOW, ASHA))?.freeWeek).not.toBeNull();
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

  it('review: no skipping the lookup; a record beats a later failure; a typed number blocks nobody; same name at once', async () => {
    const asker = '+919848055555';
    const g = gstin('36ABCDF1234E1Z');
    // Saving without looking the number up first.
    await expect(
      setUpBusiness(
        pool,
        { ...base, asker, gstin: g, name: 'Skip Co', legalName: 'Anything' },
        NOW,
      ),
    ).rejects.toThrow('Find your business by its GST number again');
    // Found, then the service fails on a second look: the record's details still go on invoices.
    await lookUpGst(pool, fakeGst(), { gstin: g, asker }, NOW);
    const down: GstAdapter = {
      lookup: () => Promise.resolve({ status: 'unavailable', reason: 'down' }),
    };
    expect(await lookUpGst(pool, down, { gstin: g, asker }, NOW + 1)).toEqual({
      status: 'type-it',
    });
    const id = await setUpBusiness(
      pool,
      { ...base, asker, gstin: g, name: 'Record Co', legalName: 'Typed Over' },
      NOW + 2,
    );
    expect((await businessPage(pool, id, NOW + 2, asker))?.legalName).toBe(
      'Test Business ABCDF1234E Private Limited',
    );
    const src = await pool.query<{ source: string; gst_lookup_id: string | null }>(
      'SELECT source, gst_lookup_id FROM brand_tax_profiles WHERE brand_id = $1',
      [id],
    );
    expect(src.rows[0]?.source).toBe('gst-record');
    expect(src.rows[0]?.gst_lookup_id).not.toBeNull();

    // With no lookup service, a typed GST number is kept as typed and never blocks its real owner.
    const h = gstin('36ABCDG1234E1Z');
    const typer = '+919848066600';
    await lookUpGst(pool, undefined, { gstin: h, asker: typer }, NOW);
    const typed = await setUpBusiness(
      pool,
      { ...base, asker: typer, gstin: h, name: 'Typed Co', legalName: 'Made Up Name' },
      NOW,
    );
    expect(
      (await pool.query('SELECT source FROM brand_tax_profiles WHERE brand_id = $1', [typed]))
        .rows[0],
    ).toEqual({ source: 'typed' });
    const owner = '+919848066601';
    await lookUpGst(pool, fakeGst(), { gstin: h, asker: owner }, NOW);
    await setUpBusiness(pool, { ...base, asker: owner, gstin: h, name: 'Real Owner Co' }, NOW);
    // The real owner was never blocked; staff see both.
    expect((await sameGstinAccounts(pool, typed)).map((x) => x.name)).toEqual(['Real Owner Co']);

    // Two people set up the same name at once: two accounts, no error.
    const ids = await Promise.all(
      ['+919848077701', '+919848077702'].map((a) =>
        setUpBusiness(
          pool,
          {
            ...base,
            asker: a,
            gstin: null,
            name: 'Same Name',
            legalName: 'Owner',
            stateCode: '36',
          },
          NOW,
        ),
      ),
    );
    expect(ids.sort()).toEqual(['same-name', 'same-name-2']);
  });

  it('review: a free week is counted per person as well as per phone and GST number', () => {
    expect(freeWeekKeys({ phone: '+919848011111', gstin: null }, 'media@adwise.in')).toEqual([
      'phone:9848011111',
      'member:media@adwise.in',
    ]);
    expect(freeWeekKeys({ phone: '+919848011111', gstin: CHAI }, ASHA)).toEqual([
      'phone:9848011111',
      `gstin:${CHAI}`,
      `member:${ASHA}`,
    ]);
  });
});
