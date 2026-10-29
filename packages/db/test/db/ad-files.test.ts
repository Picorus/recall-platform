// P2.4.2: the ad files each screen must keep (sent on down/files): which bookings' ads, from when,
// until when, RECALL's own and the POC's, with HTTPS links signed by the file store.
import { fakeFileStore, fakePayments } from '@recall/adapters';
import {
  adFilesText,
  launchAreas,
  lineStartsAt,
  parseAdFiles,
  pocMonthWindow,
  PRICE_BOOK_V1,
} from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAKE_UP_KEEP_SECONDS,
  neededAdFiles,
  screenAdFiles,
  signAdFiles,
} from '../../src/ad-files.js';
import { saveAreaVersion } from '../../src/areas.js';
import { paymentMessage } from '../../src/booking-desk.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { createAccount } from '../../src/brands.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { addPocBrand, sendPocForPayment, setPocAds } from '../../src/poc.js';
import { chooseAds, freshDatabase } from './fresh-db.js';

/** India time, as UTC seconds. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const SALES = 'Sana (sales)';
const SCREEN = 'SCR-0000002B';
const BOOKED = ist('2027-06-01T10:00:00');
/** The first booking's only hour: 14 June 2027, 10:00 India time. */
const DAY = '2027-06-14';
const FIRST = lineStartsAt({ date: DAY, startHour: 10 });

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const store = fakeFileStore({ baseUrl: 'https://admin.test/api/files', secret: 'test' });
const link = (k: string, u: number) => store.readLink(k, u);
const ads = (files: readonly { ad: string }[]) => files.map((f) => f.ad).sort();

