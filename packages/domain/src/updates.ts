// P2.13: our own update system for the screen player. A new version goes to 1% of screens, then 10%,
// then all, each step after a wait with nothing wrong; if crashes rise on the new version it rolls
// back by itself.
//
// Android never installs an older version over a newer one, so a rollback is a build of the last
// good code with a higher version number, made with each release (`rollback`). Rolling back sends
// that build to every screen that took the bad one. A screen joins a stage by a fixed hash of its id
// and the release: the same 1% each time it asks, a different 1% for each release.
//
// The update message (down/update) names one file: version, SHA-256, size and an HTTPS link. The
// box downloads it, checks the fingerprint, and installs it as device owner (no one taps anything).
import { fnv1a32 } from './scheduler.js';

export interface ApkFile {
  /** Android version code (whole, rising) and the name shown in health reports. */
  readonly versionCode: number;
  readonly versionName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
}

export interface Release {
  readonly id: string;
  readonly apk: ApkFile;
  /** The last good code, numbered above `apk`: what a rollback installs. */
  readonly rollback: ApkFile;
}

/** The rollout's settings (versioned like every setting). */
export interface RolloutRules {
  /** Share of screens at each stage, in basis points (100 = 1%). */
  readonly stagesBp: readonly number[];
  /** Least time at a stage before the next (ms). */
  readonly holdMs: number;
  /** Least screen-hours on the new version before a stage can be judged. */
  readonly minScreenHours: number;
  /** Crashes per screen-hour on the new version above which it rolls back... */
  readonly maxCrashRate: number;
  /** ...and above this many times the old version's rate (when the old one crashes at all). */
  readonly maxCrashRatio: number;
  /** Fewest crashes that can roll back before enough screen-hours are seen (one is chance). */
  readonly minCrashes: number;
}

export const DEFAULT_ROLLOUT_RULES: RolloutRules = {
  stagesBp: [100, 1_000, 10_000],
  holdMs: 24 * 3_600_000,
  minScreenHours: 20,
  maxCrashRate: 0.05,
  maxCrashRatio: 2,
  minCrashes: 3,
};

/** Where a screen falls for a release, 0–9999: it is in a stage when below the stage's share. */
export function bucketOf(screenId: string, releaseId: string): number {
  return fnv1a32(`${releaseId}|${screenId}`) % 10_000;
}

export function inStage(screenId: string, releaseId: string, stageBp: number): boolean {
  return bucketOf(screenId, releaseId) < stageBp;
}

/** How a version has done since the stage began: crashes over screen-hours. */
export interface VersionStats {
  readonly screenHours: number;
  readonly crashes: number;
}

export type RolloutStep =
  | { readonly do: 'hold'; readonly why: string }
  | { readonly do: 'advance'; readonly toStage: number }
  | { readonly do: 'finished' }
  | { readonly do: 'roll-back'; readonly why: string };

/**
 * What the rollout does next (checked every few minutes). Crashes rising rolls back at once, even
 * before the hold time is up; otherwise the next stage after the hold, with enough screen-hours seen.
 */
export function nextStep(
  o: {
    readonly stage: number;
    readonly stageSince: number;
    readonly now: number;
    readonly fresh: VersionStats;
    readonly old: VersionStats;
  },
  rules: RolloutRules = DEFAULT_ROLLOUT_RULES,
): RolloutStep {
  const rate = (s: VersionStats) => (s.screenHours > 0 ? s.crashes / s.screenHours : 0);
  const fresh = rate(o.fresh);
  const old = rate(o.old);
  // Judged once there is enough to judge, or at once when crashes alone already pass the line on
  // the least screen-hours that could count (a version that crashes everywhere is not waited on).
  const enough = o.fresh.screenHours >= rules.minScreenHours;
  const tooMany =
    o.fresh.crashes >= rules.minCrashes &&
    o.fresh.crashes > rules.maxCrashRate * Math.max(o.fresh.screenHours, rules.minScreenHours);
  if (tooMany || (enough && fresh > rules.maxCrashRate))
    return { do: 'roll-back', why: `crashes ${fresh.toFixed(3)}/screen-hour on the new version` };
  if (enough && old > 0 && fresh > old * rules.maxCrashRatio)
    return {
      do: 'roll-back',
      why: `crashes ${fresh.toFixed(3)}/screen-hour against ${old.toFixed(3)} on the old version`,
    };
  const last = rules.stagesBp.length - 1;
  if (o.stage >= last && enough && o.now - o.stageSince >= rules.holdMs) return { do: 'finished' };
  if (o.stage >= last) return { do: 'hold', why: 'at every screen, watching' };
  if (o.now - o.stageSince < rules.holdMs) return { do: 'hold', why: 'waiting out the stage' };
  if (!enough) return { do: 'hold', why: 'not enough screen-hours yet' };
  return { do: 'advance', toStage: o.stage + 1 };
}

// ---------------------------------------------------------------- the message to the box

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[0-9A-Za-z.+-]{1,40}$/;
/** Largest player file. */
export const MAX_APK_BYTES = 200 * 1024 * 1024;

const isWhole = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;

/** What is wrong with an update message, or undefined when the box will take it. */
export function updateProblem(x: unknown): string | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'not an update';
  const u = x as Record<string, unknown>;
  const keys = ['v', 'made', 'versionCode', 'versionName', 'sha256', 'bytes', 'url'];
  if (Object.keys(u).length !== keys.length || !keys.every((k) => Object.hasOwn(u, k)))
    return 'not an update';
  if (u.v !== 1) return 'unknown version';
  if (!isWhole(u.made, 1)) return 'bad time';
  if (!isWhole(u.versionCode, 1, 2_100_000_000)) return 'bad version code';
  if (typeof u.versionName !== 'string' || !NAME.test(u.versionName)) return 'bad version name';
  if (typeof u.sha256 !== 'string' || !SHA256.test(u.sha256)) return 'bad fingerprint';
  if (!isWhole(u.bytes, 1, MAX_APK_BYTES)) return 'bad size';
  if (typeof u.url !== 'string' || !/^https:\/\/[\x21-\x7e]{1,2000}$/.test(u.url))
    return 'bad link';
  return undefined;
}

/** The exact text of an update message. Throws on what the box would refuse. */
export function updateText(apk: ApkFile, madeMs: number): string {
  const text = JSON.stringify({
    v: 1,
    made: madeMs,
    versionCode: apk.versionCode,
    versionName: apk.versionName,
    sha256: apk.sha256,
    bytes: apk.bytes,
    url: apk.url,
  });
  const problem = updateProblem(JSON.parse(text));
  if (problem) throw new RangeError(`update: ${problem}`);
  return text;
}

/** A release is sound: the rollback build is numbered above the new one, both files well formed. */
export function releaseProblem(r: Release): string | undefined {
  for (const f of [r.apk, r.rollback]) {
    const p = updateProblem({ v: 1, made: 1, ...f });
    if (p) return p;
  }
  if (r.rollback.versionCode <= r.apk.versionCode)
    return 'the rollback build must be numbered above the new one';
  return undefined;
}
