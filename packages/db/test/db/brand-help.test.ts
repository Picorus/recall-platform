// P5.9: help and team in the database: a question becomes a portal conversation about the business,
// limited per person a day; "your questions" shows only those started on the portal; owners change
// the team under one lock, so two at once never leave a business with no owner or too many people.
import { DEFAULT_BRAND_SIGN_IN as R } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askFromPortal, brandQuestions, brandTeam, setTeamMember } from '../../src/brand-help.js';
import { setPortalMember } from '../../src/brand-sign-in.js';
import { createAccount } from '../../src/brands.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const A = 'a@chai.in';
const B = 'b@chai.in';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await createAccount(
    pool,
    {
      brandId: 'chai',
      kind: 'brand',
      details: { name: 'Chai', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'test',
    },
    NOW - 100,
  );
  for (const address of [A, B])
    await setPortalMember(
      pool,
      { brandId: 'chai', address, role: 'owner', active: true, reason: 'test', by: 'Sana' },
      NOW - 50,
    );
}, 60_000);
afterAll(async () => db.drop());

describe('help and team (P5.9)', () => {
  it('two owners demoting each other at once: one goes through, an owner always remains', async () => {
    const r = await Promise.allSettled([
      setTeamMember(
        pool,
        { brandId: 'chai', owner: A, address: B, role: 'booker', active: true },
        NOW,
        R,
      ),
      setTeamMember(
        pool,
        { brandId: 'chai', owner: B, address: A, role: 'booker', active: true },
        NOW,
        R,
      ),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const owners = (await brandTeam(pool, 'chai')).filter((m) => m.role === 'owner');
    expect(owners).toHaveLength(1);
    // The last owner cannot be removed by anyone: nobody may change themselves, and no other owner.
    const last = owners[0]?.address ?? '';
    await expect(
      setTeamMember(
        pool,
        { brandId: 'chai', owner: last, address: last, role: 'booker', active: false },
        NOW,
        R,
      ),
    ).rejects.toThrow(/own access/);
  });

  it('two adds at once never pass the team size', async () => {
    const rules = { ...R, teamMax: 3 };
    const owner = (await brandTeam(pool, 'chai')).find((m) => m.role === 'owner')?.address ?? '';
    const r = await Promise.allSettled(
      ['c@chai.in', 'd@chai.in'].map((address) =>
        setTeamMember(
          pool,
          { brandId: 'chai', owner, address, role: 'booker', active: true },
          NOW,
          rules,
        ),
      ),
    );
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(await brandTeam(pool, 'chai')).toHaveLength(3);
  });

  it('questions: limited per person a day; only portal conversations are listed', async () => {
    const rules = { ...R, questionsPerDay: 2 };
    const ask = (subject: string) =>
      askFromPortal(
        pool,
        { brandId: 'chai', contact: A, subject, text: 'Please call me back.' },
        NOW,
        rules,
      );
    await ask('First question');
    await ask('Second question');
    await expect(ask('Third question')).rejects.toThrow(/Too many questions today/);
    // A conversation staff opened about the brand is theirs: not shown on the portal.
    await pool.query(
      `INSERT INTO support_threads (thread_id, channel, contact, party_kind, party_id, subject, created_by, created_at)
       VALUES ('SUP-00000000AA', 'whatsapp', '+919848099999', 'brand', 'chai', 'chase late payer', 'Sana', to_timestamp($1))`,
      [NOW],
    );
    expect((await brandQuestions(pool, 'chai')).map((q) => q.subject).sort()).toEqual([
      'First question',
      'Second question',
    ]);
  });
});