let adSeq = 0;
async function ad(brandId: string, review: 'approved' | 'rejected' = 'approved') {
  adSeq += 1;
  const adId = `AD-${adSeq.toString(16).toUpperCase().padStart(10, '0')}`;
  await pool.query(
    `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, 1000, 'png', '[]', 'pass', 'test', now())`,
    [adId, brandId, `Ad ${adSeq}`, adSeq.toString(16).padStart(64, '0')],
  );
  await pool.query(
    `INSERT INTO ad_reviews (ad_id, decision, reason, checklist, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, '{}', 'reviewer', now())`,
    [adId, review, review === 'rejected' ? 'Looks like a road sign' : null],
  );
  return adId;
}
async function account(brandId: string) {
  await createAccount(
    pool,
    {
      brandId,
      kind: 'brand',
      details: { name: brandId, agencyId: null, referredBy: null, active: true },
      by: SALES,
      reason: 'test',
    },
    BOOKED - 86_400,
  );
}
/** A booking of one hour in Madhapur, paid, its ads chosen and approved. */
async function booking(bookingId: string, brandId: string, date: string, adIds: string[]) {
  await createBooking(
    pool,
    {
      bookingId,
      brandId,
      request: {
        lines: [{ areaId: 'hyd-madhapur', date, startHour: 10, bikes: 5 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, bookingId, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, bookingId, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await chooseAds(pool, bookingId, adIds);
  await moveBooking(pool, bookingId, 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
}

const A: Record<string, string> = {};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  for (const b of ['chai', 'ponnu', 'recall']) await account(b);
  A.chai1 = await ad('chai');
  A.chai2 = await ad('chai');
  A.chaiRejected = await ad('chai', 'rejected');
  A.ponnu = await ad('ponnu');
  A.own = await ad('recall');
  await pool.query(
    `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
     VALUES ($1, 'serial-2b', 'test box', 'fitter', now())`,
    [SCREEN],
  );
  await booking('BK-F1', 'chai', DAY, [A.chai1, A.chai2, A.chaiRejected]);
  // Five days later: not sent yet on the 13th.
  await booking('BK-F2', 'ponnu', '2027-06-19', [A.ponnu]);
}, 60_000);
afterAll(async () => db.drop());

describe('the files a screen keeps (P2.4.2)', () => {
  it("a booking's approved ads from 24 hours before its first hour, RECALL's own always", async () => {
    // Two days before: only RECALL's own.
    expect(ads(await screenAdFiles(pool, SCREEN, FIRST - 2 * 86_400, link))).toEqual([A.own]);
    // 20 hours before: the booking's approved ads too (never the rejected one).
    const files = await screenAdFiles(pool, SCREEN, FIRST - 20 * 3600, link);
    expect(ads(files)).toEqual([A.chai1, A.chai2, A.own].sort());
    // Kept until a day after its last hour (a make-up may play the same hour the next day).
    const chai = files.find((f) => f.ad === A.chai1);
    expect(chai?.keepUntil).toBe(FIRST + 3600 + MAKE_UP_KEEP_SECONDS);
    expect(chai?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The one needed soonest first.
    expect(files[0]?.ad).toBe(A.own);
    // Each link is HTTPS, signed by the store, and the list reads back as the box reads it.
    for (const f of files) {
      expect(f.url.startsWith('https://admin.test/api/files/')).toBe(true);
      const u = new URL(f.url);
      const until = Number(u.searchParams.get('until'));
      expect(
        store.checkLink(f.sha256, until, u.searchParams.get('sig') ?? '', FIRST - 20 * 3600),
      ).toBe(true);
    }
    const text = adFilesText(files, (FIRST - 20 * 3600) * 1000);
    expect('files' in parseAdFiles(text) && parseAdFiles(text)).toMatchObject({ files });
  });

  it('a screen we do not know gets none; every enrolled screen gets the same files', async () => {
    expect(await screenAdFiles(pool, 'SCR-0000009Z', FIRST - 3600, link)).toEqual([]);
    const needed = await neededAdFiles(pool, FIRST - 3600);
    expect(needed.left).toBe(0);
    expect(ads(signAdFiles(needed.files, link, FIRST - 3600))).toEqual(
      ads(await screenAdFiles(pool, SCREEN, FIRST - 3600, link)),
    );
  });

  it('a link that is not HTTPS is left out (the box would refuse the whole list)', () => {
    const plain = fakeFileStore({ baseUrl: 'http://localhost:3001/api/files', secret: 's' });
    const needed = [
      { ad: A.own ?? '', sha256: 'a'.repeat(64), bytes: 10, keepUntil: FIRST, needFrom: 0 },
    ];
    expect(signAdFiles(needed, (k, u) => plain.readLink(k, u), FIRST - 3600)).toEqual([]);
  });

  it('a cancelled booking drops its files', async () => {
    const before = FIRST - 3 * 3600;
    expect(ads(await screenAdFiles(pool, SCREEN, before, link))).toContain(A.chai1);
    await moveBooking(pool, 'BK-F1', 'cancelled', { by: 'priya', actor: 'admin' }, before);
    expect(ads(await screenAdFiles(pool, SCREEN, before + 60, link))).toEqual([A.own]);
  });

  it('a booking long over keeps nothing; one starting tomorrow is sent', async () => {
    const f2 = lineStartsAt({ date: '2027-06-19', startHour: 10 });
    expect(ads(await screenAdFiles(pool, SCREEN, f2 - 3600, link))).toContain(A.ponnu);
    expect(ads(await screenAdFiles(pool, SCREEN, f2 + 3600 + MAKE_UP_KEEP_SECONDS, link))).toEqual([
      A.own,
    ]);
  });

  it("while the POC is scheduled and running: its paid brands' ads and RECALL's own, until its month ends", async () => {
    const ON = ist('2027-07-15T11:00:00');
    const AUG = pocMonthWindow('2027-08');
    await setBusinessMode(pool, 'poc', { id: 'prateek', role: 'super-admin' }, 'POC on', ON);
    const poc1 = await ad('ponnu');
    const poc2 = await ad('ponnu');
    await addPocBrand(
      pool,
      { brandId: 'ponnu', firstMonth: '2027-08', months: 1, adIds: [poc1, poc2], reason: 'signed' },
      SALES,
      ON,
    );
    // Not paid yet: nothing of the brand's goes to the screens.
    expect(ads(await screenAdFiles(pool, SCREEN, ON + 60, link))).toEqual([A.own]);
    const payments = fakePayments({ clock: () => ON + 600 });
    const l = await sendPocForPayment(pool, payments, 'poc/ponnu/2027-08', SALES, ON + 300);
    const m = payments.pay(l.linkId);
    expect(await paymentMessage(pool, payments, m.body, m.signature, ON + 600)).toBe('paid');
    // Paid: scheduled for August, its ads go out now, kept until August's end.
    const files = await screenAdFiles(pool, SCREEN, ON + 700, link);
    expect(ads(files)).toEqual([A.own, poc1, poc2].sort());
    expect(files.find((f) => f.ad === poc1)?.keepUntil).toBe(AUG.endsAt);
    // RECALL's own ads are kept at least to the POC month's end too.
    expect(files.find((f) => f.ad === A.own)?.keepUntil).toBe(AUG.endsAt);
    // Running, mid-August: the same.
    const mid = AUG.startsAt + 5 * 86_400;
    expect(ads(await screenAdFiles(pool, SCREEN, mid, link))).toEqual([A.own, poc1, poc2].sort());
    // S4: the brand changes its ads: the earlier ones stay listed for the 30-minute grace (screens
    // take the new plan with their next hello), then go.
    const poc3 = await ad('ponnu');
    await setPocAds(pool, 'ponnu', [poc2, poc3], SALES, mid);
    expect(ads(await screenAdFiles(pool, SCREEN, mid + 60, link))).toEqual(
      [A.own, poc1, poc2, poc3].sort(),
    );
    expect(
      (await screenAdFiles(pool, SCREEN, mid + 60, link)).find((f) => f.ad === poc1)?.keepUntil,
    ).toBe(mid + 1800);
    expect(ads(await screenAdFiles(pool, SCREEN, mid + 1801, link))).toEqual(
      [A.own, poc2, poc3].sort(),
    );
  });
});

describe('review fixes (S4, m4)', () => {
  const DAY3 = '2027-06-25';
  const first = lineStartsAt({ date: DAY3, startHour: 10 });
  let old1 = '';
  let new1 = '';
  beforeAll(async () => {
    old1 = await ad('chai');
    new1 = await ad('chai');
    await booking('BK-F3', 'chai', DAY3, [old1]);
  });

  it("S4: a booking's earlier ads stay listed 30 minutes after a change", async () => {
    const t = first - 3 * 3600;
    await pool.query(
      `INSERT INTO booking_ad_sets (booking_id, version, ad_ids, set_by, set_at)
       SELECT 'BK-F3', max(version) + 1, $1, 'test', to_timestamp($2)
         FROM booking_ad_sets WHERE booking_id = 'BK-F3'`,
      [[new1], t],
    );
    const during = ads(await screenAdFiles(pool, SCREEN, t + 60, link));
    expect(during).toContain(old1);
    expect(during).toContain(new1);
    const after = ads(await screenAdFiles(pool, SCREEN, t + 1801, link));
    expect(after).not.toContain(old1);
    expect(after).toContain(new1);
  });

  it('m4: a booking whose report was sent keeps its files for its make-ups', async () => {
    const last = first + 3600;
    for (const [state, at] of [
      ['running', first],
      ['done', last],
      ['report-sent', last + 600],
    ] as const)
      await pool.query(
        `INSERT INTO booking_events (booking_id, seq, state, at, by_who)
         SELECT 'BK-F3', max(seq) + 1, $1, to_timestamp($2), 'test'
           FROM booking_events WHERE booking_id = 'BK-F3'`,
        [state, at],
      );
    expect(ads(await screenAdFiles(pool, SCREEN, last + 3600, link))).toContain(new1);
    expect(ads(await screenAdFiles(pool, SCREEN, last + MAKE_UP_KEEP_SECONDS, link))).not.toContain(
      new1,
    );
  });
});
