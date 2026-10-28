import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  businessModes,
  canSwitch,
  isDemoCopy,
  markDemoCopy,
  setBusinessMode,
} from '../../src/business-mode.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const day = (iso: string) => Date.parse(`${iso}T12:00:00+05:30`) / 1000;

describe('a demo copy for investors', () => {
  it('only an empty database can be marked; then the super admin can flip POC on and off freely', async () => {
    expect(await isDemoCopy(pool)).toBe(false);
    await markDemoCopy(pool, 'prateek');
    expect(await isDemoCopy(pool)).toBe(true);
    await setBusinessMode(pool, 'poc', SUPER, 'demo: POC on', day('2027-08-01'));
    await setBusinessMode(pool, 'regular', SUPER, 'demo: POC off', day('2027-08-10'), {
      early: true,
    });
    await setBusinessMode(pool, 'poc', SUPER, 'demo: POC on again', day('2027-08-20'));
    expect((await businessModes(pool)).map((c) => c.mode)).toEqual(['poc', 'regular', 'poc']);
    expect(await canSwitch(pool)).toBe(true);
    // Still the super admin only.
    await expect(
      setBusinessMode(pool, 'regular', { id: 'asha', role: 'admin' }, 'demo', day('2027-09-05')),
    ).rejects.toThrow(/super admin/);
  });
});
