// P4.3: fitting on the rider app. An approved rider books a slot at a fitting centre that is on;
// at his slot the technician, on the rider's phone, scans the screen's QR (screen, bike and rider
// linked: the same rules as staff, P2.1) and starts the fitting check (P2.14). The box shows its test
// pattern and checks GPS, the 4G line, the camera and the battery; the technician says whether every
// part of the panel lit up. The bike is ready when all of it passed. Staff then switch him on.
//
// A screen's QR is only its id, which anyone may see printed on the box: so the app fits a screen
// only around his own booked slot (and staff see every fitting, and take a wrong one off).
import {
  isScreenId,
  screenIdFromQr,
  screenQr,
  type FittingVerdict,
  type PartResult,
  type RiderSignInRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { issueCommand } from './commands.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { RIDER_APP } from './rider-app.js';
import { bookFitting, cancelFitting, fittingSlots } from './rider-fitting.js';
import { fitScreen } from './screens.js';
import { setting } from './settings.js';

type Q = Pick<Pool, 'query'>;

/** How long the box runs its check (seconds) and how long the command may wait for it. */
export const APP_CHECK_SECONDS = 120;
const CHECK_LIFE_MS = 10 * 60_000;

export interface AppSlot {
  readonly slotId: string;
  readonly centre: string;
  readonly address: string;
  readonly startsAt: number;
  readonly minutes: number;
  /** Places left (who else is booked is never shown). */
  readonly left: number;
}

/** One part of the check as the rider sees it: still waiting on the box, or its result. */
export type AppPart = PartResult | 'waiting';

export interface AppFittingCheck {
  readonly commandId: string;
  readonly startedAt: number;
  /** The box's answer is no longer expected after this (the command ran out). */
  readonly until: number;
  readonly gps: AppPart;
  readonly line: AppPart;
  readonly camera: AppPart;
  readonly battery: AppPart;
  /** The technician's answer: every part of the panel lit up (waiting: not answered yet). */
  readonly panel: AppPart;
  readonly ready: boolean;
}

export interface AppFittingPage {
  readonly status: string;
  readonly bikePlate: string | null;
  readonly booking: (AppSlot & { readonly canFitNow: boolean }) | null;
  /** Slots he can book (only while he has no screen). */
  readonly slots: readonly AppSlot[];
  readonly screenId: string | null;
  /** The latest fitting check of his screen (the latest counts). */
  readonly check: AppFittingCheck | null;
}

const centresOn = async (pool: Q) =>
  new Map(
    (await setting(pool, 'fittingCentres')).filter((c) => c.on).map((c) => [c.name, c.address]),
  );

/** The screen on his bike now, if any. */
export async function screenOfRider(pool: Q, riderId: string, now: number) {
  const r = await pool.query<{ screen_id: string }>(
    `SELECT screen_id FROM (
       SELECT DISTINCT ON (screen_id) screen_id, rider_id FROM screen_fittings
        WHERE from_at <= to_timestamp($2) ORDER BY screen_id, from_at DESC) x
      WHERE rider_id = $1 LIMIT 1`,
    [riderId, now],
  );
  return r.rows[0]?.screen_id ?? null;
}

const facts = async (pool: Q, riderId: string) => {
  const r = await pool.query<{ status: string | null; bike_plate: string | null }>(
    `SELECT (SELECT status FROM rider_steps WHERE rider_id = $1 ORDER BY seq DESC LIMIT 1) AS status,
            (SELECT bike_plate FROM rider_versions WHERE rider_id = $1
              ORDER BY version DESC LIMIT 1) AS bike_plate`,
    [riderId],
  );
  const f = r.rows[0];
  if (!f?.status) throw new Refusal(`No rider ${riderId}`);
  return { status: f.status, bikePlate: f.bike_plate };
};

/** When the app may fit his screen: around his booked slot only. */
const fitWindow = (b: { startsAt: number; minutes: number }, rules: RiderSignInRules) => ({
  from: b.startsAt - rules.fitEarlyMinutes * 60,
  to: b.startsAt + b.minutes * 60 + rules.fitLateMinutes * 60,
});

/** His live booking with its slot (a booking a year back is still his until cancelled). */
async function bookingOf(pool: Q, riderId: string, now: number) {
  const r = await pool.query<{ slot_id: string }>(
    `SELECT slot_id FROM (SELECT DISTINCT ON (rider_id) rider_id, slot_id, event FROM fitting_bookings
                           WHERE rider_id = $1 ORDER BY rider_id, seq DESC) b
      WHERE b.event = 'booked'`,
    [riderId],
  );
  const slotId = r.rows[0]?.slot_id;
  if (!slotId) return null;
  const all = await fittingSlots(pool, now - 90 * 86_400);
  return all.find((s) => s.slotId === slotId) ?? null;
}

/** The fitting page: his booking, the slots he can book, his screen and its latest check. */
export async function appFittingPage(
  pool: Q,
  riderId: string,
  now: number,
  rules: RiderSignInRules,
): Promise<AppFittingPage> {
  const f = await facts(pool, riderId);
  const [centres, screenId, b] = await Promise.all([
    centresOn(pool),
    screenOfRider(pool, riderId, now),
    bookingOf(pool, riderId, now),
  ]);
  const shown = (s: {
    slotId: string;
    centre: string;
    startsAt: number;
    minutes: number;
    bikes: number;
    booked: readonly string[];
  }): AppSlot => ({
    slotId: s.slotId,
    centre: s.centre,
    address: centres.get(s.centre) ?? '',
    startsAt: s.startsAt,
    minutes: s.minutes,
    left: Math.max(0, s.bikes - s.booked.length),
  });
  const w = b ? fitWindow(b, rules) : null;
  const slots =
    f.status === 'approved' && !screenId
      ? (await fittingSlots(pool, now))
          .filter((s) => s.startsAt > now && centres.has(s.centre))
          .map(shown)
          .filter((s) => s.left > 0 || s.slotId === b?.slotId)
          .slice(0, 50)
      : [];
  return {
    status: f.status,
    bikePlate: f.bikePlate,
    booking: b && w ? { ...shown(b), canFitNow: !screenId && now >= w.from && now <= w.to } : null,
    slots,
    screenId,
    check: screenId ? await latestAppCheck(pool, screenId, now) : null,
  };
}

/** The latest fitting check of a screen: the box's parts, the technician's answer, ready or not. */
export async function latestAppCheck(
  pool: Q,
  screenId: string,
  now: number,
): Promise<AppFittingCheck | null> {
  const r = await pool.query<{
    id: string;
    made: string;
    until_s: string;
    verdict: FittingVerdict | null;
    seen: boolean | null;
  }>(
    `SELECT c.id, extract(epoch FROM c.made_at)::bigint AS made,
            extract(epoch FROM c.until)::bigint AS until_s,
            (SELECT verdict FROM fitting_checks k WHERE k.screen_id = c.screen_id AND k.command_id = c.id
              ORDER BY k.at DESC, k.seq DESC LIMIT 1) AS verdict,
            (SELECT seen FROM fitting_panel_answers a WHERE a.command_id = c.id) AS seen
       FROM screen_commands c
      WHERE c.screen_id = $1 AND c.command = 'fitting-check' AND c.made_at <= to_timestamp($2)
      ORDER BY c.made_at DESC LIMIT 1`,
    [screenId, now],
  );
  const x = r.rows[0];
  if (!x) return null;
  const v = x.verdict;
  // No answer from the box in time: its parts are unknown (never ready on a guess).
  const late = !v && now > Number(x.until_s);
  const part = (p: PartResult | undefined): AppPart => p ?? (late ? 'unknown' : 'waiting');
  const panel: AppPart = x.seen === null ? 'waiting' : x.seen ? 'ok' : 'fail';
  return {
    commandId: x.id,
    startedAt: Number(x.made),
    until: Number(x.until_s),
    gps: part(v?.gps),
    line: part(v?.line),
    camera: part(v?.camera),
    battery: part(v?.battery),
    panel,
    ready: v?.ready === true && x.seen === true,
  };
}

/** He books a slot (or moves his booking) at a centre that is on, while he has no screen. */
export async function bookFromApp(
  pool: Pool,
  riderId: string,
  slotId: string,
  now: number,
): Promise<void> {
  if (await screenOfRider(pool, riderId, now))
    throw new Refusal('Your screen is fitted already', { code: 'fitted' });
  const slot = (await fittingSlots(pool, now)).find((s) => s.slotId === slotId);
  if (!slot || !(await centresOn(pool)).has(slot.centre))
    throw new Refusal('This slot is not open: choose another', { code: 'slot-gone' });
  try {
    await bookFitting(pool, riderId, slotId, RIDER_APP, now);
  } catch (e) {
    if (e instanceof Refusal && / is full$/.test(e.message))
      throw new Refusal(e.message, { code: 'slot-full' });
    if (e instanceof Refusal && /has started/.test(e.message))
      throw new Refusal(e.message, { code: 'slot-gone' });
    throw e;
  }
}

/** He cancels his booking (a slot he cannot make). */
export async function cancelFromApp(pool: Pool, riderId: string, now: number): Promise<void> {
  await cancelFitting(pool, riderId, 'cancelled on the rider app', RIDER_APP, now);
}

/**
 * The technician scans the screen's QR (or types the id printed under it) at his slot: the screen
 * is fitted to his bike (his record's plate) and to him, by the same rules staff use.
 */
export async function fitFromApp(
  pool: Pool,
  riderId: string,
  scanned: string,
  now: number,
  rules: RiderSignInRules,
): Promise<string> {
  const typed = scanned.trim().toUpperCase();
  const qr = isScreenId(typed) ? screenQr(typed) : scanned.trim();
  if (!screenIdFromQr(qr))
    throw new Refusal('This is not a RECALL screen code', { code: 'not-a-screen' });
  const f = await facts(pool, riderId);
  if (f.status !== 'approved')
    throw new Refusal('Only an approved rider gets a screen', { code: 'not-approved' });
  const b = await bookingOf(pool, riderId, now);
  if (!b) throw new Refusal('Book a fitting slot first', { code: 'no-booking' });
  const w = fitWindow(b, rules);
  if (now < w.from || now > w.to)
    throw new Refusal('Fit your screen at your fitting slot', { code: 'not-your-slot' });
  if (!f.bikePlate) throw new Refusal('Your number plate is missing: call support');
  try {
    const fitted = await fitScreen(pool, { qr, plate: f.bikePlate, riderId }, RIDER_APP, now);
    return fitted.screenId;
  } catch (e) {
    // Why this screen cannot go on (on another bike, in repair, …): the technician reads it.
    if (e instanceof Refusal) throw new Refusal(e.message, { code: 'cannot-fit' });
    throw e;
  }
}

/**
 * Starts the fitting check on his screen: the box shows its test pattern for two minutes and checks
 * itself. A check still running is returned, never started twice; a few a day.
 */
export async function startFittingFromApp(
  pool: Pool,
  riderId: string,
  now: number,
  rules: RiderSignInRules,
): Promise<{ readonly commandId: string }> {
  const screenId = await screenOfRider(pool, riderId, now);
  if (!screenId) throw new Refusal('Fit your screen first', { code: 'no-screen' });
  const n = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM screen_commands
      WHERE screen_id = $1 AND command = 'fitting-check' AND by = $2
        AND made_at > to_timestamp($3) - interval '1 day'`,
    [screenId, RIDER_APP, now],
  );
  const running = await pool.query<{ id: string }>(
    `SELECT c.id FROM screen_commands c
      WHERE c.screen_id = $1 AND c.command = 'fitting-check' AND c.until > to_timestamp($2)
        AND NOT EXISTS (SELECT 1 FROM fitting_checks k WHERE k.command_id = c.id)
      ORDER BY c.made_at DESC LIMIT 1`,
    [screenId, now],
  );
  if (running.rows[0]) return { commandId: running.rows[0].id };
  if ((n.rows[0]?.n ?? 0) >= rules.fittingChecksPerDay)
    throw new Refusal('Too many checks today: call support', { code: 'too-many-checks' });
  const c = await issueCommand(pool, {
    screenId,
    command: 'fitting-check',
    value: APP_CHECK_SECONDS,
    by: RIDER_APP,
    reason: `fitting check for ${riderId}`,
    nowMs: now * 1000,
    lifeMs: CHECK_LIFE_MS,
  });
  return { commandId: c.id };
}

/** The technician says whether every part of the panel lit up during this check (once). */
export async function answerPanel(
  pool: Pool,
  riderId: string,
  commandId: string,
  seen: boolean,
  now: number,
): Promise<void> {
  const screenId = await screenOfRider(pool, riderId, now);
  if (!screenId) throw new Refusal('Fit your screen first', { code: 'no-screen' });
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM screen_commands
      WHERE id = $1 AND screen_id = $2 AND command = 'fitting-check'
        AND made_at > to_timestamp($3) - interval '1 day'`,
    [commandId, screenId, now],
  );
  if (!r.rows[0]) throw new Refusal('No such check on your screen', { code: 'no-check' });
  await inTransaction(pool, async (c) => {
    const x = await c.query(
      `INSERT INTO fitting_panel_answers (command_id, screen_id, rider_id, seen, by_who, at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) ON CONFLICT DO NOTHING`,
      [commandId, screenId, riderId, seen, RIDER_APP, now],
    );
    if ((x.rowCount ?? 0) === 0)
      throw new Refusal('Answered already: start a new check', { code: 'answered' });
  });
}
