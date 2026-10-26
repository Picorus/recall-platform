// Ads on the admin site (P3.9.1): what the automatic checks found, in one line.

export interface AdCheck {
  readonly check: string;
  readonly outcome: 'pass' | 'warn' | 'fail';
  readonly detail: string;
}

export interface AdView {
  readonly adId: string;
  readonly name: string;
  readonly kind: 'png' | 'jpeg' | 'webp' | 'mp4' | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly checks: readonly AdCheck[];
  readonly outcome: 'pass' | 'warn' | 'fail';
  readonly preview: string;
}

/** A booking's ads take turns: at least 2, at most 5 (the scheduler's rule). */
export const MIN_ADS = 2;
export const MAX_ADS = 5;

/** "Video 1280 × 720, 15.0 s: passes the checks", or what failed / needs a look. */
export function adSummary(a: AdView): string {
  const what = a.kind === 'mp4' ? 'Video' : 'Picture';
  const size = a.width && a.height ? ` ${a.width} × ${a.height}` : '';
  const len = a.durationMs !== null ? `, ${(a.durationMs / 1000).toFixed(1)} s` : '';
  const bad = a.checks.filter((c) => c.outcome === 'fail').map((c) => c.detail);
  const look = a.checks.filter((c) => c.outcome === 'warn').map((c) => c.detail);
  if (bad.length) return `${what}${size}${len}: cannot run: ${bad.join('; ')}`;
  if (look.length) return `${what}${size}${len}: passes, check by eye: ${look.join('; ')}`;
  return `${what}${size}${len}: passes the checks`;
}
