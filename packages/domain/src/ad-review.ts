// P3.9.2: a person's review of an uploaded ad. The automatic checks (ad-checks.ts) read the file;
// what no machine can judge is a checklist the reviewer ticks to approve (Product v5.4: "no
// flashing, nothing like a road sign, no banned categories"). A rejection says why, so Sales can tell
// the brand what to fix. Legibility and colour are advice, never a reason to reject (DECISIONS,
// 22 Oct 2026). The person who uploaded an ad does not review it (a super admin may, in the POC).

/** The staff id in a "Name (id)" record of who did something, or null. */
export function staffIdOf(who: string): string | null {
  return /\(([^()]+)\)$/.exec(who)?.[1] ?? null;
}

export const REVIEW_CHECKLIST = [
  { key: 'no-flashing', text: 'No flashing or strobing' },
  { key: 'not-road-sign', text: 'Nothing that looks like a road sign or signal' },
  { key: 'allowed-category', text: 'Not a banned category' },
  { key: 'warnings-seen', text: 'Any warnings from the automatic checks looked at' },
] as const;

export type ChecklistKey = (typeof REVIEW_CHECKLIST)[number]['key'];
export type ReviewDecision = 'approved' | 'rejected';

/** A reason is at least this many letters (rejections; short-notice approvals). */
export const MIN_REASON = 10;
export const MAX_REASON = 500;

/** Why a reason cannot be used, or undefined. */
export function reasonProblem(reason: string): string | undefined {
  const r = reason.trim();
  if (r.length < MIN_REASON || r.length > MAX_REASON)
    return `Say why in ${MIN_REASON} to ${MAX_REASON} letters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r))
    return 'The reason has a character that is not allowed';
  return undefined;
}

/** Why this decision cannot be recorded, or undefined. `outcome`: the automatic checks' worst. */
export function reviewProblem(r: {
  readonly decision: ReviewDecision;
  readonly reason: string | null;
  readonly checklist: Readonly<Record<string, boolean>>;
  readonly outcome: 'pass' | 'warn' | 'fail';
}): string | undefined {
  if (r.decision === 'rejected') return reasonProblem(r.reason ?? '');
  if (r.outcome === 'fail') return 'It failed the automatic checks: it can only be rejected';
  const missing = REVIEW_CHECKLIST.filter((c) => r.checklist[c.key] !== true);
  if (missing.length) return `Tick every rule to approve: ${missing.map((c) => c.text).join('; ')}`;
  return undefined;
}
