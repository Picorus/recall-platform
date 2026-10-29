// P3.17: settings in the database. Each save is a new version of one setting, with who and why; the
// newest is in force; until one is saved, the default is (version 0).
import {
  checkSetting,
  checkSettingChange,
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;

/** The same value, whatever order its fields come in (the database keeps them in its own order). */
const same = (a: unknown, b: unknown): boolean => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : typeof v === 'object' && v !== null
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([x], [y]) => (x < y ? -1 : 1))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

export interface SettingRecord<K extends SettingKey = SettingKey> {
  readonly value: Settings[K];
  /** 0: the default, never saved. */
  readonly version: number;
  readonly savedBy: string | null;
  readonly savedAt: number | null;
  readonly reason: string | null;
}

export type SettingRecords = { readonly [K in SettingKey]: SettingRecord<K> };

/** Every setting in force, with its version and who saved it. */
export async function settingRecords(c: Q): Promise<SettingRecords> {
  const r = await c.query<{
    key: SettingKey;
    version: number;
    value: unknown;
    saved_by: string;
    saved_at: Date;
    reason: string;
  }>(
    `SELECT DISTINCT ON (key) key, version, value, saved_by, saved_at, reason
       FROM settings ORDER BY key, version DESC`,
  );
  const out: Record<string, SettingRecord> = {};
  for (const k of SETTING_KEYS)
    out[k] = { value: DEFAULT_SETTINGS[k], version: 0, savedBy: null, savedAt: null, reason: null };
  for (const x of r.rows) {
    // A setting that was replaced (payZone, P1.7.5) stays in the table as history only.
    if (!(SETTING_KEYS as readonly string[]).includes(x.key)) continue;
    out[x.key] = {
      value: withNewRules(x.key as SettingKey, x.value as Settings[SettingKey]),
      version: x.version,
      savedBy: x.saved_by,
      savedAt: x.saved_at.getTime() / 1000,
      reason: x.reason,
    };
  }
  return out as unknown as SettingRecords;
}

/** One setting in force. */
export async function setting<K extends SettingKey>(c: Q, key: K): Promise<Settings[K]> {
  const r = await c.query<{ value: Settings[K] }>(
    'SELECT value FROM settings WHERE key = $1 ORDER BY version DESC LIMIT 1',
    [key],
  );
  const v = r.rows[0]?.value;
  return v === undefined ? DEFAULT_SETTINGS[key] : withNewRules(key, v);
}

/**
 * A saved version from before a rule was added (P4.2, P4.3 added rider-app limits) gets that rule
 * at its default, so no limit is ever missing.
 */
function withNewRules<K extends SettingKey>(key: K, v: Settings[K]): Settings[K] {
  if (key === 'riderSignIn') return { ...DEFAULT_SETTINGS.riderSignIn, ...v } as Settings[K];
  if (key === 'brandSignIn') return { ...DEFAULT_SETTINGS.brandSignIn, ...v } as Settings[K];
  // P5.11 added two message wordings: a version saved before has them at their default.
  if (key === 'messages') return { ...DEFAULT_SETTINGS.messages, ...v } as Settings[K];
  return v;
}

/**
 * A super admin saves a new version of one setting. `version` is the one they were looking at: if
 * someone saved since, it is refused (reload, so nobody's change is lost unseen). Returns the new
 * version.
 */
export async function saveSetting<K extends SettingKey>(
  pool: Pool,
  key: K,
  value: unknown,
  by: { readonly id: string; readonly role: string },
  reason: string,
  version: number,
): Promise<number> {
  if (by.role !== 'super-admin') throw new Refusal('Only a super admin changes settings');
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Refusal('Which setting?');
  const why = reason.trim();
  if (why.length < 5 || why.length > 300) throw new Refusal('Why: 5 to 300 letters');
  let next: Settings[K];
  try {
    next = checkSetting(key, value);
  } catch (e) {
    throw new Refusal(e instanceof Error ? e.message : String(e));
  }
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('settings:' || $1))", [key]);
    const now = (await settingRecords(c))[key] as SettingRecord<K>;
    if (now.version !== version)
      throw new Refusal('Someone saved this setting meanwhile: reload to see their change');
    try {
      checkSettingChange(key, now.value, next);
    } catch (e) {
      throw new Refusal(e instanceof Error ? e.message : String(e));
    }
    if (same(now.value, next)) throw new Refusal('Nothing changes');
    const zone = key === 'pocZone' || key === 'regularZone' ? (next as Settings['pocZone']) : null;
    if (zone?.kind === 'areas') {
      const ids = zone.areaIds;
      const known = await c.query<{ area_id: string }>(
        'SELECT DISTINCT area_id FROM area_versions WHERE area_id = ANY($1) AND NOT draft',
        [ids],
      );
      const have = new Set(known.rows.map((x) => x.area_id));
      const missing = ids.filter((i) => !have.has(i));
      if (missing.length > 0)
        throw new Refusal(`Pay zone: no published area ${missing.join(', ')}`);
    }
    if (key === 'poc')
      await checkPocChange(c, now.value as Settings['poc'], next as Settings['poc']);
    await c.query(
      `INSERT INTO settings (key, version, value, saved_by, reason)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [key, now.version + 1, JSON.stringify(next), by.id, why],
    );
    return now.version + 1;
  });
}

/**
 * P7.8: the most brands sets every bike's rotation (slots, and the 5 plays each): it cannot change
 * while the POC runs (screens and counting would disagree mid-hour), and never below the brands a
 * month already has (a paid brand would drop out of the plan).
 */
async function checkPocChange(
  c: Q,
  before: Settings['poc'],
  after: Settings['poc'],
): Promise<void> {
  if (before.maxBrands === after.maxBrands) return;
  const on = await c.query<{ mode: string }>(
    `SELECT mode FROM business_modes m WHERE from_at <= now()
        AND NOT EXISTS (SELECT 1 FROM business_mode_cancels x WHERE x.mode_id = m.id)
      ORDER BY from_at DESC, id DESC LIMIT 1`,
  );
  if (on.rows[0]?.mode === 'poc')
    throw new Refusal(
      'The most brands cannot change while the POC runs: it sets every bike’s rotation',
    );
  const most = await c.query<{ month: string; n: string }>(
    `SELECT month, count(*) AS n FROM poc_months_in_force
      GROUP BY month ORDER BY count(*) DESC LIMIT 1`,
  );
  const m = most.rows[0];
  if (m && Number(m.n) > after.maxBrands)
    throw new Refusal(`${m.month} already has ${m.n} POC brands: the most cannot go below that`);
}
