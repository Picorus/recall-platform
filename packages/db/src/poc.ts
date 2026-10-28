// P7.8 in the database: the POC package (Prateek, 29 Oct 2026). Sales adds a brand with its
// commitment (1 to 3 months) and its 2 to 5 ads; each month is paid before it starts through the
// payment provider (a link, then the provider's signed message; the tax invoice is made on payment);
// the screens get each month's plan and share every hour between the brands paid for it; the month
// is earned day by day as it runs. Nothing is promised: no make-ups, no refunds.
//
// Each brand's month is "poc/<brand>/<YYYY-MM>" everywhere: its payment links, its invoice, its
// ledger entries and every play the screens sign for it.
import type { LinkStatus, PaymentsAdapter } from '@recall/adapters';
import {
  addMonths,
  businessMonthAt,
  DEFAULT_SPOT_RULES,
  indiaHourOf,
  isMonth,
  isoAt,
  modeAt,
  moneyToReturn,
  nextMonth,
  parsePocRef,
  playsPerBrand,
  pocDayEarned,
  pocDaysOver,
  pocEndedAt,
  pocMonthMoney,
  pocMonthPaid,
  pocMonthWindow,
  pocRef,
  POC_TERMS_VERSION,
  pocMonthCancelled,
  priceBookAt,
  type ModeChange,
  type PocPlan,
  type PocPlayContext,
  type PocRules,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import type { PaymentOutcome, SentLink } from './booking-desk.js';
import { priceBooks } from './bookings.js';
import { findAccount } from './brands.js';
import { businessModes, pocPhaseAt } from './business-mode.js';
import { issueGstDocument } from './gst.js';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { setting } from './settings.js';

type Q = Pick<PoolClient, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Plays of POC months that count, leaving out plays a revoked key signed after it was given up (as
 * plays.ts playsOf), for `FROM_PLAYS`.
 */
export const COUNTED = `p.counts <> 'no' AND (r.key_id IS NULL OR (p.start_at < r.plays_until AND p.received_at < r.revoked_at))`;
export const FROM_PLAYS = `FROM plays p LEFT JOIN screen_key_revocations r
                     ON r.screen_id = p.screen_id AND r.key_id = p.key_id`;

/** RECALL's own ads are the approved ads of this account (opened by staff like a brand's). */
export const RECALL_OWN_ACCOUNT = 'recall';
/** A link must work at least this long (as for bookings). */
const MIN_LINK_SECONDS = 15 * 60;
/** A link that ran out is acted on this long after its end: a payment started in time may finish. */
const EXPIRY_GRACE_SECONDS = 2 * 60;
/** News of a payment taken before a month started may reach us this long after its start. */
const PAID_NEWS_GRACE_SECONDS = 30 * 60;
/**
 * After a brand's POC ads change, plays of the ads it had before still count this long: screens
 * take the new plan with their next hello (every 15 minutes, twice over for a missed one).
 */
export const ADS_CHANGE_GRACE_SECONDS = 30 * 60;
/** A link the provider cannot report on is treated as run out this long after its end (as bookings). */
const PROVIDER_SILENT_SECONDS = 60 * 60;
const AD_ID = /^AD-[0-9A-F]{10}$/;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** "November 2026" for "2026-11". */
export const monthName = (m: string): string =>
  `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;

/** The India calendar month of a moment. */
const calendarMonth = (t: number) => new Date((t + 19_800) * 1000).toISOString().slice(0, 7);

/** The first month a brand can still join from at `now`: its POC hours not yet started. */
export function firstOpenMonth(now: number): string {
  const m = calendarMonth(now);
  return pocMonthWindow(m).startsAt > now ? m : nextMonth(m);
}

/** The POC package's setting in force. */
export const pocRules = (c: Q): Promise<PocRules> => setting(c, 'poc');

/** Whether the business switch is on POC at `t`. */
export async function pocOnAt(c: Q, t: number): Promise<boolean> {
  return modeAt(await businessModes(c), t) === 'poc';
}

/** Screens on a bike at `t` (each screen's latest fitting says which bike, if any). */
export async function bikesFitted(c: Q, t: number): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT ON (screen_id) screen_id, bike FROM screen_fittings
        WHERE from_at <= to_timestamp($1) ORDER BY screen_id, from_at DESC) x
      WHERE bike IS NOT NULL`,
    [t],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * P7.8.1: while the POC is on, at most `maxBikes` screens on bikes. Called inside a fitting (which
 * holds the fittings lock), before a screen goes on a bike.
 */
export async function checkPocBikeRoom(c: Q, now: number): Promise<void> {
  if (!(await pocOnAt(c, now))) return;
  const { maxBikes } = await pocRules(c);
  const n = await bikesFitted(c, now);
  if (n >= maxBikes)
    throw new Refusal(
      `The POC has room for ${maxBikes.toLocaleString('en-IN')} bikes and ${n.toLocaleString('en-IN')} already have a screen: take a screen off a bike first, or a super admin raises the limit in Settings`,
      { code: 'poc-bikes-full', n: maxBikes },
    );
}

// ---------------------------------------------------------------- brands, months, ads

/** Checks a brand's POC ads: 2 to 5 of its own, none failed or rejected. Returns them (no repeats). */
async function checkAds(c: Q, brandId: string, adIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(adIds)];
  const bad = ids.find((id) => !AD_ID.test(id));
  if (bad !== undefined) throw new Refusal(`${bad.slice(0, 20)} is not an ad id`);
  const { minAds, maxAds } = DEFAULT_SPOT_RULES;
  if (ids.length < minAds || ids.length > maxAds)
    throw new Refusal(`Choose ${minAds} to ${maxAds} ads (they take turns)`);
  const found = await c.query<{
    ad_id: string;
    brand_id: string;
    outcome: string;
    name: string;
    decision: string | null;
  }>(
    `SELECT a.ad_id, a.brand_id, a.outcome, a.name, r.decision
       FROM ads a LEFT JOIN ad_reviews r USING (ad_id) WHERE a.ad_id = ANY($1)`,
    [ids],
  );
  for (const id of ids) {
    const ad = found.rows.find((x) => x.ad_id === id);
    if (!ad || ad.brand_id !== brandId) throw new Refusal(`${id} is not one of this brand's ads`);
    if (ad.outcome === 'fail') throw new Refusal(`${ad.name} failed the automatic checks`);
    if (ad.decision === 'rejected') throw new Refusal(`${ad.name} was rejected in review`);
  }
  return ids;
}

