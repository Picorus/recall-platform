// P1.9.1: the final campaign report. One report per booking, built once its last make-up has had
// time to play (24 hours after the last hour, a setting), then kept as it was built. It shows what
// the brand bought: plays delivered against plays promised, different bikes, a heat map of where the
// plays happened, the busiest streets, make-ups, any refund, and people (approximate, never billed).
import { cellToBoundary, cellToLatLng, latLngToCell } from 'h3-js';
import { formatRupees, paise } from './money.js';
import { indianNumber, type PeopleEstimate } from './people.js';

/** Settings for the final report (in the price book, versioned). */
export interface ReportRules {
  /** The report is built this many hours after the campaign's last hour at the earliest. */
  readonly afterHours: number;
  /** Size of the heat map's hexagons (H3 resolution 9: about 0.1 km² each, a few streets). */
  readonly h3Resolution: number;
  /** How many busiest streets are listed. */
  readonly topStreets: number;
  /** Only the busiest hexagons are looked up for street names (each look-up is a maps call). */
  readonly streetCells: number;
}

export const DEFAULT_REPORT_RULES: ReportRules = {
  afterHours: 24,
  h3Resolution: 9,
  topStreets: 5,
  streetCells: 40,
};

export function checkReportRules(r: ReportRules): string[] {
  const ok = (n: number, min: number, max: number) =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    !ok(r.afterHours, 1, 24 * 14) ||
    !ok(r.h3Resolution, 6, 11) ||
    !ok(r.topStreets, 1, 20) ||
    !ok(r.streetCells, r.topStreets, 500)
  )
    return ['report settings: 1 hour to 14 days, hexagon size 6–11, 1–20 streets, enough hexagons'];
  return [];
}

/** A play that counted, with where it started (millionths of a degree). */
export interface PlacedPlay {
  readonly screenId: string;
  readonly latE6: number;
  readonly lngE6: number;
}

export interface HeatCell {
  /** H3 cell id. */
  readonly cell: string;
  /** Its centre, for drawing and for the street look-up. */
  readonly lat: number;
  readonly lng: number;
  readonly plays: number;
}

