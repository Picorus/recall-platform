// P7.7.7: a final report's plays day by day and hour by hour, for the charts on the brand portal's
// report page. From the report as it was built (never recounted): each line's plays in its hour plus
// those its make-ups delivered, against the plays promised. Bike-hours are what was booked (and
// billed); plays are what the screens signed.
import type { CampaignReport } from './report.js';

export interface ReportDay {
  /** India date of the booked hours ("2027-08-23"). */
  readonly date: string;
  readonly bikeHours: number;
  readonly promised: number;
  /** Counted plays for that day's hours, their make-ups included. */
  readonly delivered: number;
}

export interface ReportHour {
  /** India hour the booked hour starts at (8 … 25: 24 and 25 are midnight and 1am). */
  readonly hour: number;
  readonly bikeHours: number;
  readonly promised: number;
  readonly delivered: number;
}

type Line = CampaignReport['lines'][number];

function sumBy<K extends string | number>(lines: readonly Line[], key: (l: Line) => K) {
  const out = new Map<K, { bikeHours: number; promised: number; delivered: number }>();
  for (const l of lines) {
    const k = key(l);
    const was = out.get(k) ?? { bikeHours: 0, promised: 0, delivered: 0 };
    out.set(k, {
      bikeHours: was.bikeHours + l.bikes,
      promised: was.promised + l.promised,
      delivered: was.delivered + l.delivered + l.madeUp,
    });
  }
  return out;
}

/** The report's days in order, each with its booked bike-hours, plays promised and delivered. */
export function reportDays(r: Pick<CampaignReport, 'lines'>): ReportDay[] {
  return [...sumBy(r.lines, (l) => l.date)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, x]) => ({ date, ...x }));
}

/** The hours of the day it ran in, in order (8am first, 1am last), summed over its days. */
export function reportHours(r: Pick<CampaignReport, 'lines'>): ReportHour[] {
  return [...sumBy(r.lines, (l) => l.startHour)]
    .sort(([a], [b]) => a - b)
    .map(([hour, x]) => ({ hour, ...x }));
}
