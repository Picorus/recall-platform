// P7.8: the POC package in the database. The switch (scheduled before the 1st, ended by hand with a
// guard against ending early), brands and their months, paying before each month (invoice, ledger,
// money owed back), earning day by day, the screens' plan, counting plays (at most 5 a brand a
// bike-hour, never twice) and the 200-bike limit.
import { fakePayments } from '@recall/adapters';
import {
  DEFAULT_POC_RULES,
  playBytes,
  pocMonthWindow,
  PRICE_BOOK_V1,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brandDocuments } from '../../src/brand-invoices.js';
import { applyLinkStatus, expireUnpaid, paymentMessage } from '../../src/booking-desk.js';
import { moneyBackItem } from '../../src/money-back.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { createAccount } from '../../src/brands.js';
import {
  businessModeHistory,
  businessModes,
  cancelScheduledPoc,
  canSwitch,
  EarlyEnd,
  pocPhaseAt,
  setBusinessMode,
} from '../../src/business-mode.js';
import { closeEarnings } from '../../src/earnings.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import { paymentsIn } from '../../src/money.js';
import { addScreenKey, revokeScreenKey } from '../../src/plays.js';
import {
  addPocBrand,
  bikesFitted,
  brandPocPage,
  earnPocMonths,
  paidInForce,
  pocJudge,
  stopPocLinks,
  expirePocLinks,
  owePocMonthsBack,
  checkPocBikeRoom,
  pocDesk,
  pocPlans,
  sendPocForPayment,
  setPocAds,
} from '../../src/poc.js';
import { pocReport } from '../../src/poc-report.js';
import { storeUpload } from '../../src/screen-reports.js';
import { saveSetting } from '../../src/settings.js';
import { freshDatabase } from './fresh-db.js';

/** India time, as UTC seconds. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const SALES = 'Sana (sales)';
const ON = ist('2027-07-15T11:00:00');
const AUG = pocMonthWindow('2027-08');

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let clock = ON;
const payments = fakePayments({ clock: () => clock });

let adSeq = 0;
/** An ad of a brand, its automatic checks passed; approved or rejected in review (or neither). */
async function ad(brandId: string, review: 'approved' | 'rejected' | null = 'approved') {
  adSeq += 1;
  const adId = `AD-${adSeq.toString(16).toUpperCase().padStart(10, '0')}`;
  await pool.query(
    `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, 1000, 'png', '[]', 'pass', 'test', now())`,
    [adId, brandId, `Ad ${adSeq}`, adSeq.toString(16).padStart(64, '0')],
  );
  if (review)
    await pool.query(
      `INSERT INTO ad_reviews (ad_id, decision, reason, checklist, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, '{}', 'reviewer', now())`,
      [adId, review, review === 'rejected' ? 'Looks like a road sign' : null],
    );
  return adId;
}

async function brand(brandId: string, kind: 'brand' | 'agency' = 'brand') {
  await createAccount(
    pool,
    {
      brandId,
      kind,
      details: { name: brandId, agencyId: null, referredBy: null, active: true },
      by: SALES,
      reason: 'test',
    },
    ON - 86_400,
  );
}

const ads: Record<string, string[]> = {};
const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SCREEN = 'SCR-0000001A';
let seq = 0;
/** Signed POC plays (15 s apart) near Hitech City, as the screen makes them. */
function plays(
  ref: string,
  adId: string,
  startAt: number,
  n: number,
  o: Partial<PlayReport> = {},
): Numbered[] {
  return Array.from({ length: n }, (_, i) => {
    seq += 1;
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref,
      adId,
      startAt: startAt + i * 15,
      lengthS: 15,
      latE6: 17_455_000,
      lngE6: 78_385_000,
      accuracyM: 6,
      place: 'outside',
      people: 4,
      ...o,
    };
    const sig = sign('sha256', Buffer.from(playBytes(SCREEN, seq, body)), {
      key: key.privateKey,
      dsaEncoding: 'der',
    }).toString('base64');
    return { seq, at: body.startAt + 15, report: { ...body, sig } };
  });
}
const counted = async (ref: string) =>
  (
    await pool.query<{ counts: string; reason: string | null }>(
      'SELECT counts, reason FROM plays WHERE ref = $1 ORDER BY start_at',
      [ref],
    )
  ).rows;

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  for (const b of ['alpha', 'beta', 'gamma', 'delta']) {
    await brand(b);
    ads[b] = [await ad(b), await ad(b)];
  }
  await brand('media-house', 'agency');
  await addScreenKey(
    pool,
    SCREEN,
    'k1',
    key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
}, 120_000);
afterAll(async () => {
  await db.drop();
});

describe('the switch (P7.8): scheduled before the 1st, ended by hand', () => {
  it('POC brands join only a POC that is switched on', async () => {
    await expect(
      addPocBrand(
        pool,
        {
          brandId: 'alpha',
          firstMonth: '2027-08',
          months: 3,
          adIds: ads.alpha ?? [],
          reason: 'signed for 3 months',
        },
        SALES,
        ON,
      ),
    ).rejects.toThrow(/Switch the business to POC first/);
  });

  it('switched on mid-month: scheduled, counting from 08:00 on the next 1st', async () => {
    expect(await setBusinessMode(pool, 'poc', SUPER, 'POC with 40 brands', ON)).toBe(AUG.startsAt);
    expect(await pocPhaseAt(pool, ON)).toEqual({
      phase: 'scheduled',
      startsAt: AUG.startsAt,
      plannedEnd: ist('2027-11-01T08:00:00'),
      endedAt: null,
    });
    expect(await canSwitch(pool, ON)).toBe(true);
  });
});

