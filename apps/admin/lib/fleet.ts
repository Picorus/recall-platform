// The fleet map's words and filters (the API decides the states; these only show them).

export type FleetState = 'moving' | 'stopped' | 'offline' | 'at-hub';

export interface Position {
  readonly t: number;
  readonly lat: number;
  readonly lng: number;
  readonly moving: boolean;
  readonly place: string;
}

export interface FleetScreen {
  readonly screenId: string;
  readonly bike: string | null;
  readonly riderId: string | null;
  readonly state: FleetState;
  readonly position: Position | null;
  readonly lastHeard: number | null;
  readonly app: string | null;
  readonly alerts: readonly string[];
}

export interface Area {
  readonly areaId: string;
  readonly name: string;
  readonly version: number;
  readonly ring: readonly { lat: number; lng: number }[];
}

export const STATE_NAMES: Record<FleetState, string> = {
  moving: 'Moving',
  stopped: 'Stopped',
  offline: 'Offline',
  'at-hub': 'At hub',
};

export const STATE_CHIP: Record<FleetState, string> = {
  moving: 'rc-chip--go',
  stopped: 'rc-chip--paused',
  offline: 'rc-chip--stop',
  'at-hub': 'rc-chip--offline',
};

/** The area id a position is in or at the edge of ("inside:hyd-madhapur@3" → "hyd-madhapur"). */
export function areaOf(place: string | undefined): string | null {
  const m = /^(?:inside|edge):([^@]+)@\d+$/.exec(place ?? '');
  return m?.[1] ?? null;
}

export interface Filter {
  readonly states: ReadonlySet<FleetState>;
  /** An area id, or '' for every area. */
  readonly area: string;
  /** Part of a number plate or screen id, any case. */
  readonly search: string;
}

export function shown(s: FleetScreen, f: Filter): boolean {
  if (!f.states.has(s.state)) return false;
  if (f.area && areaOf(s.position?.place) !== f.area) return false;
  const q = f.search.trim().toUpperCase().replace(/\s+/g, '');
  if (q && !(s.bike ?? '').includes(q) && !s.screenId.includes(q)) return false;
  return true;
}

/** Counts by state, for the filter chips. */
export function counts(screens: readonly FleetScreen[]): Record<FleetState, number> {
  const out: Record<FleetState, number> = { moving: 0, stopped: 0, offline: 0, 'at-hub': 0 };
  for (const s of screens) out[s.state]++;
  return out;
}

/** "−87 dBm (good)": mobile signal in words. */
export function signalText(dbm: number | null): string {
  if (dbm === null) return 'not known';
  const word = dbm >= -85 ? 'good' : dbm >= -100 ? 'fair' : 'weak';
  return `${dbm} dBm (${word})`;
}

/** "76% charging", "12%", "not known". */
export function batteryText(pct: number | null, charging: boolean | null): string {
  if (pct === null) return 'not known';
  return `${pct}%${charging ? ' charging' : ''}`;
}
