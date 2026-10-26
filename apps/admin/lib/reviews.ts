// The ad review page (P3.9.2): the rules a reviewer ticks to approve (the same list as
// REVIEW_CHECKLIST in packages/domain; a unit test keeps them equal) and how urgent an ad is.

export const CHECKLIST = [
  { key: 'no-flashing', text: 'No flashing or strobing' },
  { key: 'not-road-sign', text: 'Nothing that looks like a road sign or signal' },
  { key: 'allowed-category', text: 'Not a banned category' },
  { key: 'warnings-seen', text: 'Any warnings from the automatic checks looked at' },
] as const;

export const MIN_REASON = 10;

/** "due in 3 days", "due in 5 hours", "2 days late" or "no booking yet". */
export function dueText(neededBy: number | null, now: number): string {
  if (neededBy === null) return 'no booking yet';
  const s = neededBy - now;
  const n = (x: number, unit: string) => `${x} ${unit}${x === 1 ? '' : 's'}`;
  const size = (x: number) =>
    x >= 86_400 ? n(Math.floor(x / 86_400), 'day') : n(Math.max(1, Math.floor(x / 3600)), 'hour');
  return s >= 0 ? `due in ${size(s)}` : `${size(-s)} past the deadline`;
}