describe('brands, months and ads (P7.8.1)', () => {
  it('sales adds a brand with its commitment and ads; each month at the fee + GST of the day', async () => {
    expect(
      await addPocBrand(
        pool,
        {
          brandId: 'alpha',
          firstMonth: '2027-08',
          months: 3,
          adIds: ads.alpha ?? [],
          reason: 'signed for 3 months',
        },
        SALES,
        ON,
      ),
    ).toEqual(['poc/alpha/2027-08', 'poc/alpha/2027-09', 'poc/alpha/2027-10']);
    await addPocBrand(
      pool,
      {
        brandId: 'beta',
        firstMonth: '2027-08',
        months: 1,
        adIds: ads.beta ?? [],
        reason: 'one month to try',
      },
      SALES,
      ON,
    );
    const m = await pool.query<{ fee_paise: string; gst_paise: string }>(
      "SELECT fee_paise, gst_paise FROM poc_months WHERE ref = 'poc/alpha/2027-08'",
    );
    expect(m.rows[0]).toEqual({ fee_paise: '25000000', gst_paise: '4500000' });
  });

  it('refuses what does not fit, in plain words', async () => {
    const add = (o: Partial<Parameters<typeof addPocBrand>[1]>) =>
      addPocBrand(
        pool,
        {
          brandId: 'gamma',
          firstMonth: '2027-08',
          months: 1,
          adIds: ads.gamma ?? [],
          reason: 'signed up',
          ...o,
        },
        SALES,
        ON,
      );
    await expect(add({ firstMonth: '2027-07' })).rejects.toThrow(/July 2027 has started/);
    await expect(add({ firstMonth: '2027-09', months: 3 })).rejects.toThrow(/planned to end/);
    await expect(add({ months: 4 })).rejects.toThrow(/1 to 3 months/);
    await expect(add({ brandId: 'media-house' })).rejects.toThrow(/agency/);
    await expect(add({ brandId: 'alpha' })).rejects.toThrow(/already on the POC/);
    await expect(add({ adIds: [ads.gamma?.[0] ?? ''] })).rejects.toThrow(/2 to 5 ads/);
    await expect(add({ adIds: [ads.gamma?.[0] ?? '', ads.alpha?.[0] ?? ''] })).rejects.toThrow(
      /not one of this brand's ads/,
    );
    const rejected = await ad('gamma', 'rejected');
    await expect(add({ adIds: [ads.gamma?.[0] ?? '', rejected] })).rejects.toThrow(/rejected/);
    // The most brands in a month (a setting: 2 here, 40 by default).
    await saveSetting(
      pool,
      'poc',
      { ...DEFAULT_POC_RULES, maxBrands: 2 },
      SUPER,
      'test the cap',
      0,
    );
    await expect(add({})).rejects.toThrow(/2 brands already have August 2027: the POC is full/);
    await saveSetting(pool, 'poc', DEFAULT_POC_RULES, SUPER, 'back to 40', 1);
    await add({});
    // An ad not reviewed yet may be chosen; only approved ones play.
    const waiting = await ad('gamma', null);
    expect(await setPocAds(pool, 'gamma', [...(ads.gamma ?? []), waiting], SALES, ON + 60)).toBe(2);
    await expect(setPocAds(pool, 'delta', ads.delta ?? [], SALES, ON)).rejects.toThrow(
      /not on the POC/,
    );
  });
});

describe('paying before each month (P7.8.1)', () => {
  it('a link, the payment, the tax invoice and the books, in one step', async () => {
    const link = await sendPocForPayment(pool, payments, 'poc/alpha/2027-08', SALES, ON);
    expect(link.amountPaise).toBe(29_500_000);
    expect(link.expiresAt).toBe(ON + 24 * 3600);
    // Asking again gives the same link.
    expect(
      (await sendPocForPayment(pool, payments, 'poc/alpha/2027-08', SALES, ON + 5)).linkId,
    ).toBe(link.linkId);
    clock = ON + 600;
    const m = payments.pay(link.linkId);
    expect(await paymentMessage(pool, payments, m.body, m.signature, ON + 600)).toBe('paid');
    expect(await paymentMessage(pool, payments, m.body, m.signature, ON + 700)).toBe('already');
    await expect(
      sendPocForPayment(pool, payments, 'poc/alpha/2027-08', SALES, ON + 800),
    ).rejects.toThrow(/is paid/);
    const held = await accountTotals(pool, 'campaign-held', { ref: 'poc/alpha/2027-08' });
    expect(held.credit - held.debit).toBe(25_000_000);
    const tb = await trialBalance(pool);
    expect(tb.debit).toBe(tb.credit);
    const docs = await brandDocuments(pool, 'alpha', null, ON + 900);
    expect(docs.documents).toHaveLength(1);
    expect(docs.documents[0]).toMatchObject({
      bookingId: 'poc/alpha/2027-08',
      pocMonth: '2027-08',
      taxablePaise: 25_000_000,
      totalPaise: 29_500_000,
      firstDay: '2027-08-01',
      lastDay: '2027-08-31',
    });
    const inJuly = await paymentsIn(pool, '2027-07');
    expect(inJuly.payments.map((p) => [p.bookingId, p.brandId, p.state])).toEqual([
      ['poc/alpha/2027-08', 'alpha', 'paid'],
    ]);
  });

  it('a second payment, or a wrong amount, is owed back; never kept twice', async () => {
    const first = await sendPocForPayment(pool, payments, 'poc/beta/2027-08', SALES, ON);
    // The first link ran out unpaid; a second one is made and paid.
    const second = await sendPocForPayment(
      pool,
      payments,
      'poc/beta/2027-08',
      SALES,
      ON + 25 * 3600,
    );
    expect(second.linkId).not.toBe(first.linkId);
    clock = ON + 25 * 3600 + 60;
    const m = payments.pay(second.linkId);
    expect(await paymentMessage(pool, payments, m.body, m.signature, clock)).toBe('paid');
    // The provider says the first link was paid too: owed back.
    const paid = (paymentId: string, amountPaise = 29_500_000) =>
      ({ state: 'paid', paymentId, paidAt: clock, amountPaise }) as const;
    expect(await applyLinkStatus(pool, first.linkId, paid('pay_twice'), clock + 60)).toBe(
      'paid-late',
    );
    const back = await accountTotals(pool, 'refunds-payable', { party: 'beta' });
    expect(back.credit - back.debit).toBe(29_500_000);
    // A wrong amount on a gamma link: owed back too.
    const g = await sendPocForPayment(pool, payments, 'poc/gamma/2027-08', SALES, clock);
    expect(await applyLinkStatus(pool, g.linkId, paid('pay_wrong', 100), clock + 60)).toBe(
      'wrong-amount',
    );
    const tb = await trialBalance(pool);
    expect(tb.debit).toBe(tb.credit);
  });

  it('a month is paid before it starts or not at all; unpaid links run out', async () => {
    await expect(
      sendPocForPayment(pool, payments, 'poc/gamma/2027-08', SALES, AUG.startsAt - 600),
    ).rejects.toThrow(/has started \(or starts in less than 15 minutes\)/);
    // gamma's link (from the wrong-amount payment) runs out at its end, with nothing paid.
    await expireUnpaid(pool, payments, ON + 4 * 86_400);
    const ev = await pool.query<{ state: string }>(
      `SELECT e.state FROM payment_link_events e JOIN payment_links l USING (link_id)
        WHERE l.poc_ref = 'poc/gamma/2027-08' ORDER BY e.id`,
    );
    expect(ev.rows.map((x) => x.state)).toEqual(['wrong-amount', 'expired']);
    const page = await brandPocPage(pool, 'gamma', AUG.startsAt + 60);
    expect(page?.months.map((x) => x.state)).toEqual(['missed']);
    expect((await brandPocPage(pool, 'alpha', ON + 3600))?.months.map((x) => x.state)).toEqual([
      'paid',
      'to-pay',
      'to-pay',
    ]);
    expect(await brandPocPage(pool, 'delta', ON)).toBeUndefined();
  });
});