/**
 * Sales adds a brand to the POC package (P7.8.1): its first month (one not started yet), how many
 * months (1 to the setting's most, usually all 3) and its 2 to 5 ads (each reviewed as usual: only
 * approved ones play). Each month is kept with its fee and GST as they are now. Refused when a month
 * already has the most brands. Returns the months' references.
 */
export async function addPocBrand(
  pool: Pool,
  b: {
    readonly brandId: string;
    readonly firstMonth: string;
    readonly months: number;
    readonly adIds: readonly string[];
    readonly reason: string;
  },
  by: string,
  now: number,
): Promise<string[]> {
  const rules = await pocRules(pool);
  if (!Number.isSafeInteger(b.months) || b.months < 1 || b.months > rules.pocMonths)
    throw new Refusal(`A commitment is 1 to ${rules.pocMonths} months`);
  if (!isMonth(b.firstMonth)) throw new Refusal('First month: like 2026-11');
  const why = b.reason.trim();
  if (why.length < 5 || why.length > 300) throw new Refusal('Why: 5 to 300 letters');
  if (pocMonthWindow(b.firstMonth).startsAt <= now)
    throw new Refusal(
      `${monthName(b.firstMonth)} has started: a brand joins from a month not started yet (${monthName(firstOpenMonth(now))} or later)`,
    );
  // The POC must be switched on (scheduled or running): every month of the commitment inside it,
  // up to its planned end (P7.8, Prateek 28 Oct 2026: brands are set up before it starts).
  const phase = await pocPhaseAt(pool, now);
  if (phase.phase !== 'scheduled' && phase.phase !== 'running')
    throw new Refusal(
      phase.phase === 'ended'
        ? 'The POC has ended: no new POC brands'
        : 'Switch the business to POC first (Settings): POC brands join a scheduled or running POC',
      { code: 'poc-off' },
    );
  const lastMonth = addMonths(b.firstMonth, b.months - 1);
  if (pocMonthWindow(b.firstMonth).startsAt < phase.startsAt)
    throw new Refusal(
      `The POC starts in ${monthName(calendarMonth(phase.startsAt))}: a brand's first month is that one or later`,
    );
  if (pocMonthWindow(lastMonth).startsAt >= phase.plannedEnd)
    throw new Refusal(
      `The POC is planned to end with ${monthName(calendarMonth(phase.plannedEnd - 86_400))}: ${b.months} months from ${monthName(b.firstMonth)} go past it`,
    );
  const account = await findAccount(pool, b.brandId);
  if (!account)
    throw new Refusal(`No brand ${b.brandId}: open its account on the Brands page first`);
  if (account.kind !== 'brand')
    throw new Refusal('An agency is not a POC brand: add each brand it books for');
  if (!account.active) throw new Refusal(`${account.name} is closed`);
  if (b.brandId === RECALL_OWN_ACCOUNT) throw new Refusal("RECALL's own ads fill RECALL's spots");
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  if (!book) throw new Refusal('No price book in force');
  const money = pocMonthMoney(rules.feePaise, book.gstBp);
  const months = Array.from({ length: b.months }, (_, i) => addMonths(b.firstMonth, i));
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('poc'))");
    const there = await c.query('SELECT 1 FROM poc_brands WHERE brand_id = $1', [b.brandId]);
    if (there.rowCount) throw new Refusal(`${account.name} is already on the POC package`);
    const ads = await checkAds(c, b.brandId, b.adIds);
    const full = await c.query<{ month: string; n: string }>(
      'SELECT month, count(*) AS n FROM poc_months WHERE month = ANY($1) GROUP BY month',
      [months],
    );
    for (const f of full.rows)
      if (Number(f.n) >= rules.maxBrands)
        throw new Refusal(
          `${rules.maxBrands} brands already have ${monthName(f.month)}: the POC is full that month`,
          { code: 'poc-full', n: rules.maxBrands },
        );
    await c.query(
      `INSERT INTO poc_brands (brand_id, first_month, months, added_by, reason, added_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
      [b.brandId, b.firstMonth, b.months, by, why, now],
    );
    for (const m of months)
      await c.query(
        `INSERT INTO poc_months (ref, brand_id, month, fee_paise, gst_bp, gst_paise, total_paise,
                                 created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
        [
          pocRef(b.brandId, m),
          b.brandId,
          m,
          money.fee,
          book.gstBp,
          money.gst,
          money.total,
          by,
          now,
        ],
      );
    await c.query(
      `INSERT INTO poc_ad_sets (brand_id, version, ad_ids, set_by, set_at)
       VALUES ($1, 1, $2, $3, to_timestamp($4))`,
      [b.brandId, ads, by, now],
    );
    return months.map((m) => pocRef(b.brandId, m));
  });
}