/** Plays per hexagon, busiest first (ties by cell id, so the same plays always give the same map). */
export function heatMap(plays: readonly PlacedPlay[], resolution: number): HeatCell[] {
  const counts = new Map<string, number>();
  for (const p of plays) {
    const cell = latLngToCell(p.latE6 / 1e6, p.lngE6 / 1e6, resolution);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts]
    .map(([cell, n]) => {
      const [lat, lng] = cellToLatLng(cell);
      return { cell, lat, lng, plays: n };
    })
    .sort((a, b) => b.plays - a.plays || (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
}

/** A hexagon's corners as [lat, lng] pairs, for drawing the heat map. */
export const hexOutline = (cell: string): [number, number][] => cellToBoundary(cell);

export interface Street {
  readonly name: string;
  readonly plays: number;
}

/**
 * The busiest streets: the plays of each looked-up hexagon go to the street at its centre; streets
 * are added up and the top ones listed, busiest first. Hexagons with no street name are left out.
 */
export function busiestStreets(
  cells: readonly HeatCell[],
  streetOf: ReadonlyMap<string, string>,
  top: number,
): Street[] {
  const sums = new Map<string, number>();
  for (const c of cells) {
    const name = streetOf.get(c.cell);
    if (name !== undefined) sums.set(name, (sums.get(name) ?? 0) + c.plays);
  }
  return [...sums]
    .map(([name, plays]) => ({ name, plays }))
    .sort((a, b) => b.plays - a.plays || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, top);
}

export type RefundStatus = 'under review' | 'approved' | 'rejected';

export interface ReportLine {
  readonly lineId: string;
  readonly areaId: string;
  /** The area's name as it was sold ("Madhapur"). */
  readonly areaName: string;
  readonly date: string;
  readonly startHour: number;
  readonly bikes: number;
  readonly promised: number;
  /** Counted plays in the hour itself, and in its make-ups. */
  readonly delivered: number;
  readonly madeUp: number;
  /** Plays still missing after the make-ups (extra plays never make up for another line). */
  readonly missing: number;
  /** Refund for the missing plays, before GST, and where it stands. */
  readonly refund?: { readonly paise: number; readonly status: RefundStatus };
}

export interface CampaignReport {
  readonly bookingId: string;
  readonly brandId: string;
  /** First hour and end of the last hour (UTC seconds). */
  readonly from: number;
  readonly until: number;
  readonly builtAt: number;
  readonly lines: readonly ReportLine[];
  readonly promised: number;
  /** All counted plays, make-ups included (can be more than promised: extras are a bonus). */
  readonly delivered: number;
  /** Delivered as a share of promised, in basis points, at most 100%. */
  readonly deliveredBp: number;
  readonly missing: number;
  /** Different bikes (screens) with at least one counted play. */
  readonly bikes: number;
  readonly makeUps: { readonly opened: number; readonly plays: number };
  readonly refund: { readonly paise: number; readonly status: RefundStatus } | undefined;
  readonly heatMap: readonly HeatCell[];
  readonly streets: readonly Street[];
  readonly people: PeopleEstimate;
}

/** What the database hands over for one line. */
export interface LineForReport extends Omit<ReportLine, 'delivered' | 'madeUp' | 'missing'> {
  readonly hourPlays: readonly PlacedPlay[];
  readonly makeUpPlays: readonly PlacedPlay[];
}

/** The report's sums and heat map, from its lines (P1.9.1). Pure: same input, same report. */
export function campaignReport(x: {
  readonly bookingId: string;
  readonly brandId: string;
  readonly from: number;
  readonly until: number;
  readonly builtAt: number;
  readonly lines: readonly LineForReport[];
  readonly makeUpsOpened: number;
  readonly streetOf: ReadonlyMap<string, string>;
  readonly people: PeopleEstimate;
  readonly rules: ReportRules;
}): CampaignReport {
  const lines: ReportLine[] = x.lines.map(({ hourPlays, makeUpPlays, ...l }) => ({
    ...l,
    delivered: hourPlays.length,
    madeUp: makeUpPlays.length,
    missing: Math.max(0, l.promised - hourPlays.length - makeUpPlays.length),
  }));
  const all = x.lines.flatMap((l) => [...l.hourPlays, ...l.makeUpPlays]);
  const promised = lines.reduce((n, l) => n + l.promised, 0);
  const delivered = all.length;
  const missing = lines.reduce((n, l) => n + l.missing, 0);
  const refunds = lines.flatMap((l) => (l.refund ? [l.refund] : []));
  const cells = heatMap(all, x.rules.h3Resolution);
  return {
    bookingId: x.bookingId,
    brandId: x.brandId,
    from: x.from,
    until: x.until,
    builtAt: x.builtAt,
    lines,
    promised,
    delivered,
    deliveredBp:
      promised === 0
        ? 10_000
        : Math.floor((Math.min(promised - missing, promised) * 10_000) / promised),
    missing,
    bikes: new Set(all.map((p) => p.screenId)).size,
    makeUps: { opened: x.makeUpsOpened, plays: lines.reduce((n, l) => n + l.madeUp, 0) },
    refund:
      refunds.length === 0
        ? undefined
        : {
            paise: refunds.reduce((n, r) => n + (r.status === 'rejected' ? 0 : r.paise), 0),
            // One status for the whole report: under review while any is.
            status: refunds.some((r) => r.status === 'under review')
              ? 'under review'
              : refunds.some((r) => r.status === 'approved')
                ? 'approved'
                : 'rejected',
          },
    heatMap: cells,
    streets: busiestStreets(cells, x.streetOf, x.rules.topStreets),
    people: x.people,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "30 Sep 2027" from "2027-09-30". */
const dayText = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1] ?? '?'} ${y}`;
};

/** The campaign's business days: "30 Sep 2027" or "30 Sep 2027 – 2 Oct 2027". */
export function reportPeriod(r: Pick<CampaignReport, 'lines'>): string {
  const days = r.lines.map((l) => l.date).sort();
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? dayText(first) : `${dayText(first)} – ${dayText(last)}`;
}

/** Delivered as a percentage with one decimal, never rounded up to 100% (8,549 bp → "85.4%"). */
export const deliveredText = (bp: number) => `${Math.floor(bp / 10) / 10}%`;

/** The report in a few plain lines, for messages and the top of the page. */
export function reportSummary(r: CampaignReport): string[] {
  const n = indianNumber;
  const out = [
    `${n(r.promised - r.missing)} of ${n(r.promised)} plays delivered (${deliveredText(r.deliveredBp)}) on ${n(r.bikes)} different bikes.`,
  ];
  const extra = r.delivered - (r.promised - r.missing);
  if (extra > 0) out.push(`Plus ${n(extra)} extra plays, free.`);
  if (r.makeUps.plays > 0) out.push(`${n(r.makeUps.plays)} plays were made up in extra hours.`);
  if (r.refund && r.refund.status !== 'rejected') {
    const rupees = formatRupees(paise(r.refund.paise));
    out.push(
      r.refund.status === 'approved'
        ? `${n(r.missing)} plays could not be made up: ${rupees} (plus GST) is refunded.`
        : `${n(r.missing)} plays could not be made up: a refund of ${rupees} (plus GST) is being processed.`,
    );
  }
  out.push(`People who saw the ads: ${r.people.text}.`);
  return out;
}
