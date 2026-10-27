// P4.5 in the database: the rider app's Earnings page for one month. Its days and weeks (counted
// moving hours and what they earned by his pay rules, as on Today), the month's parts (₹25 an hour,
// the POC base, his share of sales as of the pay run's last update, POC bonuses given) and, in the
// POC, his progress to the founding bonus. A closed month shows what the pay run posted. Read only.
import {
  pocMonthBonus,
  todayOf,
  toIndiaTime,
  weekStartOf,
  type RiderPayRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { monthBounds } from './rider-pay.js';
import { riderDays, type RiderTodayDay } from './rider-today.js';

type Q = Pick<Pool, 'query'>;

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** What the pay run last posted for a month: its parts then. */
export interface PayLine {
  readonly at: number;
  readonly countedSeconds: number;
  readonly paidSeconds: number;
  readonly pocPaise: number;
  readonly hourlyPaise: number;
  readonly soldPaise: number;
  readonly grossPaise: number;
  readonly tdsPaise: number;
}

export interface RiderEarnings {
  readonly at: number;
  readonly month: string;
  /** Months he can look at, newest first (from his first screen; at most 12). */
  readonly months: readonly string[];
  /** The pay run will not change this month any more. */
  readonly closed: boolean;
  readonly days: readonly RiderTodayDay[];
  /** Monday-to-Sunday weeks of the month (cut at its ends), newest last. */
  readonly weeks: readonly {
    readonly from: string;
    readonly to: string;
    readonly countedSeconds: number;
    readonly earnedPaise: number;
  }[];
  /** The month so far: counted hours and what they earned (₹25 an hour, capped; POC base). */
  readonly countedSeconds: number;
  readonly hourlyPaise: number;
  readonly pocPaise: number;
  /** His share of sales as of the pay run's last update (null: no update yet). */
  readonly soldPaise: number;
  readonly soldAsOf: number | null;
  /** Bonuses given for this month (the POC founding bonus). */
  readonly bonusPaise: number;
  /** hourly + POC base + sales share + bonuses, before tax. */
  readonly totalPaise: number;
  /** The POC month's founding bonus: his POC hours and what they would earn; null outside it. */
  readonly poc: {
    readonly countedSeconds: number;
    readonly fromHours: number;
    readonly fullHours: number;
    readonly bonusPaise: number;
    readonly given: boolean;
  } | null;
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

/** The pay run's last posting for his month, with its parts. */
export async function lastPayLine(
  pool: Q,
  riderId: string,
  month: string,
): Promise<PayLine | null> {
  const r = await pool.query<{
    at: string;
    counted_s: string;
    paid_s: string;
    poc_paise: string;
    hourly_paise: string;
    sold_paise: string;
    gross_paise: string;
    tds_paise: string;
  }>(
    `SELECT extract(epoch FROM at)::bigint AS at, counted_s, paid_s, poc_paise, hourly_paise,
            sold_paise, gross_paise, tds_paise
       FROM rider_pay_lines WHERE rider_id = $1 AND month = $2
      ORDER BY at DESC, entry_id DESC LIMIT 1`,
    [riderId, month],
  );
  const x = r.rows[0];
  return x
    ? {
        at: Number(x.at),
        countedSeconds: Number(x.counted_s),
        paidSeconds: Number(x.paid_s),
        pocPaise: Number(x.poc_paise),
        hourlyPaise: Number(x.hourly_paise),
        soldPaise: Number(x.sold_paise),
        grossPaise: Number(x.gross_paise),
        tdsPaise: Number(x.tds_paise),
      }
    : null;
}

/** The months he can look at: from his first screen to now, newest first, at most 12. */
export async function riderMonths(pool: Q, riderId: string, now: number): Promise<string[]> {
  const r = await pool.query<{ first: string | null }>(
    `SELECT extract(epoch FROM min(from_at))::bigint AS first FROM rider_screens WHERE rider_id = $1`,
    [riderId],
  );
  const current = todayOf(now).slice(0, 7);
  const first = r.rows[0]?.first;
  const start = first ? toIndiaTime(new Date(Number(first) * 1000)).date.slice(0, 7) : current;
  const out: string[] = [];
  let [y, m] = current.split('-').map(Number) as [number, number];
  while (out.length < 12) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(month);
    if (month <= start) break;
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export async function riderEarnings(
  pool: Q,
  riderId: string,
  month: string,
  now: number,
): Promise<RiderEarnings> {
  if (!MONTH.test(month)) throw new RangeError('Month must be YYYY-MM');
  const today = todayOf(now);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lastDay = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const last = lastDay < today ? lastDay : today;
  const months = await riderMonths(pool, riderId, now);
  const {
    days: full,
    rules,
    pocFirst,
  } = `${month}-01` <= today
    ? await riderDays(pool, riderId, `${month}-01`, last, now)
    : { days: [], rules: undefined, pocFirst: undefined };
  const days = full.map(({ day, countedSeconds, earnedPaise }) => ({
    day,
    countedSeconds,
    earnedPaise,
  }));
  // Weeks from Monday (cut at the month's ends).
  const weeks = new Map<
    string,
    { from: string; to: string; countedSeconds: number; earnedPaise: number }
  >();
  for (const d of days) {
    const monday = toIndiaTime(
      new Date(weekStartOf(Date.parse(`${d.day}T02:30:00Z`) / 1000) * 1000),
    ).date;
    const w = weeks.get(monday) ?? { from: d.day, to: d.day, countedSeconds: 0, earnedPaise: 0 };
    weeks.set(monday, {
      from: w.from,
      to: d.day,
      countedSeconds: w.countedSeconds + d.countedSeconds,
      earnedPaise: w.earnedPaise + d.earnedPaise,
    });
  }
  const r: RiderPayRules | undefined = rules;
  const closed = r !== undefined && now >= monthBounds(month).end + r.monthCloseHours * 3600;
  const line = await lastPayLine(pool, riderId, month);
  const bonus = await pool.query<{ paise: string | null; given: boolean }>(
    `SELECT sum(p.debit) AS paise, count(*) > 0 AS given
       FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
      WHERE e.kind = 'poc-bonus' AND e.ref = $1 AND p.account = 'rider-earnings'`,
    [`${riderId}/${month}`],
  );
  const bonusPaise = Number(bonus.rows[0]?.paise ?? 0);

  const live = {
    countedSeconds: full
      .filter((d) => d.mode === 'regular')
      .reduce((n, d) => n + d.countedSeconds, 0),
    hourlyPaise: full.filter((d) => d.mode === 'regular').reduce((n, d) => n + d.earnedPaise, 0),
    pocPaise: full.filter((d) => d.mode === 'poc').reduce((n, d) => n + d.earnedPaise, 0),
  };
  // A closed month: what the pay run posted (late uploads it did not pay are not shown).
  const parts =
    closed && line
      ? {
          countedSeconds: line.countedSeconds,
          hourlyPaise: line.hourlyPaise,
          pocPaise: line.pocPaise,
        }
      : live;
  const soldPaise = line?.soldPaise ?? 0;
  const pocDays = full.filter((d) => d.mode === 'poc');
  const pocSeconds = pocDays.reduce((n, d) => n + d.countedSeconds, 0);
  return {
    at: now,
    month,
    months,
    closed,
    days,
    weeks: [...weeks.values()],
    ...parts,
    soldPaise,
    soldAsOf: line?.at ?? null,
    bonusPaise,
    totalPaise: parts.hourlyPaise + parts.pocPaise + soldPaise + bonusPaise,
    poc:
      r && pocDays.length > 0 && pocFirst !== undefined
        ? {
            countedSeconds: pocSeconds,
            fromHours: r.pocBonusFromHours,
            fullHours: r.pocBonusFullHours,
            bonusPaise: pocMonthBonus(r, pocSeconds),
            given: bonus.rows[0]?.given === true,
          }
        : null,
    perMovingHourPaise: r?.perMovingHourPaise ?? 0,
    monthlyCapHours: r?.monthlyCapHours ?? 0,
  };
}