/** A new choice of a POC brand's ads (2 to 5 of its own). Returns the version. */
export async function setPocAds(
  pool: Pool,
  brandId: string,
  adIds: readonly string[],
  by: string,
  now: number,
): Promise<number> {
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('poc'))");
    const there = await c.query('SELECT 1 FROM poc_brands WHERE brand_id = $1', [brandId]);
    if (!there.rowCount) throw new Refusal(`${brandId} is not on the POC package`);
    const ads = await checkAds(c, brandId, adIds);
    const v = await c.query<{ n: number }>(
      'SELECT coalesce(max(version), 0) + 1 AS n FROM poc_ad_sets WHERE brand_id = $1',
      [brandId],
    );
    const version = v.rows[0]?.n ?? 1;
    await c.query(
      `INSERT INTO poc_ad_sets (brand_id, version, ad_ids, set_by, set_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [brandId, version, ads, by, now],
    );
    return version;
  });
}

/** A brand's ad choices, oldest first, and which of its ads are approved now. */
async function adChoices(c: Q, brandIds: readonly string[]) {
  const r = await c.query<{ brand_id: string; ad_ids: string[]; at: string }>(
    `SELECT brand_id, ad_ids, extract(epoch FROM set_at)::bigint AS at FROM poc_ad_sets
      WHERE brand_id = ANY($1) ORDER BY brand_id, version`,
    [brandIds],
  );
  const ok = await c.query<{ ad_id: string }>(
    `SELECT r.ad_id FROM ad_reviews r JOIN ads a USING (ad_id)
      WHERE r.decision = 'approved' AND a.outcome <> 'fail'
        AND a.ad_id IN (SELECT unnest(ad_ids) FROM poc_ad_sets WHERE brand_id = ANY($1))`,
    [brandIds],
  );
  const approved = new Set(ok.rows.map((x) => x.ad_id));
  const choices = new Map<string, { at: number; ads: string[] }[]>();
  for (const x of r.rows)
    choices.set(x.brand_id, [
      ...(choices.get(x.brand_id) ?? []),
      { at: Number(x.at), ads: x.ad_ids },
    ]);
  /**
   * The approved ads of the choice in force at `t` (the latest made by then). With `grace` (for
   * counting), also those of the choice before it for ADS_CHANGE_GRACE_SECONDS after a change:
   * screens get the new plan only with their next hello.
   */
  const at = (brandId: string, t: number, grace = false): string[] => {
    const list = choices.get(brandId) ?? [];
    let pick: string[] = [];
    let before: string[] = [];
    let since = 0;
    for (const ch of list)
      if (ch.at <= t) {
        before = pick;
        pick = ch.ads;
        since = ch.at;
      }
    const ads = grace && t < since + ADS_CHANGE_GRACE_SECONDS ? [...pick, ...before] : pick;
    return [...new Set(ads)].filter((a) => approved.has(a));
  };
  return { at, approved };
}

// ---------------------------------------------------------------- paying a month

interface MonthRow {
  readonly ref: string;
  readonly brand_id: string;
  readonly month: string;
  readonly fee_paise: string;
  readonly gst_paise: string;
  readonly total_paise: string;
}

/** Whether a POC month is paid (a payment recorded on one of its links). */
async function paidOf(c: Q, ref: string): Promise<{ at: number; paymentId: string } | undefined> {
  const r = await c.query<{ at: Date; payment_id: string }>(
    `SELECT e.at, e.payment_id FROM payment_link_events e JOIN payment_links l USING (link_id)
      WHERE l.poc_ref = $1 AND e.state = 'paid' ORDER BY e.id LIMIT 1`,
    [ref],
  );
  const x = r.rows[0];
  return x ? { at: secs(x.at), paymentId: x.payment_id } : undefined;
}

/** A month's links, newest first, with what happened to each. */
async function linksOf(c: Q, ref: string) {
  const r = await c.query<{
    link_id: string;
    url: string;
    expires_at: Date;
    amount_paise: string;
    states: string[];
  }>(
    `SELECT l.link_id, l.url, l.expires_at, l.amount_paise,
            coalesce(array_agg(e.state) FILTER (WHERE e.state IS NOT NULL), '{}') AS states
       FROM payment_links l LEFT JOIN payment_link_events e USING (link_id)
      WHERE l.poc_ref = $1
      GROUP BY l.link_id ORDER BY max(l.created_at) DESC, l.link_id`,
    [ref],
  );
  return r.rows;
}

const ended = (states: readonly string[]) =>
  states.some((x) => x === 'paid' || x === 'expired' || x === 'cancelled');

/**
 * A payment link for a POC month (P7.8.1), from staff or from the brand's portal. It works until
 * `payLinkHours` from now and never past the month's start: a month is paid before it starts or not
 * at all. Asking again while it works gives the same link.
 */
export async function sendPocForPayment(
  pool: Pool,
  payments: PaymentsAdapter,
  ref: string,
  by: string,
  now: number,
): Promise<SentLink> {
  const r = await pool.query<MonthRow>('SELECT * FROM poc_months WHERE ref = $1', [ref]);
  const m = r.rows[0];
  if (!m) throw new Refusal(`No POC month ${ref}`, { code: 'no-month' });
  if (await paidOf(pool, ref)) throw new Refusal('This month is paid', { code: 'paid' });
  if (!(await pocOnAt(pool, pocMonthWindow(m.month).startsAt)))
    throw new Refusal(`The POC is not on in ${monthName(m.month)}: nothing to pay`, {
      code: 'poc-off',
    });
  const total = Number(m.total_paise);
  const w = pocMonthWindow(m.month);
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  const expiresAt = Math.min(now + (book?.payLinkHours ?? 24) * 3600, w.startsAt);
  const live = (await linksOf(pool, ref)).find((l) => !ended(l.states) && secs(l.expires_at) > now);
  if (live)
    return {
      linkId: live.link_id,
      url: live.url,
      expiresAt: secs(live.expires_at),
      amountPaise: Number(live.amount_paise),
    };
  if (expiresAt - now < MIN_LINK_SECONDS)
    throw new Refusal(
      `${monthName(m.month)} has started (or starts in less than 15 minutes): a month is paid before it starts, so it cannot be paid now`,
      { code: 'too-late' },
    );
  const n = (await linksOf(pool, ref)).length;
  const contact = await pool.query<{ phone: string | null; email: string | null }>(
    'SELECT phone, email FROM brand_contacts WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1',
    [m.brand_id],
  );
  const c = contact.rows[0];
  const link = await payments.createLink({
    linkKey: `${ref}#${total}#${n + 1}`,
    bookingId: ref,
    amountPaise: total,
    description: `RECALL POC package, ${monthName(m.month)}`,
    ...(c?.phone ? { phone: c.phone } : {}),
    ...(c?.email ? { email: c.email } : {}),
    expiresAt,
  });
  const kept = await inTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO payment_links (link_id, poc_ref, amount_paise, url, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, to_timestamp($7)) ON CONFLICT (link_id) DO NOTHING`,
      [link.linkId, ref, total, link.url, expiresAt, by.slice(0, 120), now],
    );
    const k = await tx.query<{ poc_ref: string | null; amount_paise: string; expires_at: Date }>(
      'SELECT poc_ref, amount_paise, expires_at FROM payment_links WHERE link_id = $1',
      [link.linkId],
    );
    return k.rows[0];
  });
  // A link id already filed for something else must never be handed out.
  if (!kept || kept.poc_ref !== ref || Number(kept.amount_paise) !== total)
    throw new Error(`Payment provider gave link ${link.linkId}, already used for something else`);
  return {
    linkId: link.linkId,
    url: link.url,
    expiresAt: secs(kept.expires_at),
    amountPaise: total,
  };
}

/** Money that cannot be kept (a second payment, a wrong amount): its event and the entry, once. */
async function moneyBack(
  c: Q,
  l: { linkId: string; ref: string; brandId: string },
  state: 'paid-late' | 'wrong-amount',
  paid: { paymentId: string; amountPaise: number },
  why: string,
  at: number,
): Promise<'already' | 'recorded'> {
  const r = await c.query(
    `INSERT INTO payment_link_events (link_id, state, payment_id, amount_paise, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT DO NOTHING`,
    [l.linkId, state, paid.paymentId, paid.amountPaise, at],
  );
  if (r.rowCount === 0) return 'already';
  if (paid.amountPaise > 0)
    await postEntry(
      c,
      moneyToReturn({
        paymentId: paid.paymentId,
        ref: l.ref,
        brandId: l.brandId,
        amount: paid.amountPaise,
        why,
        at,
      }),
      'payments',
    );
  return 'recorded';
}

/**
 * What a POC month's link status says (from the provider's message or from asking it). Paid: the
 * month is paid, the money held for it, its GST owed and its tax invoice issued, in one step. A link
 * stops at the month's start, so a payment the provider took counts even when its message comes a
 * little later. A second payment, or a wrong amount, is owed back. Undefined: not a POC link.
 */
export async function applyPocLinkStatus(
  pool: Pool,
  linkId: string,
  status: LinkStatus,
  now: number,
): Promise<PaymentOutcome | undefined> {
  const r = await pool.query<{
    poc_ref: string;
    amount_paise: string;
    brand_id: string;
    expires_at: Date;
  }>(
    `SELECT l.poc_ref, l.amount_paise, m.brand_id, l.expires_at
       FROM payment_links l JOIN poc_months m ON m.ref = l.poc_ref WHERE l.link_id = $1`,
    [linkId],
  );
  const link = r.rows[0];
  if (!link) return undefined;
  const l = { linkId, ref: link.poc_ref, brandId: link.brand_id };
  if (status.state === 'created') return 'waiting';
  if (status.state !== 'paid') {
    await inTransaction(pool, (c) =>
      c.query(
        `INSERT INTO payment_link_events (link_id, state, at)
         VALUES ($1, $2, to_timestamp($3)) ON CONFLICT DO NOTHING`,
        [linkId, status.state, now],
      ),
    );
    return 'expired';
  }
  const paid = { paymentId: status.paymentId, amountPaise: status.amountPaise };
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`poc-pay:${l.ref}`]);
    const known = await c.query('SELECT 1 FROM payment_link_events WHERE payment_id = $1', [
      status.paymentId,
    ]);
    if (known.rowCount) return 'already';
    if (status.amountPaise !== Number(link.amount_paise)) {
      const out = await moneyBack(
        c,
        l,
        'wrong-amount',
        paid,
        `paid ${status.amountPaise} paise, link was for ${link.amount_paise}`,
        now,
      );
      return out === 'already' ? 'already' : 'wrong-amount';
    }
    if (await paidOf(c, l.ref)) {
      const out = await moneyBack(c, l, 'paid-late', paid, 'the POC month was already paid', now);
      return out === 'already' ? 'already' : 'paid-late';
    }
    const m = await c.query<MonthRow>('SELECT * FROM poc_months WHERE ref = $1', [l.ref]);
    const row = m.rows[0];
    if (!row) throw new Error(`No POC month ${l.ref}`);
    // A month is paid before it starts (links stop then): news of a payment may come a little
    // later, never days later; and a link we recorded as run out or stopped takes no money.
    // Our own "run out" record gives way to the provider's word that it took the money before the
    // link's end, while the news is still in time.
    const ended = await c.query(
      `SELECT 1 FROM payment_link_events WHERE link_id = $1 AND state IN ('expired', 'cancelled')`,
      [linkId],
    );
    const tookInTime = status.paidAt <= secs(link.expires_at);
    if (
      (ended.rowCount && !tookInTime) ||
      now > pocMonthWindow(row.month).startsAt + PAID_NEWS_GRACE_SECONDS
    ) {
      const out = await moneyBack(
        c,
        l,
        'paid-late',
        paid,
        ended.rowCount ? 'paid on a link that had run out' : 'paid after the POC month started',
        now,
      );
      return out === 'already' ? 'already' : 'paid-late';
    }
    await c.query(
      `INSERT INTO payment_link_events (link_id, state, payment_id, amount_paise, at)
       VALUES ($1, 'paid', $2, $3, to_timestamp($4))`,
      [linkId, status.paymentId, status.amountPaise, now],
    );
    const entry = pocMonthPaid({
      ref: l.ref,
      brandId: l.brandId,
      fee: Number(row.fee_paise),
      gst: Number(row.gst_paise),
      paymentId: status.paymentId,
      at: now,
    });
    await postEntry(c, entry, 'payments');
    await issueGstDocument(c, {
      kind: 'invoice',
      sourceEntry: entry.entryId,
      pocRef: l.ref,
      taxable: Number(row.fee_paise),
      gst: Number(row.gst_paise),
      at: now,
    });
    return 'paid';
  });
}

/** Asks the provider about a POC month's newest link (staff pressing "Check payment"). */
export async function checkPocPayment(
  pool: Pool,
  payments: PaymentsAdapter,
  ref: string,
  now: number,
): Promise<PaymentOutcome> {
  const l = (await linksOf(pool, ref))[0];
  if (!l) return 'unknown';
  let status: LinkStatus;
  try {
    status = await payments.status(l.link_id);
  } catch {
    throw new Refusal('The payment provider did not answer. Try again in a minute.');
  }
  return (await applyPocLinkStatus(pool, l.link_id, status, now)) ?? 'unknown';
}

/**
 * POC links that ran out unpaid (a short grace after their end): stopped at the provider, asked
 * once more (a payment may have just completed) and recorded. Nothing else changes: an unpaid month
 * simply never plays. One link failing never stops the others.
 */
export async function expirePocLinks(
  pool: Pool,
  payments: PaymentsAdapter,
  now: number,
  log: (line: string) => void = (l) => console.error(l),
): Promise<number> {
  const r = await pool.query<{ link_id: string; expires_at: Date }>(
    `SELECT l.link_id, l.expires_at FROM payment_links l
      WHERE l.poc_ref IS NOT NULL AND l.expires_at <= to_timestamp($1)
        AND NOT EXISTS (SELECT 1 FROM payment_link_events e WHERE e.link_id = l.link_id
                         AND e.state IN ('paid', 'expired', 'cancelled'))
      ORDER BY l.created_at LIMIT 500`,
    [now - EXPIRY_GRACE_SECONDS],
  );
  let n = 0;
  for (const x of r.rows) {
    try {
      await payments.cancelLink(x.link_id).catch(() => undefined);
      let s: LinkStatus;
      try {
        s = await payments.status(x.link_id);
      } catch (e) {
        // The provider cannot say: asked again on the next run (a payment may be behind it); only an
        // hour after the link's end is it taken as run out (as for bookings).
        if (secs(x.expires_at) + PROVIDER_SILENT_SECONDS > now) throw e;
        log(`payments: no answer for POC link ${x.link_id}; taking it as run out`);
        s = { state: 'expired' };
      }
      // Stopped by us because it ran out: recorded as run out, unless it was paid meanwhile. A
      // payment that could not be kept (wrong amount, a second one) does not end the link: it is
      // recorded as run out too, so it is never picked up again.
      const out = await applyPocLinkStatus(
        pool,
        x.link_id,
        s.state === 'paid' ? s : { state: 'expired' },
        now,
      );
      if (out !== 'paid' && out !== 'expired')
        await applyPocLinkStatus(pool, x.link_id, { state: 'expired' }, now);
      n += 1;
    } catch (e) {
      log(`payments: could not expire POC link ${x.link_id}: ${(e as Error).message}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------- earning a month as it runs

/**
 * Moves each business day of every paid POC month from held to revenue once the day has ended
 * (pocDayEarned), inside the caller's transaction (the hour close holds the earnings lock). Each day
 * once, ever (its entry id names the day). Returns the entries posted.
 */
export async function earnPocMonths(c: Q, now: number): Promise<number> {
  const r = await c.query<{
    ref: string;
    brand_id: string;
    month: string;
    fee_paise: string;
    done: string[];
  }>(
    `SELECT m.ref, m.brand_id, m.month, m.fee_paise,
            coalesce((SELECT array_agg(e.entry_id) FROM ledger_entries e
                       WHERE e.ref = m.ref AND e.kind = 'poc-earned'), '{}') AS done
       FROM poc_months m
      WHERE EXISTS (SELECT 1 FROM ledger_entries p WHERE p.ref = m.ref AND p.kind = 'poc-paid')
        AND m.month <= $1`,
    [calendarMonth(now)],
  );
  let posted = 0;
  const changes = await businessModes(c);
  for (const m of r.rows) {
    const done = new Set(m.done);
    for (const date of pocDaysOver(m.month, now)) {
      // Only a day the POC was on (it played): a day after the POC was ended early stays held, for
      // Prateek to decide (DECISIONS, 29 Oct 2026).
      const dayStart = pocMonthWindow(m.month).startsAt + 86_400 * (Number(date.slice(8)) - 1);
      if (modeAt(changes, dayStart) !== 'poc') continue;
      // Dated the day itself (23:59:59 India time): the month's revenue stays in its month.
      const dayEnd =
        pocMonthWindow(m.month).startsAt - 8 * 3600 - 1 + 86_400 * Number(date.slice(8));
      const e = pocDayEarned({
        ref: m.ref,
        brandId: m.brand_id,
        feePaise: Number(m.fee_paise),
        month: m.month,
        date,
        at: Math.min(dayEnd, now),
      });
      if (!e || done.has(e.entryId)) continue;
      if ((await postEntry(c, e, 'hour-close')) === 'posted') posted += 1;
    }
  }
  return posted;
}

// ---------------------------------------------------------------- the screens' plan

/** When the POC is on during a month's hours: [from, until), or undefined when never. */
function pocSpan(changes: readonly ModeChange[], w: { startsAt: number; endsAt: number }) {
  if (modeAt(changes, w.startsAt) !== 'poc') return undefined;
  const off = changes.find((c) => c.from > w.startsAt && c.from < w.endsAt && c.mode !== 'poc');
  return { startsAt: w.startsAt, endsAt: off ? off.from : w.endsAt };
}

/**
 * The plans the screens get on down/poc (P7.8.2): this month and next, for the months the POC is on,
 * each with the brands paid for it (in slot order, at most the setting's most) and their approved
 * ads, the POC zone (the rider pay zone setting) and RECALL's own ads.
 */
export async function pocPlans(c: Q, now: number): Promise<PocPlan[]> {
  const changes = await businessModes(c);
  const first = businessMonthAt(now) ?? calendarMonth(now);
  const rules = await pocRules(c);
  const zone = await setting(c, 'pocZone');
  const own = await c.query<{ ad_id: string }>(
    `SELECT a.ad_id FROM ads a JOIN ad_reviews r USING (ad_id)
      WHERE a.brand_id = $1 AND r.decision = 'approved' AND a.outcome <> 'fail'
      ORDER BY a.uploaded_at, a.ad_id LIMIT 100`,
    [RECALL_OWN_ACCOUNT],
  );
  const recallAds = own.rows.map((x) => x.ad_id);
  const out: PocPlan[] = [];
  for (const month of [first, nextMonth(first)]) {
    const span = pocSpan(changes, pocMonthWindow(month));
    if (!span) continue;
    // Every brand of the month keeps a fixed slot (reference order): one not paid yet (it may still
    // be paid in the grace after the 1st) or with no approved ads has no ads, and RECALL fills it,
    // so a brand paying late or losing its ads never moves the others mid-hour.
    const all = await c.query<{ ref: string; brand_id: string; paid: boolean }>(
      `SELECT m.ref, m.brand_id,
              EXISTS (SELECT 1 FROM payment_links l JOIN payment_link_events e USING (link_id)
                       WHERE l.poc_ref = m.ref AND e.state = 'paid') AS paid
         FROM poc_months m WHERE m.month = $1 ORDER BY m.ref`,
      [month],
    );
    const ads = await adChoices(
      c,
      all.rows.map((x) => x.brand_id),
    );
    out.push({
      month,
      ...span,
      zone,
      slots: Math.max(rules.maxBrands, all.rows.length),
      perBrand: playsPerBrand(rules),
      brands: all.rows.map((x) => ({
        ref: x.ref,
        ads: x.paid ? ads.at(x.brand_id, now).slice(0, 5) : [],
      })),
      recallAds,
    });
  }
  return out;
}

// ---------------------------------------------------------------- counting (P1.5)

/**
 * What judging POC plays needs, read once per upload: the switch, the zone, the plays a brand gets
 * an hour, and each month's facts (cached); and the count so far of each brand's plays per screen
 * per bike-hour (kept up to date as the upload's plays count).
 */
export function pocJudge(c: Q, screenId: string) {
  let shared:
    Promise<{ changes: ModeChange[]; zone: PocPlayContext['zone']; perBrand: number }> | undefined;
  const months = new Map<
    string,
    Promise<
      | {
          ref: string;
          brandId: string;
          paid: boolean;
          startsAt: number;
          endsAt: number;
          adsAt: (t: number) => string[];
        }
      | undefined
    >
  >();
  const hours = new Map<string, number>();
  const monthOf = (ref: string) => {
    let m = months.get(ref);
    if (!m) {
      m = (async () => {
        const r = parsePocRef(ref);
        if (!r) return undefined;
        const row = await c.query('SELECT 1 FROM poc_months WHERE ref = $1', [ref]);
        if (!row.rowCount) return undefined;
        const ads = await adChoices(c, [r.brandId]);
        return {
          ref,
          brandId: r.brandId,
          paid: (await paidOf(c, ref)) !== undefined,
          ...pocMonthWindow(r.month),
          adsAt: (t: number) => ads.at(r.brandId, t, true),
        };
      })();
      months.set(ref, m);
    }
    return m;
  };
  const key = (ref: string, t: number) => `${ref}|${indiaHourOf(t)}`;
  return {
    /** The context for one POC play (in the order the upload's plays are judged). */
    async context(ref: string, startAt: number): Promise<PocPlayContext> {
      shared ??= (async () => ({
        changes: await businessModes(c),
        zone: await setting(c, 'pocZone'),
        perBrand: playsPerBrand(await pocRules(c)),
      }))();
      const s = await shared;
      const m = await monthOf(ref);
      const k = key(ref, startAt);
      let counted = hours.get(k);
      if (counted === undefined) {
        const hour = indiaHourOf(startAt);
        const r = await c.query<{ n: string }>(
          `SELECT count(*) AS n ${FROM_PLAYS}
            WHERE p.screen_id = $1 AND p.line_id = $2 AND ${COUNTED}
              AND p.start_at >= to_timestamp($3) AND p.start_at < to_timestamp($4)`,
          [screenId, ref, hour, hour + 3600],
        );
        counted = Number(r.rows[0]?.n ?? 0);
        hours.set(k, counted);
      }
      return {
        on: modeAt(s.changes, startAt) === 'poc',
        month: m && {
          ref: m.ref,
          paid: m.paid,
          ads: m.adsAt(startAt),
          startsAt: m.startsAt,
          endsAt: m.endsAt,
        },
        zone: s.zone,
        countedThisHour: counted,
        perBrand: s.perBrand,
      };
    },
    /** A POC play just counted: the next one of its brand that hour on this screen sees it. */
    counted(ref: string, startAt: number): void {
      const k = key(ref, startAt);
      hours.set(k, (hours.get(k) ?? 0) + 1);
    },
  };
}

// ---------------------------------------------------------------- the staff and brand pages

export type PocMonthState = 'paid' | 'link-sent' | 'to-pay' | 'missed';

export interface PocMonthView {
  readonly month: string;
  readonly ref: string;
  readonly feePaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  /** Paid; a link out (to pay by its end); to pay (before `payBy`); missed (started unpaid). */
  readonly state: PocMonthState;
  /** It must be paid before this (UTC seconds): its first business hour. */
  readonly payBy: number;
  readonly paidAt: number | null;
  readonly link: { readonly url: string; readonly expiresAt: number } | null;
}

async function monthViews(c: Q, brandIds: readonly string[], now: number) {
  const r = await c.query<
    MonthRow & {
      paid_at: Date | null;
      link_url: string | null;
      link_ends: Date | null;
    }
  >(
    `SELECT m.*,
            (SELECT min(e.at) FROM payment_link_events e JOIN payment_links l USING (link_id)
              WHERE l.poc_ref = m.ref AND e.state = 'paid') AS paid_at,
            k.url AS link_url, k.expires_at AS link_ends
       FROM poc_months m
       LEFT JOIN LATERAL (
         SELECT l.url, l.expires_at FROM payment_links l
          WHERE l.poc_ref = m.ref AND l.expires_at > to_timestamp($2)
            AND NOT EXISTS (SELECT 1 FROM payment_link_events e WHERE e.link_id = l.link_id
                             AND e.state IN ('paid', 'expired', 'cancelled'))
          ORDER BY l.created_at DESC LIMIT 1) k ON true
      WHERE m.brand_id = ANY($1) ORDER BY m.brand_id, m.month`,
    [brandIds, now],
  );
  const out = new Map<string, PocMonthView[]>();
  for (const x of r.rows) {
    const payBy = pocMonthWindow(x.month).startsAt;
    const state: PocMonthState = x.paid_at
      ? 'paid'
      : payBy <= now
        ? 'missed'
        : x.link_url
          ? 'link-sent'
          : 'to-pay';
    out.set(x.brand_id, [
      ...(out.get(x.brand_id) ?? []),
      {
        month: x.month,
        ref: x.ref,
        feePaise: Number(x.fee_paise),
        gstPaise: Number(x.gst_paise),
        totalPaise: Number(x.total_paise),
        state,
        payBy,
        paidAt: x.paid_at ? secs(x.paid_at) : null,
        link:
          state === 'link-sent' && x.link_url && x.link_ends
            ? { url: x.link_url, expiresAt: secs(x.link_ends) }
            : null,
      },
    ]);
  }
  return out;
}

/** Counted plays of these POC months from `from` to `to`, by month reference. */
async function playsByRef(c: Q, refs: readonly string[], from: number, to: number) {
  if (refs.length === 0) return new Map<string, number>();
  const r = await c.query<{ line_id: string; n: string }>(
    `SELECT p.line_id, count(*) AS n ${FROM_PLAYS}
      WHERE p.line_id = ANY($1) AND ${COUNTED}
        AND p.start_at >= to_timestamp($2) AND p.start_at < to_timestamp($3)
      GROUP BY p.line_id`,
    [refs, from, to],
  );
  return new Map(r.rows.map((x) => [x.line_id, Number(x.n)]));
}

export interface PocDeskBrand {
  readonly brandId: string;
  readonly name: string;
  readonly firstMonth: string;
  readonly months: readonly PocMonthView[];
  readonly ads: readonly { adId: string; name: string; approved: boolean }[];
  readonly addedBy: string;
  readonly addedAt: number;
  /** Counted plays of its month now: so far this month, and today (business day). */
  readonly playsMonth: number;
  readonly playsToday: number;
}

export interface PocDesk {
  readonly at: number;
  /** The switch: on now, and from when it counts (the first POC month). */
  readonly on: boolean;
  readonly since: number | null;
  readonly rules: PocRules;
  readonly perBrand: number;
  /** The business month now, and the first a new brand can join from. */
  readonly month: string;
  readonly openFrom: string;
  readonly brands: readonly PocDeskBrand[];
  readonly bikes: { readonly fitted: number; readonly max: number };
}

/** The staff POC page (P7.8.3): every POC brand side by side, its months, its plays, the bikes. */
export async function pocDesk(c: Q, now: number): Promise<PocDesk> {
  const rules = await pocRules(c);
  const changes = await businessModes(c);
  const first = changes.find((x) => x.mode === 'poc');
  // Scheduled: the POC's first month (the one being set up); else the business month now.
  const month =
    first && first.from > now
      ? calendarMonth(first.from)
      : (businessMonthAt(now) ?? calendarMonth(now));
  const b = await c.query<{
    brand_id: string;
    first_month: string;
    added_by: string;
    added_at: Date;
    name: string | null;
  }>(
    `SELECT p.brand_id, p.first_month, p.added_by, p.added_at,
            (SELECT v.name FROM brand_versions v WHERE v.brand_id = p.brand_id
              ORDER BY v.version DESC LIMIT 1) AS name
       FROM poc_brands p ORDER BY name, p.brand_id`,
  );
  const ids = b.rows.map((x) => x.brand_id);
  const months = await monthViews(c, ids, now);
  const latest = await c.query<{
    brand_id: string;
    ad_id: string;
    name: string;
    approved: boolean;
  }>(
    `SELECT s.brand_id, a.ad_id, a.name, coalesce(r.decision = 'approved', false) AS approved
       FROM (SELECT DISTINCT ON (brand_id) brand_id, ad_ids FROM poc_ad_sets
              WHERE brand_id = ANY($1) ORDER BY brand_id, version DESC) s
       CROSS JOIN LATERAL unnest(s.ad_ids) WITH ORDINALITY AS x(ad_id, k)
       JOIN ads a ON a.ad_id = x.ad_id
       LEFT JOIN ad_reviews r ON r.ad_id = a.ad_id
      ORDER BY s.brand_id, x.k`,
    [ids],
  );
  const w = pocMonthWindow(month);
  const refs = ids.map((id) => pocRef(id, month));
  const dayStart = (() => {
    const day = new Date((now + 19_800 - 2 * 3600) * 1000).toISOString().slice(0, 10);
    return Date.parse(`${day}T02:30:00Z`) / 1000;
  })();
  const [inMonth, today] = await Promise.all([
    playsByRef(c, refs, w.startsAt, w.endsAt),
    playsByRef(c, refs, dayStart, dayStart + 18 * 3600),
  ]);
  return {
    at: now,
    on: modeAt(changes, now) === 'poc',
    since: first?.from ?? null,
    rules,
    perBrand: playsPerBrand(rules),
    month,
    openFrom: firstOpenMonth(now),
    brands: b.rows.map((x) => ({
      brandId: x.brand_id,
      name: x.name ?? x.brand_id,
      firstMonth: x.first_month,
      months: months.get(x.brand_id) ?? [],
      ads: latest.rows
        .filter((a) => a.brand_id === x.brand_id)
        .map((a) => ({ adId: a.ad_id, name: a.name, approved: a.approved })),
      addedBy: x.added_by,
      addedAt: secs(x.added_at),
      playsMonth: inMonth.get(pocRef(x.brand_id, month)) ?? 0,
      playsToday: today.get(pocRef(x.brand_id, month)) ?? 0,
    })),
    bikes: { fitted: await bikesFitted(c, now), max: rules.maxBikes },
  };
}

/** Whether a brand is on the POC package. */
export async function isPocBrand(c: Q, brandId: string): Promise<boolean> {
  return (
    ((await c.query('SELECT 1 FROM poc_brands WHERE brand_id = $1', [brandId])).rowCount ?? 0) > 0
  );
}

/** The brands on the POC package (for the portal's menu). */
export async function pocBrandIds(c: Q): Promise<Set<string>> {
  const r = await c.query<{ brand_id: string }>('SELECT brand_id FROM poc_brands');
  return new Set(r.rows.map((x) => x.brand_id));
}

export interface BrandPocPage {
  readonly at: number;
  readonly on: boolean;
  readonly months: readonly PocMonthView[];
  readonly ads: readonly { adId: string; name: string; approved: boolean }[];
  readonly perBrand: number;
}

/** A POC brand's own page on the portal (P7.8.3): its months (paid, to pay, missed) and its ads. */
export async function brandPocPage(
  c: Q,
  brandId: string,
  now: number,
): Promise<BrandPocPage | undefined> {
  if (!(await isPocBrand(c, brandId))) return undefined;
  const desk = await pocDeskFor(c, brandId, now);
  return desk;
}

async function pocDeskFor(c: Q, brandId: string, now: number): Promise<BrandPocPage> {
  const months = await monthViews(c, [brandId], now);
  const a = await c.query<{ ad_id: string; name: string; approved: boolean }>(
    `SELECT a.ad_id, a.name, coalesce(r.decision = 'approved', false) AS approved
       FROM (SELECT ad_ids FROM poc_ad_sets WHERE brand_id = $1 ORDER BY version DESC LIMIT 1) s
       CROSS JOIN LATERAL unnest(s.ad_ids) WITH ORDINALITY AS x(ad_id, k)
       JOIN ads a ON a.ad_id = x.ad_id LEFT JOIN ad_reviews r ON r.ad_id = a.ad_id
      ORDER BY x.k`,
    [brandId],
  );
  return {
    at: now,
    on: await pocOnAt(c, now),
    months: months.get(brandId) ?? [],
    ads: a.rows.map((x) => ({ adId: x.ad_id, name: x.name, approved: x.approved })),
    perBrand: playsPerBrand(await pocRules(c)),
  };
}

// ---------------------------------------------------------------- paying from the portal

/**
 * The brand agrees to the POC package's plain rules and pays a month (P7.8, as P5.6): refused when
 * the rules changed since it read them; the agreement is kept once the link is made (once per month
 * and rules version, with who and from where).
 */
export async function payPocFromPortal(
  pool: Pool,
  payments: PaymentsAdapter,
  p: {
    readonly brandId: string;
    readonly month: string;
    readonly by: string;
    readonly ip: string;
    readonly termsVersion: number;
  },
  now: number,
): Promise<SentLink> {
  if (p.termsVersion !== POC_TERMS_VERSION)
    throw new Refusal('The rules have changed: read them again and tick the box', {
      code: 'terms-changed',
    });
  if (!isMonth(p.month)) throw new Refusal('No such POC month', { code: 'no-month' });
  const ref = pocRef(p.brandId, p.month);
  const link = await sendPocForPayment(pool, payments, ref, p.by, now);
  await pool.query(
    `INSERT INTO poc_terms (ref, terms_version, accepted_by, ip, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT (ref, terms_version) DO NOTHING`,
    [ref, p.termsVersion, p.by.slice(0, 254), p.ip.slice(0, 64), now],
  );
  return link;
}

// ---------------------------------------------------------------- a cancelled POC

/**
 * After a scheduled POC is cancelled (cancelScheduledPoc): every paid POC month the POC is no longer
 * on for never ran, so its fee and GST are owed back with a credit note, once (Prateek, 29 Oct
 * 2026). Safe to run again. Returns the months owed back.
 */
export async function owePocMonthsBack(pool: Pool, now: number): Promise<string[]> {
  const changes = await businessModes(pool);
  // Only for a POC that never ran: after one ended early, unplayed days stay held for a super
  // admin to decide (DECISIONS, 29 Oct 2026).
  if (pocEndedAt(changes) !== undefined) return [];
  const r = await pool.query<MonthRow>(
    `SELECT m.* FROM poc_months m
      WHERE EXISTS (SELECT 1 FROM ledger_entries e WHERE e.ref = m.ref AND e.kind = 'poc-paid')
        AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.ref = m.ref
                         AND e.kind IN ('poc-cancelled', 'poc-earned'))
      ORDER BY m.ref`,
  );
  const out: string[] = [];
  for (const m of r.rows) {
    if (modeAt(changes, pocMonthWindow(m.month).startsAt) === 'poc') continue;
    await inTransaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`poc-pay:${m.ref}`]);
      const entry = pocMonthCancelled({
        ref: m.ref,
        brandId: m.brand_id,
        fee: Number(m.fee_paise),
        gst: Number(m.gst_paise),
        at: now,
      });
      if ((await postEntry(c, entry, 'poc-cancelled')) === 'already') return;
      await issueGstDocument(c, {
        kind: 'credit-note',
        sourceEntry: entry.entryId,
        pocRef: m.ref,
        taxable: Number(m.fee_paise),
        gst: Number(m.gst_paise),
        at: now,
      });
      out.push(m.ref);
    });
  }
  return out;
}
