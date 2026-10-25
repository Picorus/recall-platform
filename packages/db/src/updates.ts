// P2.13 in the database: player releases, their rollout (1% → 10% → all, rolled back by itself when
// crashes rise), and which file each screen should be offered when its line opens.
import {
  DEFAULT_ROLLOUT_RULES,
  inStage,
  nextStep,
  releaseProblem,
  updateText,
  type ApkFile,
  type Release,
  type RolloutRules,
  type VersionStats,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';

type Q = Pick<PoolClient, 'query'>;
type State = 'started' | 'advanced' | 'finished' | 'rolled-back' | 'replaced';

interface Row {
  id: string;
  version_code: number;
  version_name: string;
  sha256: string;
  bytes: number;
  url: string;
  rb_version_code: number;
  rb_version_name: string;
  rb_sha256: string;
  rb_bytes: number;
  rb_url: string;
}

const release = (r: Row): Release => ({
  id: r.id,
  apk: {
    versionCode: r.version_code,
    versionName: r.version_name,
    sha256: r.sha256,
    bytes: r.bytes,
    url: r.url,
  },
  rollback: {
    versionCode: r.rb_version_code,
    versionName: r.rb_version_name,
    sha256: r.rb_sha256,
    bytes: r.rb_bytes,
    url: r.rb_url,
  },
});

async function event(
  c: Q,
  releaseId: string,
  kind: State,
  stage: number,
  atMs: number,
  why: string,
  by: string,
) {
  await c.query(
    `INSERT INTO release_events (release_id, kind, stage, at, why, by)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6)`,
    [releaseId, kind, stage, atMs, why.slice(0, 300), by],
  );
}

/** The newest release that is not replaced, with where its rollout stands. */
async function current(
  c: Q,
): Promise<{ release: Release; state: State; stage: number; since: number } | undefined> {
  const r = await c.query<Row & { kind: State; stage: number; since: string }>(
    `SELECT p.*, e.kind, e.stage, (extract(epoch FROM e.at) * 1000)::bigint AS since
       FROM player_releases p
       JOIN LATERAL (SELECT kind, stage, at FROM release_events WHERE release_id = p.id
                      ORDER BY id DESC LIMIT 1) e ON true
      WHERE e.kind <> 'replaced'
      ORDER BY p.version_code DESC LIMIT 1`,
  );
  const x = r.rows[0];
  return x
    ? { release: release(x), state: x.kind, stage: x.stage, since: Number(x.since) }
    : undefined;
}

/** Adds a release and starts its rollout at the first stage; a rollout still running is replaced. */
export async function addRelease(
  pool: Pool,
  r: Release,
  by: string,
  notes: string,
  nowMs: number,
): Promise<void> {
  const problem = releaseProblem(r);
  if (problem) throw new RangeError(`release: ${problem}`);
  await inTransaction(pool, async (c) => {
    const running = await current(c);
    if (running && r.apk.versionCode <= running.release.rollback.versionCode)
      throw new RangeError('a new release must be numbered above the last one and its rollback');
    if (running)
      await event(c, running.release.id, 'replaced', running.stage, nowMs, `by ${r.id}`, by);
    const a = r.apk;
    const b = r.rollback;
    await c.query(
      `INSERT INTO player_releases (id, version_code, version_name, sha256, bytes, url,
         rb_version_code, rb_version_name, rb_sha256, rb_bytes, rb_url, made_at, by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), $13, $14)`,
      [
        r.id,
        a.versionCode,
        a.versionName,
        a.sha256,
        a.bytes,
        a.url,
        b.versionCode,
        b.versionName,
        b.sha256,
        b.bytes,
        b.url,
        nowMs,
        by,
        notes,
      ],
    );
    await event(c, r.id, 'started', 0, nowMs, 'first stage', by);
  });
}

/**
 * The update message for a screen running version code `appCode` (null: not known yet), or
 * undefined when it should stay as it is. A screen on a release that was rolled back gets the
 * rollback build; one in the release's current stage, on an older version, gets the release.
 */
export async function updateFor(
  pool: Pick<Pool, 'query'>,
  screenId: string,
  appCode: number | null,
  nowMs: number,
  rules: RolloutRules = DEFAULT_ROLLOUT_RULES,
): Promise<string | undefined> {
  const now = await current(pool);
  if (!now || appCode === null) return undefined;
  const { release: r, state, stage } = now;
  const send = (f: ApkFile) => updateText(f, nowMs);
  if (state === 'rolled-back') return appCode === r.apk.versionCode ? send(r.rollback) : undefined;
  const share = state === 'finished' ? 10_000 : (rules.stagesBp[stage] ?? 10_000);
  if (appCode < r.apk.versionCode && inStage(screenId, r.id, share)) return send(r.apk);
  return undefined;
}

/** The version code a screen last reported (its latest health report), or null. */
export async function lastAppCode(
  pool: Pick<Pool, 'query'>,
  screenId: string,
): Promise<number | null> {
  const r = await pool.query<{ app_code: number | null }>(
    `SELECT app_code FROM screen_health WHERE screen_id = $1 AND app_code IS NOT NULL
      ORDER BY t DESC LIMIT 1`,
    [screenId],
  );
  return r.rows[0]?.app_code ?? null;
}

/** Screen-hours and crashes since `sinceMs` on the versions `codes` picks (from health reports). */
async function stats(c: Q, sinceMs: number, fresh: boolean, code: number): Promise<VersionStats> {
  const r = await c.query<{ minutes: string; crashes: string }>(
    `WITH h AS (
       SELECT screen_id, t, app_code, crashes,
              lag(app_code) OVER w AS prev_code, lag(crashes) OVER w AS prev_crashes
         FROM screen_health
        WHERE t >= to_timestamp($1 / 1000.0) AND app_code IS NOT NULL
       WINDOW w AS (PARTITION BY screen_id ORDER BY t))
     SELECT count(*) AS minutes,
            coalesce(sum(CASE WHEN prev_code = app_code AND crashes > prev_crashes
                              THEN crashes - prev_crashes ELSE 0 END), 0) AS crashes
       FROM h WHERE CASE WHEN $2 THEN app_code = $3 ELSE app_code < $3 END`,
    [sinceMs, fresh, code],
  );
  const x = r.rows[0];
  return { screenHours: Number(x?.minutes ?? 0) / 60, crashes: Number(x?.crashes ?? 0) };
}

/**
 * Moves the running rollout on, or rolls it back, by its rules (a worker runs this every few
 * minutes). Returns what was done, or undefined when there is nothing running.
 */
export async function driveRollout(
  pool: Pool,
  nowMs: number,
  rules: RolloutRules = DEFAULT_ROLLOUT_RULES,
): Promise<string | undefined> {
  return inTransaction(pool, async (c) => {
    const now = await current(c);
    if (!now || (now.state !== 'started' && now.state !== 'advanced')) return undefined;
    const code = now.release.apk.versionCode;
    const step = nextStep(
      {
        stage: now.stage,
        stageSince: now.since,
        now: nowMs,
        fresh: await stats(c, now.since, true, code),
        old: await stats(c, now.since, false, code),
      },
      rules,
    );
    const id = now.release.id;
    if (step.do === 'advance')
      await event(c, id, 'advanced', step.toStage, nowMs, 'stage passed', 'rollout');
    if (step.do === 'finished')
      await event(
        c,
        id,
        'finished',
        now.stage,
        nowMs,
        'every screen, no rise in crashes',
        'rollout',
      );
    if (step.do === 'roll-back')
      await event(c, id, 'rolled-back', now.stage, nowMs, step.why, 'rollout');
    return step.do === 'hold' ? `hold: ${step.why}` : step.do;
  });
}

/** Where the rollout stands, for admin (P3). */
export async function rolloutStatus(
  pool: Pick<Pool, 'query'>,
): Promise<{ releaseId: string; state: State; stage: number; since: number } | undefined> {
  const now = await current(pool);
  return now && { releaseId: now.release.id, state: now.state, stage: now.stage, since: now.since };
}
