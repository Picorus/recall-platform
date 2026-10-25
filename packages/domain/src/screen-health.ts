// P2.11: how each screen is doing. Every minute the box sends a health report through the same
// outbox as its plays (numbered, kept until confirmed): battery, temperature, storage, mobile signal,
// the LED panel, tamper, the app version, and its own counters of things that went wrong (spots not
// counted, plays not stored, messages refused, GPS seconds missed, ads missing). The cloud raises an
// alert on overheating, a low battery, tamper, an LED fault, storage running out, and a screen not
// heard from for 30 minutes; each clears by itself when the problem goes.
//
// Readings the box cannot take (no battery link yet, no LED sending card yet) travel as null: never
// a made-up number. Counters are totals since the box started (`upS`), so a lost report loses nothing
// and a restart shows as the counters starting again.

/** One minute of a screen's health, as the box sends it. */
export interface HealthReport {
  readonly kind: 'health';
  /** The minute it describes (UTC seconds, a multiple of 60). */
  readonly t: number;
  /** The player's version. */
  readonly app: string;
  /** Seconds since the app started (counters below are totals since then). */
  readonly upS: number;
  /** Battery charge, percent; whether it is charging. */
  readonly batteryPct: number | null;
  readonly charging: boolean | null;
  /** Temperatures, whole °C: the battery's and the box's own. */
  readonly batteryC: number | null;
  readonly boxC: number | null;
  /** Free storage, whole MB. */
  readonly freeMb: number;
  /** Mobile signal, dBm (about −50 strong to −120 none). */
  readonly signalDbm: number | null;
  /** The LED panel reports a fault; the case was opened or the panel unplugged. */
  readonly ledFault: boolean | null;
  readonly tamper: boolean | null;
  /** The two clocks (GPS and the cloud) disagree by more than they should. */
  readonly clockDisagree: boolean;
  readonly spotsNotCounted: number;
  readonly playsNotStored: number;
  readonly messagesRefused: number;
  readonly gpsMissedSeconds: number;
  readonly adsMissing: number;
}

export const HEALTH_FIELDS = [
  'kind',
  't',
  'app',
  'upS',
  'batteryPct',
  'charging',
  'batteryC',
  'boxC',
  'freeMb',
  'signalDbm',
  'ledFault',
  'tamper',
  'clockDisagree',
  'spotsNotCounted',
  'playsNotStored',
  'messagesRefused',
  'gpsMissedSeconds',
  'adsMissing',
] as const;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const intOrNull = (v: unknown, min: number, max: number) => v === null || isInt(v, min, max);
const boolOrNull = (v: unknown) => v === null || typeof v === 'boolean';
const COUNTER_MAX = 2 ** 40;

/** Shape check of a health report (after the field list is checked). */
export function checkHealthShape(x: Record<string, unknown>): string | undefined {
  if (!isInt(x.t, 0, 2 ** 32) || x.t % 60 !== 0) return 'health must be for a whole minute';
  if (typeof x.app !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(x.app)) return 'bad app version';
  if (!isInt(x.upS, 0, COUNTER_MAX)) return 'bad up time';
  if (!intOrNull(x.batteryPct, 0, 100) || !boolOrNull(x.charging)) return 'bad battery';
  if (!intOrNull(x.batteryC, -40, 150) || !intOrNull(x.boxC, -40, 150)) return 'bad temperature';
  if (!isInt(x.freeMb, 0, 10_000_000)) return 'bad storage';
  if (!intOrNull(x.signalDbm, -150, 0)) return 'bad signal';
  if (!boolOrNull(x.ledFault) || !boolOrNull(x.tamper) || typeof x.clockDisagree !== 'boolean')
    return 'bad flags';
  for (const k of [
    'spotsNotCounted',
    'playsNotStored',
    'messagesRefused',
    'gpsMissedSeconds',
    'adsMissing',
  ] as const)
    if (!isInt(x[k], 0, COUNTER_MAX)) return `bad counter ${k}`;
  return undefined;
}

/** When a screen's health is an alert (settings, in the price book's way: versioned). */
export interface HealthRules {
  /** The box or its battery at or above this (°C). */
  readonly overheatC: number;
  readonly batteryOverheatC: number;
  /** Battery at or under this percent while not charging. */
  readonly lowBatteryPct: number;
  /** Free storage under this (MB): ads and the outbox need room. */
  readonly lowStorageMb: number;
  /** Not heard from (no report, no hello) for this long. */
  readonly silentMinutes: number;
}

export const DEFAULT_HEALTH_RULES: HealthRules = {
  overheatC: 75,
  batteryOverheatC: 55,
  lowBatteryPct: 15,
  lowStorageMb: 500,
  silentMinutes: 30,
};

export type AlertKind =
  'overheating' | 'low-battery' | 'tamper' | 'led-fault' | 'low-storage' | 'no-contact';

/** The alerts a health report raises now (others of these kinds are clear). Never `no-contact`. */
export function healthAlerts(
  h: HealthReport,
  rules: HealthRules = DEFAULT_HEALTH_RULES,
): Set<AlertKind> {
  const out = new Set<AlertKind>();
  if (
    (h.boxC !== null && h.boxC >= rules.overheatC) ||
    (h.batteryC !== null && h.batteryC >= rules.batteryOverheatC)
  )
    out.add('overheating');
  if (h.batteryPct !== null && h.batteryPct <= rules.lowBatteryPct && h.charging !== true)
    out.add('low-battery');
  if (h.tamper === true) out.add('tamper');
  if (h.ledFault === true) out.add('led-fault');
  if (h.freeMb < rules.lowStorageMb) out.add('low-storage');
  return out;
}

/** The kinds a health report decides (raised or cleared by it). */
export const HEALTH_ALERT_KINDS: readonly AlertKind[] = [
  'overheating',
  'low-battery',
  'tamper',
  'led-fault',
  'low-storage',
];

/** True when a screen last heard at `lastHeardMs` counts as silent at `nowMs`. */
export function isSilent(
  lastHeardMs: number,
  nowMs: number,
  rules: HealthRules = DEFAULT_HEALTH_RULES,
): boolean {
  return nowMs - lastHeardMs >= rules.silentMinutes * 60_000;
}
