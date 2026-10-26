// P3.11.3 in the database: fitting slots and bookings (an approved rider into a slot with room, one
// at a time), a rider's earnings and payouts as staff see them, and what stands open if he leaves.
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { payoutAccountOf } from './rider-checks.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const text = (x: string, what: string, min: number, max: number) => {
  const t = x.trim();
  if (t.length < min || t.length > max || CONTROL.test(t))
    throw new Refusal(`${what}: ${min} to ${max} letters`);
  return t;
};

export interface FittingSlot {
  readonly slotId: string;
  readonly centre: string;
  readonly startsAt: number;
  readonly minutes: number;
  readonly bikes: number;
  /** Riders booked into it now. */
  readonly booked: readonly string[];
}

/** One lock for slots and bookings: two bookings can never take the last place twice. */
const lockSlots = (c: PoolClient) =>
  c.query("SELECT pg_advisory_xact_lock(hashtext('fitting-slots'))");

/** Opens a fitting slot (in the future: a centre, a start, how long, how many bikes). */
export async function openFittingSlot(
  pool: Pool,
  s: {
    readonly centre: string;
    readonly startsAt: number;
    readonly minutes: number;
    readonly bikes: number;
    readonly by: string;
  },
  now: number,
): Promise<string> {
  const centre = text(s.centre, 'Fitting centre', 2, 80);
  if (!Number.isSafeInteger(s.startsAt) || s.startsAt <= now)
    throw new Refusal('A slot starts in the future');
  if (s.startsAt > now + 90 * 86_400) throw new Refusal('A slot is at most 90 days ahead');
  if (!Number.isInteger(s.minutes) || s.minutes < 15 || s.minutes > 480)
    throw new Refusal('A slot lasts 15 minutes to 8 hours');
  if (!Number.isInteger(s.bikes) || s.bikes < 1 || s.bikes > 100)
    throw new Refusal('A slot takes 1 to 100 bikes');
  const slotId = `SLOT-${randomBytes(4).toString('hex').toUpperCase()}`;
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO fitting_slots (slot_id, centre, starts_at, minutes, bikes, created_by, created_at)
       VALUES ($1, $2, to_timestamp($3), $4, $5, $6, to_timestamp($7))`,
      [slotId, centre, s.startsAt, s.minutes, s.bikes, s.by, now],
    ),
  );
  return slotId;
}

/** Each rider's live booking (his latest event is a booking), as rider → slot. */
const LIVE = `
  SELECT rider_id, slot_id FROM (
    SELECT DISTINCT ON (rider_id) rider_id, slot_id, event FROM fitting_bookings
     ORDER BY rider_id, seq DESC) b
   WHERE b.event = 'booked'`;

/** Slots from `from` on (and those running), soonest first, with who is booked. */
export async function fittingSlots(pool: Q, from: number): Promise<FittingSlot[]> {
  const r = await pool.query<{
    slot_id: string;
    centre: string;
    starts_at: Date;
    minutes: number;
    bikes: number;
    booked: string[] | null;
  }>(
    `SELECT s.slot_id, s.centre, s.starts_at, s.minutes, s.bikes,
            (SELECT array_agg(l.rider_id ORDER BY l.rider_id) FROM (${LIVE}) l
              WHERE l.slot_id = s.slot_id) AS booked
       FROM fitting_slots s
      WHERE s.starts_at + make_interval(mins => s.minutes) > to_timestamp($1)
      ORDER BY s.starts_at, s.centre LIMIT 200`,
    [from],
  );
  return r.rows.map((x) => ({
    slotId: x.slot_id,
    centre: x.centre,
    startsAt: secs(x.starts_at),
    minutes: x.minutes,
    bikes: x.bikes,
    booked: x.booked ?? [],
  }));
}

const addEvent = (
  c: PoolClient,
  riderId: string,
  slotId: string,
  event: 'booked' | 'cancelled',
  reason: string,
  by: string,
  now: number,
) =>
  c.query(
    `INSERT INTO fitting_bookings (rider_id, seq, slot_id, event, reason, by_who, at)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, to_timestamp($6)
       FROM fitting_bookings WHERE rider_id = $1`,
    [riderId, slotId, event, reason, by, now],
  );

/** His live booking now, if any. */
async function liveBooking(c: Q, riderId: string): Promise<string | null> {
  const r = await c.query<{ slot_id: string }>(
    `SELECT slot_id FROM (${LIVE}) l WHERE l.rider_id = $1`,
    [riderId],
  );
  return r.rows[0]?.slot_id ?? null;
}

/**
 * Books an approved rider (no screen on his bike yet) into a slot that has not started and has
 * room. A booking he already has is moved (the old one cancelled, with why).
 */
export async function bookFitting(
  pool: Pool,
  riderId: string,
  slotId: string,
  by: string,
  now: number,
): Promise<void> {
  await inTransaction(pool, async (c) => {
    await lockSlots(c);
    const r = await c.query<{ status: string | null }>(
      'SELECT status FROM rider_steps WHERE rider_id = $1 ORDER BY seq DESC LIMIT 1',
      [riderId],
    );
    const status = r.rows[0]?.status;
    if (!status) throw new Refusal(`No rider ${riderId}`);
    if (status !== 'approved')
      throw new Refusal(
        `${riderId} is ${status}: only an approved rider without a screen books one`,
      );
    const s = await c.query<{ starts_at: Date; bikes: number; centre: string }>(
      'SELECT starts_at, bikes, centre FROM fitting_slots WHERE slot_id = $1',
      [slotId],
    );
    const slot = s.rows[0];
    if (!slot) throw new Refusal(`No slot ${slotId}`);
    if (secs(slot.starts_at) <= now) throw new Refusal('This slot has started: choose a later one');
    const before = await liveBooking(c, riderId);
    if (before === slotId) return;
    const n = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (${LIVE}) l WHERE l.slot_id = $1`,
      [slotId],
    );
    if ((n.rows[0]?.n ?? 0) >= slot.bikes) throw new Refusal(`This slot at ${slot.centre} is full`);
    if (before) await addEvent(c, riderId, before, 'cancelled', 'moved to another slot', by, now);
    await addEvent(c, riderId, slotId, 'booked', 'booked', by, now);
  });
}

