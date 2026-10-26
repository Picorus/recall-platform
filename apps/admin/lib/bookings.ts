// Booking for a brand (P3.8.2): the lines a form makes (one area, a run of days, chosen hours, the
// same bikes) and what a payment link's state means.

export interface Line {
  readonly areaId: string;
  readonly date: string;
  readonly startHour: number;
  readonly bikes: number;
}

export const MAX_LINES = 500;

/** Every day from `from` to `to` (inclusive) × every hour, in one area; or what is wrong. */
export function linesOf(
  areaId: string,
  from: string,
  to: string,
  hours: readonly number[],
  bikes: number,
): { lines: Line[] } | { problem: string } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!areaId) return { problem: 'Choose an area' };
  if (!day.test(from) || !day.test(to)) return { problem: 'Choose the first and last day' };
  if (!Number.isSafeInteger(bikes) || bikes < 1) return { problem: 'Bikes must be a whole number' };
  if (hours.length === 0) return { problem: 'Choose at least one start hour' };
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a)
    return { problem: 'The last day is before the first' };
  const days = (b - a) / 86_400_000 + 1;
  if (days * hours.length > MAX_LINES)
    return { problem: `At most ${MAX_LINES} area-hours in one booking` };
  const hrs = [...new Set(hours)].sort((x, y) => x - y);
  const lines: Line[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(a + i * 86_400_000).toISOString().slice(0, 10);
    for (const startHour of hrs) lines.push({ areaId, date, startHour, bikes });
  }
  return { lines };
}

/** The newest link's state in words. */
export function linkText(
  link: { expiresAt: number; states: readonly string[] } | null,
  now: number,
): string {
  if (!link) return 'No payment link yet';
  if (link.states.includes('paid')) return 'Paid';
  if (link.states.includes('paid-late')) return 'Paid after cancelling: finance to return it';
  if (link.states.includes('cancelled')) return 'Link stopped';
  if (link.states.includes('expired') || now >= link.expiresAt) return 'Link ran out unpaid';
  return 'Waiting for payment';
}