describe('the screens and the plays (P7.8.2)', () => {
  it('the plan for August: the brands paid for it, their approved ads, the zone', async () => {
    const [aug, ...rest] = await pocPlans(pool, ist('2027-07-31T12:00:00'));
    expect(rest).toEqual([]);
    expect(aug).toMatchObject({
      month: '2027-08',
      startsAt: AUG.startsAt,
      endsAt: AUG.endsAt,
      slots: 40,
      perBrand: 5,
      zone: { kind: 'circle', radiusM: 15_000 },
      // Every brand of the month in a fixed slot: gamma, not paid, keeps its slot with no ads.
      brands: [
        { ref: 'poc/alpha/2027-08', ads: ads.alpha },
        { ref: 'poc/beta/2027-08', ads: ads.beta },
        { ref: 'poc/gamma/2027-08', ads: [] },
      ],
      recallAds: [],
    });
    // In July (regular business) only August's plan is sent ahead; nothing for July.
    expect((await pocPlans(pool, ist('2027-07-20T12:00:00'))).map((p) => p.month)).toEqual([
      '2027-08',
    ]);
  });

  it('5 a brand a bike-hour count; the 6th, an unpaid month, a stranger ad, outside the zone do not', async () => {
    const hour = ist('2027-08-02T18:00:00');
    const a = ads.alpha?.[0] ?? '';
    const batch = [
      ...plays('poc/alpha/2027-08', a, hour, 6),
      ...plays('poc/beta/2027-08', ads.beta?.[1] ?? '', hour + 100, 1),
      ...plays('poc/gamma/2027-08', ads.gamma?.[0] ?? '', hour + 120, 1),
      ...plays('poc/alpha/2027-08', ads.beta?.[0] ?? '', hour + 140, 1),
      ...plays('poc/beta/2027-08', ads.beta?.[0] ?? '', hour + 160, 1, { latE6: 17_900_000 }),
      // Before the POC starts, and at night.
      ...plays('poc/alpha/2027-08', a, ist('2027-07-31T18:00:00'), 1),
      ...plays('poc/alpha/2027-08', a, ist('2027-08-03T03:00:00'), 1),
    ].sort((x, y) => x.seq - y.seq);
    const at = ist('2027-08-03T09:00:00');
    await storeUpload(pool, SCREEN, batch, 1, at);
    const alpha = await counted('poc/alpha/2027-08');
    expect(alpha.map((x) => x.reason ?? x.counts)).toEqual([
      'the POC was not on',
      'inside',
      'inside',
      'inside',
      'inside',
      'inside',
      'more than 5 this bike-hour',
      'not one of its ads',
      'outside business hours',
    ]);
    expect((await counted('poc/beta/2027-08')).map((x) => x.reason ?? x.counts)).toEqual([
      'inside',
      'outside the POC zone',
    ]);
    expect((await counted('poc/gamma/2027-08')).map((x) => x.reason ?? x.counts)).toEqual([
      'POC month not paid',
    ]);
    // The same upload again changes nothing; a later one in the same hour is still over the 5.
    await storeUpload(pool, SCREEN, batch, 1, at + 60);
    await storeUpload(pool, SCREEN, plays('poc/alpha/2027-08', a, hour + 3000, 1), 1, at + 120);
    const after = await counted('poc/alpha/2027-08');
    expect(after.filter((x) => x.counts === 'inside')).toHaveLength(5);
    expect(after.at(-2)?.reason).toBe('more than 5 this bike-hour');
    // The next hour starts afresh.
    await storeUpload(pool, SCREEN, plays('poc/alpha/2027-08', a, hour + 3600, 2), 1, at + 180);
    expect((await counted('poc/alpha/2027-08')).filter((x) => x.counts === 'inside')).toHaveLength(
      7,
    );
  });

  it('the brand report and the staff desk show the numbers (people only as a range)', async () => {
    const r = await pocReport(pool, 'alpha', '2027-08');
    expect(r).toMatchObject({ ref: 'poc/alpha/2027-08', plays: 7, bikes: 1, bikeHours: 2 });
    expect(r?.days).toEqual([{ day: '2027-08-02', plays: 7, bikes: 1, bikeHours: 2 }]);
    expect(r?.months.map((m) => [m.month, m.plays])).toEqual([
      ['2027-08', 7],
      ['2027-09', 0],
      ['2027-10', 0],
    ]);
    expect(r?.people.approximate).toBe(true);
    expect(r?.streets).toEqual([]);
    const withMaps = await pocReport(pool, 'alpha', '2027-08', {
      streetAt: () => Promise.resolve('Hitech City Main Road'),
    });
    expect(withMaps?.streets).toEqual([{ name: 'Hitech City Main Road', plays: 7 }]);
    expect(await pocReport(pool, 'alpha', '2027-12')).toBeUndefined();
    const desk = await pocDesk(pool, ist('2027-08-02T20:00:00'));
    expect(desk).toMatchObject({ on: true, month: '2027-08', perBrand: 5, openFrom: '2027-09' });
    expect(desk.brands.map((b) => [b.brandId, b.playsMonth, b.playsToday])).toEqual([
      ['alpha', 7, 7],
      ['beta', 1, 1],
      ['gamma', 0, 0],
    ]);
    expect(desk.brands[0]?.months.map((m) => m.state)).toEqual(['paid', 'to-pay', 'to-pay']);
  });
});

