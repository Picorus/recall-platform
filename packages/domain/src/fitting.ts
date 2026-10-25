// P2.14: the fitting check. When a technician fits a screen to a bike, they start a test from the rider
// app (P4): the cloud sends the box a `fitting-check` command (P2.12), the box shows the test pattern
// (so every part of the panel can be seen lighting up) and checks GPS, the 4G line, the camera and
// the battery, then sends a fitting report through its outbox. The cloud judges each part again by
// its own rules and marks the bike ready only when every part passes; the latest check counts.
//
// A part the box cannot check (no camera link yet) is "unknown", which never passes: a bike is not
// ready on a guess.

export type PartResult = 'ok' | 'fail' | 'unknown';

/** One fitting check, as the box sends it. */
export interface FittingReport {
  readonly kind: 'fitting';
  /** The command that started it. */
  readonly id: string;
  /** When it finished (UTC seconds). */
  readonly at: number;
  /** Best GPS accuracy seen during the check (m), or null without a fix. */
  readonly gpsAccuracyM: number | null;
  /** The line to the cloud was up at the end of the check. */
  readonly lineUp: boolean;
  readonly camera: PartResult;
  readonly batteryPct: number | null;
  readonly charging: boolean | null;
  /** The technician saw the whole test pattern: from the rider app; the box sends unknown. */
  readonly panel: PartResult;
}

export const FITTING_FIELDS = [
  'kind',
  'id',
  'at',
  'gpsAccuracyM',
  'lineUp',
  'camera',
  'batteryPct',
  'charging',
  'panel',
] as const;

export interface FittingRules {
  /** GPS fix at least this good (m). */
  readonly maxGpsAccuracyM: number;
  /** Battery at least this (percent), unless charging. */
  readonly minBatteryPct: number;
}

export const DEFAULT_FITTING_RULES: FittingRules = { maxGpsAccuracyM: 50, minBatteryPct: 50 };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isPart = (v: unknown) => v === 'ok' || v === 'fail' || v === 'unknown';

export function checkFittingShape(x: Record<string, unknown>): string | undefined {
  if (typeof x.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(x.id)) return 'bad command id';
  if (!isInt(x.at, 0, 2 ** 32)) return 'bad time';
  if (!(x.gpsAccuracyM === null || isInt(x.gpsAccuracyM, 0, 100_000))) return 'bad gps';
  if (typeof x.lineUp !== 'boolean') return 'bad line';
  if (!isPart(x.camera) || !isPart(x.panel)) return 'bad part';
  if (!(x.batteryPct === null || isInt(x.batteryPct, 0, 100))) return 'bad battery';
  if (!(x.charging === null || typeof x.charging === 'boolean')) return 'bad battery';
  return undefined;
}

export interface FittingVerdict {
  readonly gps: PartResult;
  readonly line: PartResult;
  readonly camera: PartResult;
  readonly battery: PartResult;
  /** Every part checked passed: the bike is ready. */
  readonly ready: boolean;
}

/** The cloud's own judgement of a fitting report (the box's view of itself is not taken on trust). */
export function fittingVerdict(
  r: FittingReport,
  rules: FittingRules = DEFAULT_FITTING_RULES,
): FittingVerdict {
  const gps: PartResult =
    r.gpsAccuracyM === null ? 'fail' : r.gpsAccuracyM <= rules.maxGpsAccuracyM ? 'ok' : 'fail';
  const line: PartResult = r.lineUp ? 'ok' : 'fail';
  const battery: PartResult =
    r.batteryPct === null
      ? 'unknown'
      : r.batteryPct >= rules.minBatteryPct || r.charging === true
        ? 'ok'
        : 'fail';
  const parts = [gps, line, r.camera, battery];
  return { gps, line, camera: r.camera, battery, ready: parts.every((p) => p === 'ok') };
}
