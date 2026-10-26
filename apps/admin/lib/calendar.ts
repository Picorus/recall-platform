// The inventory calendar page: India time to UTC for a hold's end, moving a week, and what each
// area-hour cell says.

export interface Cell {
  readonly date: string;
  readonly startHour: number;
  readonly booked: number;
  readonly held: number;
  readonly manualLimit: number | null;
  readonly limit: number | null;
  readonly free: number | null;
  readonly usual: number | null;
  readonly deliveredTenths: number | null;
}

export interface HoldView {
  readonly holdId: string;
  readonly brandId: string;
  readonly heldBy: string;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly until: number;
  readonly endedEarly: { at: number; by: string; reason: string } | null;
  readonly bookingId: string | null;
  readonly lines: readonly { date: string; startHour: number; bikes: number }[];
}

/** "2027-08-23" + n days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A date and "HH:MM" typed in India time → UTC seconds; null when either cannot be read. */
export function indiaToUtc(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const ms = Date.parse(`${date}T${time}:00+05:30`);
  if (Number.isNaN(ms) || new Date(ms + 330 * 60_000).toISOString().slice(0, 10) !== date)
    return null;
  return ms / 1000;
}

/** How full a cell is: no limit, room, nearly full (a tenth or less left), or full. */
export function cellTone(c: Cell): 'none' | 'room' | 'tight' | 'full' {
  if (c.limit === null || c.free === null) return 'none';
  if (c.free === 0) return 'full';
  return c.free * 10 <= c.limit ? 'tight' : 'room';
}

/** The cell in words: "30 booked · 15 held", "15 free of 40" (or "no limit"). */
export function cellLines(c: Cell): [string, string] {
  const parts = [`${c.booked} booked`];
  if (c.held > 0) parts.push(`${c.held} held`);
  return [parts.join(' · '), c.limit === null ? 'no limit' : `${c.free ?? 0} free of ${c.limit}`];
}

/** "7.5" bike-hours delivered from tenths. */
export function tenths(t: number): string {
  return t % 10 === 0 ? String(t / 10) : `${Math.floor(t / 10)}.${t % 10}`;
}

/** Whether a hold still keeps bikes now. */
export function holdLive(h: HoldView, now: number): boolean {
  return h.until > now && h.bookingId === null;
}
