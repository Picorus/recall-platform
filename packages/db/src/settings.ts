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
  for (const x of r.rows)
    out[x.key] = {
      value: x.value as Settings[SettingKey],
      version: x.version,
      savedBy: x.saved_by,
      savedAt: x.saved_at.getTime() / 1000,
      reason: x.reason,
    };
  return out as unknown as SettingRecords;
}

/** One setting in force. */
export async function setting<K extends SettingKey>(c: Q, key: K): Promise<Settings[K]> {
  const r = await c.query<{ value: Settings[K] }>(
    'SELECT value FROM settings WHERE key = $1 ORDER BY version DESC LIMIT 1',
    [key],
  );
  return r.rows[0]?.value ?? DEFAULT_SETTINGS[key];
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
    if (key === 'payZone' && (next as Settings['payZone']).kind === 'areas') {
      const ids = (next as Extract<Settings['payZone'], { kind: 'areas' }>).areaIds;
      const known = await c.query<{ area_id: string }>(
        'SELECT DISTINCT area_id FROM area_versions WHERE area_id = ANY($1)',
        [ids],
      );
      const have = new Set(known.rows.map((x) => x.area_id));
      const missing = ids.filter((i) => !have.has(i));
      if (missing.length > 0) throw new Refusal(`Pay zone: no area ${missing.join(', ')}`);
    }
    await c.query(
      `INSERT INTO settings (key, version, value, saved_by, reason)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [key, now.version + 1, JSON.stringify(next), by.id, why],
    );
    return now.version + 1;
  });
}