describe('a payment that comes too late (P7.8.1)', () => {
  it('news of a payment long after the month started is owed back, never kept', async () => {
    const link = await sendPocForPayment(
      pool,
      payments,
      'poc/alpha/2027-09',
      SALES,
      ON + 2 * 86_400,
    );
    const late = pocMonthWindow('2027-09').startsAt + 3 * 86_400;
    expect(
      await applyLinkStatus(
        pool,
        link.linkId,
        { state: 'paid', paymentId: 'pay_days_late', paidAt: late, amountPaise: link.amountPaise },
        late,
      ),
    ).toBe('paid-late');
    expect((await brandPocPage(pool, 'alpha', late))?.months.map((m) => m.state)).toEqual([
      'paid',
      'missed',
      'to-pay',
    ]);
    const back = await accountTotals(pool, 'refunds-payable', { party: 'alpha' });
    expect(back.credit - back.debit).toBe(29_500_000);
  });
});

describe('earning a month as it runs', () => {
  it('day by day: the whole fee by the end of the month, never twice, the books balanced', async () => {
    await closeEarnings(pool, ist('2027-08-02T02:00:00'));
    const rev = async () => {
      const t = await accountTotals(pool, 'revenue', { ref: 'poc/alpha/2027-08' });
      return t.credit - t.debit;
    };
    // 1 August has ended (at 02:00 on the 2nd): 1/31 of the fee.
    expect(await rev()).toBe(Math.floor(25_000_000 / 31));
    await closeEarnings(pool, ist('2027-08-20T10:00:00'));
    await closeEarnings(pool, ist('2027-08-20T10:10:00'));
    expect(await rev()).toBe(Math.floor((25_000_000 * 19) / 31));
    await closeEarnings(pool, AUG.endsAt);
    expect(await rev()).toBe(25_000_000);
    const held = await accountTotals(pool, 'campaign-held', { ref: 'poc/alpha/2027-08' });
    expect(held.credit - held.debit).toBe(0);
    // Dated the day itself, so August's revenue stays in August.
    const last = await pool.query<{ at: Date }>(
      "SELECT at FROM ledger_entries WHERE entry_id = 'poc-earned:poc/alpha/2027-08:2027-08-31'",
    );
    expect(last.rows[0]?.at.toISOString()).toBe('2027-08-31T18:29:59.000Z');
    const tb = await trialBalance(pool);
    expect(tb.debit).toBe(tb.credit);
  });
});

describe('the 200 bikes (P7.8.1)', () => {
  it('while the POC is on, a fitting past the limit is refused in plain words', async () => {
    const t = ist('2027-08-05T10:00:00');
    await pool.query(
      `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
       SELECT 'SCR-' || lpad(g::text, 8, '0'), 'HW-' || g, 'test', 'test', to_timestamp($1)
         FROM generate_series(1, 200) g`,
      [t - 7200],
    );
    await pool.query(
      `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by)
       SELECT 'SCR-' || lpad(g::text, 8, '0'), to_timestamp($1), 'TS09EA' || lpad(g::text, 4, '0'),
              'R-' || g, 'fitted', 'test'
         FROM generate_series(1, 200) g`,
      [t - 3600],
    );
    expect(await bikesFitted(pool, t)).toBe(200);
    await expect(checkPocBikeRoom(pool, t)).rejects.toThrow(
      /The POC has room for 200 bikes and 200 already have a screen: take a screen off a bike first/,
    );
    // Before the POC (regular business) there is no such limit.
    await expect(checkPocBikeRoom(pool, ist('2027-07-20T10:00:00'))).resolves.toBeUndefined();
  });
});

describe('switching back (Prateek, 28 Oct 2026): by hand, never early by mistake', () => {
  it('mid-month 2 and the 00:30 tail of the 1st of month 4 are early: refused without early', async () => {
    await expect(
      setBusinessMode(pool, 'regular', SUPER, 'stop now', ist('2027-09-15T12:00:00')),
    ).rejects.toThrow(EarlyEnd);
    await expect(
      setBusinessMode(pool, 'regular', SUPER, 'done', ist('2027-11-01T00:30:00')),
    ).rejects.toThrow(/ends the POC 1 day early/);
    expect((await businessModes(pool)).map((c) => c.mode)).toEqual(['poc']);
  });

  it('09:00 on the 1st of month 4 goes through; then the POC can never be switched on again', async () => {
    const t = ist('2027-11-01T09:00:00');
    expect(await setBusinessMode(pool, 'regular', SUPER, 'POC done', t)).toBe(
      ist('2027-11-01T08:00:00'),
    );
    expect((await pocPhaseAt(pool, t)).phase).toBe('ended');
    expect(await canSwitch(pool, t)).toBe(false);
    await expect(setBusinessMode(pool, 'poc', SUPER, 'POC again', t + 86_400)).rejects.toThrow(
      /POC has ended/,
    );
  });
});

