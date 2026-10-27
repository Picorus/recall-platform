// P5.9 in the database: the brand portal's Help and Team. A question goes to the support desk as a
// conversation about the business (replies go back by WhatsApp or email, P3.15); questions are
// limited per person per day. A business's owner adds and removes its people (owner or "can book"),
// never themselves; every change is a new version with who and why (hard rule 3).
import type { BrandMemberRole, BrandSignInRules } from '@recall/domain';
import type { Pool } from 'pg';
import { lockMembers, portalMembers, setMemberIn, type PortalMember } from './brand-sign-in.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { threadFromBrandPortal } from './support.js';

type Q = Pick<Pool, 'query'>;

export interface BrandQuestion {
  readonly at: number;
  readonly subject: string;
  readonly state: 'open' | 'waiting' | 'done';
}

/** The business's latest conversations started on the portal (questions, deals), newest first;
 * conversations our staff opened about it are theirs, not shown. */
export async function brandQuestions(c: Q, brandId: string): Promise<BrandQuestion[]> {
  const r = await c.query<{ at: string; subject: string; state: string | null }>(
    `SELECT extract(epoch FROM t.created_at)::bigint AS at, t.subject,
            (SELECT state FROM support_steps s WHERE s.thread_id = t.thread_id
              ORDER BY seq DESC LIMIT 1) AS state
       FROM support_threads t
      WHERE t.party_kind = 'brand' AND t.party_id = $1 AND t.created_by = 'brand portal'
      ORDER BY t.created_at DESC LIMIT 20`,
    [brandId],
  );
  return r.rows.map((x) => ({
    at: Number(x.at),
    subject: x.subject,
    state: x.state === 'done' ? 'done' : x.state === 'waiting' ? 'waiting' : 'open',
  }));
}

/** A question from Help, to the support desk; the thread's id. */
export async function askFromPortal(
  pool: Pool,
  q: {
    readonly brandId: string;
    /** The person's number or email: replies go there. */
    readonly contact: string;
    readonly subject: string;
    readonly text: string;
  },
  now: number,
  rules: BrandSignInRules,
): Promise<string> {
  const subject = q.subject.trim();
  const text = q.text.trim();
  if (subject.length < 3 || subject.length > 120) throw new Refusal('Subject: 3 to 120 letters');
  if (text.length < 5 || text.length > 4000) throw new Refusal('Your question: 5 to 4,000 letters');
  return inTransaction(pool, async (c) => {
    // One person at a time, so the day's count is right.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`portal-questions:${q.contact}`]);
    const n = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM support_threads
        WHERE created_by = 'brand portal' AND contact = $1 AND created_at > to_timestamp($2)`,
      [q.contact, now - 86_400],
    );
    if (Number(n.rows[0]?.n ?? 0) >= rules.questionsPerDay)
      throw new Refusal('Too many questions today: call or WhatsApp us instead', {
        code: 'too-many-questions',
      });
    return threadFromBrandPortal(c, {
      brandId: q.brandId,
      contact: q.contact,
      subject,
      text,
      at: now,
    });
  });
}

/** The business's people with access now (removed ones are left out). */
export async function brandTeam(c: Q, brandId: string): Promise<PortalMember[]> {
  return (await portalMembers(c, brandId)).filter((m) => m.active);
}

/**
 * An owner adds, changes or removes one person (never themselves). Under the business's lock: the
 * one acting is still an owner, the team stays within its size, and an owner always remains (two
 * owners demoting each other at once cannot leave none).
 */
export async function setTeamMember(
  pool: Pool,
  m: {
    readonly brandId: string;
    /** The owner making the change. */
    readonly owner: string;
    readonly address: string;
    readonly role: BrandMemberRole;
    readonly active: boolean;
  },
  now: number,
  rules: BrandSignInRules,
): Promise<number> {
  if (m.address === m.owner)
    throw new Refusal('You cannot change your own access: ask another owner, or us', {
      code: 'self',
    });
  return inTransaction(pool, async (c) => {
    await lockMembers(c, m.brandId);
    const team = await brandTeam(c, m.brandId);
    if (!team.some((x) => x.address === m.owner && x.role === 'owner'))
      throw new Refusal('Only an owner changes the team', { code: 'not-owner' });
    if (m.active && !team.some((x) => x.address === m.address) && team.length >= rules.teamMax)
      throw new Refusal(`A business has at most ${rules.teamMax} people: remove someone first`, {
        code: 'team-full',
      });
    const owners =
      team.filter((x) => x.address !== m.address && x.role === 'owner').length +
      (m.active && m.role === 'owner' ? 1 : 0);
    if (owners === 0) throw new Refusal('A business always keeps an owner', { code: 'last-owner' });
    return setMemberIn(
      c,
      {
        brandId: m.brandId,
        address: m.address,
        role: m.role,
        active: m.active,
        reason: m.active
          ? 'added by its owner on the brand portal'
          : 'removed by its owner on the brand portal',
        by: `portal:${m.owner}`.slice(0, 120),
      },
      now,
    );
  });
}