/** Cancels his live booking, with why. */
export async function cancelFitting(
  pool: Pool,
  riderId: string,
  reason: string,
  by: string,
  now: number,
): Promise<void> {
  const why = text(reason, 'Say why', 3, 300);
  await inTransaction(pool, async (c) => {
    await lockSlots(c);
    const slot = await liveBooking(c, riderId);
    if (!slot) throw new Refusal('He has no fitting booked');
    await addEvent(c, riderId, slot, 'cancelled', why, by, now);
  });
}

export interface RiderMoney {
  /** What he is owed now (rider pay brought in, less what was paid or is being paid). */
  readonly owedPaise: number;
  /** His payouts, newest first: the run, the amount and how it went. */
  readonly payouts: readonly {
    runId: string;
    amountPaise: number;
    status: string;
    reason: string | null;
  }[];
}

/** His earnings and payouts as staff see them. */
export async function riderMoney(pool: Q, riderId: string): Promise<RiderMoney> {
  const [owed, payouts] = await Promise.all([
    pool.query<{ owed: string | null }>(
      `SELECT sum(credit - debit) AS owed FROM ledger_postings
        WHERE account = 'rider-payable' AND party = $1`,
      [riderId],
    ),
    pool.query<{
      run_id: string;
      amount_paise: string;
      status: string | null;
      reason: string | null;
    }>(
      `SELECT l.run_id::text AS run_id, l.amount_paise, a.status, a.reason
         FROM payout_lines l
         LEFT JOIN LATERAL (SELECT status, reason FROM payout_attempts x
                             WHERE x.run_id = l.run_id AND x.rider_id = l.rider_id
                             ORDER BY attempt DESC LIMIT 1) a ON true
        WHERE l.rider_id = $1 ORDER BY l.run_id DESC LIMIT 12`,
      [riderId],
    ),
  ]);
  return {
    owedPaise: Number(owed.rows[0]?.owed ?? 0),
    payouts: payouts.rows.map((p) => ({
      runId: p.run_id,
      amountPaise: Number(p.amount_paise),
      status: p.status ?? 'waiting',
      reason: p.reason,
    })),
  };
}

export interface RiderFitting {
  /** His live booking, with its slot. */
  readonly booking: FittingSlot | null;
}

/** His live fitting booking, if any. */
export async function riderFitting(pool: Q, riderId: string, now: number): Promise<RiderFitting> {
  const slotId = await liveBooking(pool, riderId);
  if (!slotId) return { booking: null };
  const all = await fittingSlots(pool, now - 90 * 86_400);
  return { booking: all.find((s) => s.slotId === slotId) ?? null };
}

/** What stands open if he leaves: each item, and whether it is settled. */
export async function leavingChecklist(
  pool: Q,
  riderId: string,
  screenId: string | null,
): Promise<{ item: string; done: boolean; detail: string }[]> {
  const [money, account, loans] = await Promise.all([
    riderMoney(pool, riderId),
    payoutAccountOf(pool, riderId),
    pool.query<{ loan_id: string; bank: string; status: string | null }>(
      `SELECT l.loan_id, l.bank,
              (SELECT status FROM screen_loan_events e WHERE e.loan_id = l.loan_id
                ORDER BY seq DESC LIMIT 1) AS status
         FROM screen_loans l WHERE l.rider_id = $1`,
      [riderId],
    ),
  ]);
  const open = loans.rows.filter((l) => l.status === 'disbursed' || l.status === 'defaulted');
  const rupees = (p: number) =>
    `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  return [
    {
      item: 'Screen returned',
      done: screenId === null,
      detail: screenId
        ? `${screenId} is still on his bike: take it off (Screens)`
        : 'no screen on his bike',
    },
    {
      item: 'Final pay',
      done: money.owedPaise <= 0 || account !== null,
      detail:
        money.owedPaise <= 0
          ? 'nothing owed'
          : account
            ? `${rupees(money.owedPaise)} owed: paid in the next Monday run to ${account.shown}`
            : `${rupees(money.owedPaise)} owed but no checked account: check his bank first`,
    },
    {
      item: 'Screen loan',
      done: open.length === 0,
      detail: open.length
        ? `open with ${open.map((l) => l.bank).join(', ')}: tell the bank he is leaving`
        : 'none open',
    },
  ];
}