describe('ending early on purpose', () => {
  // The days after an early end never played: they stay held (for Prateek to decide), never earned.
  let db2: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    db2 = await freshDatabase();
  }, 120_000);
  afterAll(async () => {
    await db2.drop();
  });

  it('with early: true the switch back counts from that business day; then never again', async () => {
    const p2 = db2.pool;
    await savePriceBook(p2, PRICE_BOOK_V1, 'prateek');
    await createAccount(
      p2,
      {
        brandId: 'early',
        kind: 'brand',
        details: { name: 'Early', agencyId: null, referredBy: null, active: true },
        by: SALES,
        reason: 'test',
      },
      ON - 86_400,
    );
    await setBusinessMode(p2, 'poc', SUPER, 'POC on', ON);
    const early = [] as string[];
    for (const k of [1, 2]) {
      const adId = `AD-00000000B${k}`;
      await p2.query(
        `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
         VALUES ($1, 'early', 'ad', $2, 1, 'png', '[]', 'pass', 'test', now())`,
        [adId, String(k).repeat(64)],
      );
      await p2.query(
        `INSERT INTO ad_reviews (ad_id, decision, checklist, reviewed_by, reviewed_at)
         VALUES ($1, 'approved', '{}', 'r', now())`,
        [adId],
      );
      early.push(adId);
    }
    await addPocBrand(
      p2,
      { brandId: 'early', firstMonth: '2027-09', months: 1, adIds: early, reason: 'September' },
      SALES,
      ON,
    );
    const link = await sendPocForPayment(p2, payments, 'poc/early/2027-09', SALES, ON);
    expect(
      await applyLinkStatus(
        p2,
        link.linkId,
        { state: 'paid', paymentId: 'pay_early', paidAt: ON + 60, amountPaise: link.amountPaise },
        ON + 60,
      ),
    ).toBe('paid');
    const t = ist('2027-09-15T12:00:00');
    expect(
      await setBusinessMode(db2.pool, 'regular', SUPER, 'stopping early', t, { early: true }),
    ).toBe(ist('2027-09-15T08:00:00'));
    expect(await pocPhaseAt(db2.pool, t)).toMatchObject({
      phase: 'ended',
      endedAt: ist('2027-09-15T08:00:00'),
    });
    await expect(
      setBusinessMode(db2.pool, 'poc', SUPER, 'POC again', t + 86_400 * 30),
    ).rejects.toThrow(/POC has ended/);
    // September earned for its 14 POC days only; the other 16 stay held.
    await closeEarnings(p2, pocMonthWindow('2027-09').endsAt + 3600);
    const rev = await accountTotals(p2, 'revenue', { ref: 'poc/early/2027-09' });
    expect(rev.credit - rev.debit).toBe(Math.floor((25_000_000 * 14) / 30));
    const held = await accountTotals(p2, 'campaign-held', { ref: 'poc/early/2027-09' });
    expect(held.credit - held.debit).toBe(25_000_000 - Math.floor((25_000_000 * 14) / 30));
  });
});

describe('the most brands while the POC runs', () => {
  let db3: Awaited<ReturnType<typeof freshDatabase>>;
  beforeAll(async () => {
    db3 = await freshDatabase();
  }, 120_000);
  afterAll(async () => {
    await db3.drop();
  });

  it('cannot change while the POC runs (it sets every bike’s rotation)', async () => {
    // Switched on long ago: running now.
    await setBusinessMode(
      db3.pool,
      'poc',
      SUPER,
      'POC on',
      Date.parse('2026-01-15T06:00:00Z') / 1000,
    );
    await expect(
      saveSetting(db3.pool, 'poc', { ...DEFAULT_POC_RULES, maxBrands: 30 }, SUPER, 'fewer', 0),
    ).rejects.toThrow(/cannot change while the POC runs/);
    // The fee can: a month keeps the fee it was added at.
    expect(
      await saveSetting(
        db3.pool,
        'poc',
        { ...DEFAULT_POC_RULES, feePaise: 30_000_000 },
        SUPER,
        'dearer',
        0,
      ),
    ).toBe(1);
  });
});

/** A fresh database with the POC switched on at ON (scheduled from 1 August) and one brand. */
async function pocWorld(brandId: string, months = 1) {
  const d = await freshDatabase();
  const p = d.pool;
  await savePriceBook(p, PRICE_BOOK_V1, 'prateek');
  await createAccount(
    p,
    {
      brandId,
      kind: 'brand',
      details: { name: brandId, agencyId: null, referredBy: null, active: true },
      by: SALES,
      reason: 'test',
    },
    ON - 86_400,
  );
  await setBusinessMode(p, 'poc', SUPER, 'POC on', ON);
  const own: string[] = [];
  for (const k of [1, 2, 3]) {
    const adId = `AD-00000000C${k}`;
    await p.query(
      `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'ad', $3, 1, 'png', '[]', 'pass', 'test', now())`,
      [adId, brandId, String(k).repeat(64)],
    );
    await p.query(
      `INSERT INTO ad_reviews (ad_id, decision, checklist, reviewed_by, reviewed_at)
       VALUES ($1, 'approved', '{}', 'r', now())`,
      [adId],
    );
    own.push(adId);
  }
  await addPocBrand(
    p,
    { brandId, firstMonth: '2027-08', months, adIds: own.slice(0, 2), reason: 'signed up' },
    SALES,
    ON,
  );
  return { d, p, own };
}

describe('review fixes (P7.8): payment news, ad changes, revoked keys, bookings, cancelling', () => {
  it('a provider that cannot answer: asked again later, never taken as run out at once; a payment in time wins', async () => {
    const { d, p } = await pocWorld('news');
    try {
      const fake = fakePayments({ clock: () => ON });
      let down = true;
      const flaky = {
        ...fake,
        status: (id: string) => (down ? Promise.reject(new Error('timeout')) : fake.status(id)),
        cancelLink: (id: string) => fake.cancelLink(id),
        createLink: (r: Parameters<typeof fake.createLink>[0]) => fake.createLink(r),
      };
      const link = await sendPocForPayment(p, flaky, 'poc/news/2027-08', SALES, ON);
      const events = async () =>
        (
          await p.query<{ state: string }>(
            'SELECT state FROM payment_link_events WHERE link_id = $1 ORDER BY id',
            [link.linkId],
          )
        ).rows.map((x) => x.state);
      // Five minutes after its end, the provider does not answer: nothing recorded, tried again.
      await expirePocLinks(p, flaky, link.expiresAt + 300, () => undefined);
      expect(await events()).toEqual([]);
      // An hour after its end it is taken as run out.
      await expirePocLinks(p, flaky, link.expiresAt + 3_700, () => undefined);
      expect(await events()).toEqual(['expired']);
      down = false;
      // The provider then says it took the money before the link ended, while the news is still in
      // time: the payment wins over our own record.
      expect(
        await applyLinkStatus(
          p,
          link.linkId,
          {
            state: 'paid',
            paymentId: 'pay_in_time',
            paidAt: link.expiresAt - 60,
            amountPaise: link.amountPaise,
          },
          link.expiresAt + 3_800,
        ),
      ).toBe('paid');
      expect(await events()).toEqual(['expired', 'paid']);
    } finally {
      await d.drop();
    }
  });

  it('after a brand changes its ads, plays of the ads it had count for 30 minutes more', async () => {
    const { d, p, own } = await pocWorld('switcher');
    try {
      const link = await sendPocForPayment(p, payments, 'poc/switcher/2027-08', SALES, ON);
      await applyLinkStatus(
        p,
        link.linkId,
        { state: 'paid', paymentId: 'pay_sw', paidAt: ON, amountPaise: link.amountPaise },
        ON + 60,
      );
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const screen = 'SCR-0000004D';
      const spki = (x: typeof k.publicKey) =>
        x.export({ format: 'der', type: 'spki' }).toString('base64');
      await addScreenKey(p, screen, 'k1', spki(k.publicKey), 'fitter');
      let n = 0;
      const signed = (adId: string, startAt: number, key = k, keyId = 'k1'): Numbered => {
        n += 1;
        const body: Omit<PlayReport, 'sig'> = {
          kind: 'play',
          keyId,
          slot: 'brand',
          ref: 'poc/switcher/2027-08',
          adId,
          startAt,
          lengthS: 15,
          latE6: 17_455_000,
          lngE6: 78_385_000,
          accuracyM: 6,
          place: 'outside',
          people: 1,
        };
        const sig = sign('sha256', Buffer.from(playBytes(screen, n, body)), {
          key: key.privateKey,
          dsaEncoding: 'der',
        }).toString('base64');
        return { seq: n, at: startAt + 15, report: { ...body, sig } };
      };
      const change = ist('2027-08-03T18:05:00');
      await setPocAds(p, 'switcher', [own[1] ?? '', own[2] ?? ''], SALES, change);
      const old = own[0] ?? '';
      await storeUpload(
        p,
        screen,
        [
          signed(old, change + 600),
          signed(old, ist('2027-08-03T19:10:00')),
          signed(own[2] ?? '', ist('2027-08-03T19:20:00')),
        ],
        1,
        ist('2027-08-03T20:00:00'),
      );
      const rows = (
        await p.query<{ counts: string; reason: string | null }>(
          'SELECT counts, reason FROM plays WHERE screen_id = $1 ORDER BY start_at',
          [screen],
        )
      ).rows.map((x) => x.reason ?? x.counts);
      expect(rows).toEqual(['inside', 'not one of its ads', 'inside']);

      // A key given up: its late plays never use up the brand's 5 that bike-hour.
      const k2 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      await addScreenKey(p, screen, 'k2', spki(k2.publicKey), 'fitter');
      const hour = ist('2027-08-04T18:00:00');
      await revokeScreenKey(p, screen, 'k1', 'ops', 'box stolen at night', hour + 3_600);
      const batch = [
        ...Array.from({ length: 5 }, (_, i) => signed(own[1] ?? '', hour + i * 60)),
        ...Array.from({ length: 5 }, (_, i) => signed(own[2] ?? '', hour + 600 + i * 60, k2, 'k2')),
      ];
      await storeUpload(p, screen, batch, batch[0]?.seq ?? 1, ist('2027-08-04T20:00:00'));
      const k2rows = (
        await p.query<{ counts: string }>(
          `SELECT counts FROM plays WHERE screen_id = $1 AND key_id = 'k2'`,
          [screen],
        )
      ).rows.map((x) => x.counts);
      expect(k2rows).toEqual(['inside', 'inside', 'inside', 'inside', 'inside']);
      expect((await pocReport(p, 'switcher', '2027-08'))?.plays).toBe(2 + 5);
    } finally {
      await d.drop();
    }
  });

  it('while the POC is scheduled, an area booking for its hours is refused in plain words', async () => {
    const { d, p } = await pocWorld('booker');
    try {
      await expect(
        createBooking(
          p,
          {
            bookingId: 'BK-POC-1',
            brandId: 'booker',
            request: {
              lines: [{ areaId: 'hyd-madhapur', date: '2027-09-10', startHour: 19, bikes: 20 }],
              repeatMonths: 1,
              channel: 'admin',
            },
            by: SALES,
          },
          ON + 60,
        ),
      ).rejects.toThrow(
        /The POC uses every bike-hour from 1 Aug 2027; area bookings open again when regular business starts \(planned 1 Nov 2027\)/,
      );
    } finally {
      await d.drop();
    }
  });

  it('a scheduled POC cancelled before it starts: never ran, paid months owed back, schedulable again', async () => {
    const { d, p } = await pocWorld('cancelled', 2);
    try {
      const link = await sendPocForPayment(p, payments, 'poc/cancelled/2027-08', SALES, ON);
      await applyLinkStatus(
        p,
        link.linkId,
        { state: 'paid', paymentId: 'pay_cancel', paidAt: ON, amountPaise: link.amountPaise },
        ON + 60,
      );
      await expect(
        cancelScheduledPoc(p, { id: 'asha', role: 'admin' }, 'not yet', ON),
      ).rejects.toThrow(/super admin/);
      expect(await cancelScheduledPoc(p, SUPER, 'brands not ready', ON + 86_400)).toBe(
        AUG.startsAt,
      );
      expect(await businessModes(p)).toEqual([]);
      expect((await pocPhaseAt(p, ON + 86_400)).phase).toBe('none');
      expect((await businessModeHistory(p))[0]?.cancelled?.reason).toBe('brands not ready');
      expect(await owePocMonthsBack(p, ON + 86_400)).toEqual(['poc/cancelled/2027-08']);
      expect(await owePocMonthsBack(p, ON + 86_500)).toEqual([]);
      const back = await accountTotals(p, 'refunds-payable', { party: 'cancelled' });
      expect(back.credit - back.debit).toBe(29_500_000);
      const notes = await p.query<{ kind: string }>(
        "SELECT kind FROM gst_documents WHERE poc_ref = 'poc/cancelled/2027-08' ORDER BY n",
      );
      expect(notes.rows.map((x) => x.kind).sort()).toEqual(['credit-note', 'invoice']);
      const tb = await trialBalance(p);
      expect(tb.debit).toBe(tb.credit);
      // Its other month cannot be paid now.
      await expect(
        sendPocForPayment(p, payments, 'poc/cancelled/2027-09', SALES, ON + 86_400),
      ).rejects.toThrow(/September 2027 is not on this brand's POC package now/);
      await expect(cancelScheduledPoc(p, SUPER, 'again please', ON + 86_400)).rejects.toThrow(
        /No POC is scheduled/,
      );
      // It never ran: it can be scheduled again, for the same 1st.
      expect(await setBusinessMode(p, 'poc', SUPER, 'POC on again', ON + 2 * 86_400)).toBe(
        AUG.startsAt,
      );
      expect((await pocPhaseAt(p, ON + 2 * 86_400)).phase).toBe('scheduled');
      // Once it has started it cannot be cancelled.
      await expect(cancelScheduledPoc(p, SUPER, 'too late now', AUG.startsAt + 60)).rejects.toThrow(
        /has started/,
      );
    } finally {
      await d.drop();
    }
  });
});

describe('second review (P7.8): a cancelled POC, scheduled again', () => {
  const held = async (p: pg.Pool, ref: string) => {
    const t = await accountTotals(p, 'campaign-held', { ref });
    return t.credit - t.debit;
  };

  it('B1: cancel, schedule again, the brand rejoins and pays again: one earning, held never below 0', async () => {
    const { d, p, own } = await pocWorld('xray');
    const ref = 'poc/xray/2027-08';
    try {
      const fake = fakePayments({ clock: () => ON + 60 });
      const first = await sendPocForPayment(p, fake, ref, SALES, ON);
      const m1 = fake.pay(first.linkId);
      expect(await paymentMessage(p, fake, m1.body, m1.signature, ON + 60)).toBe('paid');
      expect(await held(p, ref)).toBe(25_000_000);
      // Cancelled: the brand and its month are closed, the payment goes back.
      await cancelScheduledPoc(p, SUPER, 'not ready yet', ON + 3600);
      expect(await owePocMonthsBack(p, ON + 3600)).toEqual([ref]);
      expect(await held(p, ref)).toBe(0);
      expect(await paidInForce(p, ref)).toBeUndefined();
      // Scheduled again for the same 1st: the closed brand is not in it, nor in the cap.
      await setBusinessMode(p, 'poc', SUPER, 'POC on again', ON + 7200);
      const plan = await pocPlans(p, ON + 7200);
      expect(plan.map((x) => x.brands.map((b) => b.ref))).toEqual([[]]);
      expect((await pocDesk(p, ON + 7200)).brands).toEqual([]);
      await expect(sendPocForPayment(p, fake, ref, SALES, ON + 7200)).rejects.toThrow(
        /not on this brand's POC package/,
      );
      const judge = pocJudge(p, SCREEN);
      expect((await judge.context(ref, AUG.startsAt + 3600)).month?.paid).toBe(false);
      // It rejoins: the month is in force again, and not paid ("This month is paid" no more).
      await addPocBrand(
        p,
        {
          brandId: 'xray',
          firstMonth: '2027-08',
          months: 1,
          adIds: own.slice(0, 2),
          reason: 'back in',
        },
        SALES,
        ON + 7300,
      );
      await expect(
        addPocBrand(
          p,
          {
            brandId: 'xray',
            firstMonth: '2027-08',
            months: 1,
            adIds: own.slice(0, 2),
            reason: 'twice',
          },
          SALES,
          ON + 7400,
        ),
      ).rejects.toThrow(/already on the POC package/);
      const fake2 = fakePayments({ clock: () => ON + 8000 });
      const second = await sendPocForPayment(p, fake2, ref, SALES, ON + 7500);
      expect(second.linkId).not.toBe(first.linkId);
      const m2 = fake2.pay(second.linkId);
      expect(await paymentMessage(p, fake2, m2.body, m2.signature, ON + 8000)).toBe('paid');
      expect(await held(p, ref)).toBe(25_000_000);
      expect((await pocPlans(p, ON + 8000))[0]?.brands.map((b) => [b.ref, b.ads.length])).toEqual([
        [ref, 2],
      ]);
      expect((await pocJudge(p, SCREEN).context(ref, AUG.startsAt + 3600)).month?.paid).toBe(true);
      // August runs: earned once, the whole fee, held back to 0, never below.
      await earnPocMonths(p, AUG.startsAt + 15 * 86_400);
      expect(await held(p, ref)).toBeGreaterThan(0);
      await earnPocMonths(p, AUG.endsAt + 3600);
      await earnPocMonths(p, AUG.endsAt + 7200);
      expect(await held(p, ref)).toBe(0);
      const earned = await accountTotals(p, 'revenue', { ref });
      expect(earned.credit - earned.debit).toBe(25_000_000);
      // Nothing more is owed back (the second payment is in force and ran).
      expect(await owePocMonthsBack(p, AUG.endsAt + 7200)).toEqual([]);
      const tb = await trialBalance(p);
      expect(tb.debit).toBe(tb.credit);
    } finally {
      await d.drop();
    }
  });

  it("S1: a cancel stops the month's live links; money taken after the cancel is owed back", async () => {
    const { d, p } = await pocWorld('sierra');
    const ref = 'poc/sierra/2027-08';
    try {
      const fake = fakePayments({ clock: () => ON + 600 });
      const live = await sendPocForPayment(p, fake, ref, SALES, ON);
      // The provider takes the money just as the POC is cancelled (its news comes after).
      const paidMsg = fake.pay(live.linkId);
      await cancelScheduledPoc(p, SUPER, 'not this year', ON + 900);
      expect(await paymentMessage(p, fake, paidMsg.body, paidMsg.signature, ON + 1000)).toBe(
        'paid-late',
      );
      expect(await held(p, ref)).toBe(0);
      const back = await accountTotals(p, 'refunds-payable', { party: 'sierra' });
      expect(back.credit - back.debit).toBe(29_500_000);
      // A link still out for a cancelled POC's month is stopped and recorded.
      const { d: d2, p: p2 } = await pocWorld('tango');
      try {
        const f2 = fakePayments({ clock: () => ON + 600 });
        const l2 = await sendPocForPayment(p2, f2, 'poc/tango/2027-08', SALES, ON);
        await cancelScheduledPoc(p2, SUPER, 'not this year', ON + 900);
        expect(await stopPocLinks(p2, f2, ON + 900, () => undefined)).toBe(1);
        const ev = await p2.query<{ state: string }>(
          'SELECT state FROM payment_link_events WHERE link_id = $1',
          [l2.linkId],
        );
        expect(ev.rows.map((x) => x.state)).toEqual(['cancelled']);
        expect(() => f2.pay(l2.linkId)).toThrow(/cannot be paid/);
        expect(await stopPocLinks(p2, f2, ON + 1000, () => undefined)).toBe(0);
      } finally {
        await d2.drop();
      }
    } finally {
      await d.drop();
    }
  });

  it('S1: a month paid, then the POC cancelled and the owing back not done: the payments job does it', async () => {
    const { d, p } = await pocWorld('uniform');
    const ref = 'poc/uniform/2027-08';
    try {
      const fake = fakePayments({ clock: () => ON + 60 });
      const l = await sendPocForPayment(p, fake, ref, SALES, ON);
      const m = fake.pay(l.linkId);
      expect(await paymentMessage(p, fake, m.body, m.signature, ON + 60)).toBe('paid');
      await cancelScheduledPoc(p, SUPER, 'not this year', ON + 900);
      // (The API failed before owing it back.) The next payments run does it, once.
      await expireUnpaid(p, fake, ON + 1800, () => undefined);
      await expireUnpaid(p, fake, ON + 2400, () => undefined);
      const e = await p.query<{ entry_id: string }>(
        "SELECT entry_id FROM ledger_entries WHERE kind = 'poc-cancelled' AND ref = $1",
        [ref],
      );
      expect(e.rows).toHaveLength(1);
      const owed = e.rows[0]?.entry_id ?? '';
      expect(owed).toMatch(new RegExp(`^poc-cancelled:${ref}:pay_`));
      expect(await held(p, ref)).toBe(0);
      // The money back item names the payment that goes back.
      expect((await moneyBackItem(p, owed))?.paymentId).toBe(owed.split(':')[2]);
    } finally {
      await d.drop();
    }
  });

  it('m2: past its planned end and still on, the POC keeps every hour: area bookings refused', async () => {
    const { d, p } = await pocWorld('whisky');
    try {
      const later = ist('2027-11-05T12:00:00'); // planned end 1 Nov; nobody switched back yet
      expect((await pocPhaseAt(p, later)).phase).toBe('running');
      await expect(
        createBooking(
          p,
          {
            bookingId: 'BK-POC-LATE',
            brandId: 'whisky',
            request: {
              lines: [{ areaId: 'hyd-madhapur', date: '2027-12-10', startHour: 19, bikes: 20 }],
              repeatMonths: 1,
              channel: 'admin',
            },
            by: SALES,
          },
          later,
        ),
      ).rejects.toThrow(/The POC is still on \(its planned end has passed\)/);
    } finally {
      await d.drop();
    }
  });

  it('m5: paying from the portal keeps the agreement first', async () => {
    const { d, p } = await pocWorld('victor');
    try {
      const broken = {
        ...fakePayments({ clock: () => ON }),
        createLink: () => Promise.reject(new Error('provider down')),
      };
      const { payPocFromPortal } = await import('../../src/poc.js');
      await expect(
        payPocFromPortal(
          p,
          broken,
          {
            brandId: 'victor',
            month: '2027-08',
            by: 'v@victor.in',
            ip: '1.2.3.4',
            termsVersion: 1,
          },
          ON,
        ),
      ).rejects.toThrow(/provider down/);
      const t = await p.query('SELECT 1 FROM poc_terms WHERE ref = $1', ['poc/victor/2027-08']);
      expect(t.rowCount).toBe(1);
    } finally {
      await d.drop();
    }
  });
});
