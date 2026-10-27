// P4.8 in the database: a rider reports a screen problem from the app (with a photo when he has
// one). It starts a support conversation with him (staff answer on WhatsApp, book a repair or a
// swap, and mark it done); a stolen screen is marked urgent. His reports and where each stands.
import type { FileStore } from '@recall/adapters';
import { documentFileType, DOCUMENT_CONTENT_TYPE, MAX_DOCUMENT_BYTES } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { fittedScreen } from './rider-app-fitting.js';
import { threadFromRiderApp } from './support.js';

type Q = Pick<Pool, 'query'>;

export const PROBLEM_KINDS = ['not-on', 'damage', 'theft', 'accident', 'other'] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** For staff, in the conversation's subject. */
const KIND_WORDS: Record<ProblemKind, string> = {
  'not-on': 'Screen not turning on',
  damage: 'Screen damaged',
  theft: 'URGENT: screen stolen',
  accident: 'URGENT: accident',
  other: 'Screen problem',
};

/** Reports one rider may send in a day (each opens a conversation staff must answer). */
export const PROBLEMS_PER_DAY = 5;

export async function reportScreenProblem(
  pool: Pool,
  store: FileStore | undefined,
  r: {
    readonly riderId: string;
    readonly phone: string;
    readonly kind: string;
    readonly note: string;
    readonly photo: Uint8Array | null;
  },
  now: number,
): Promise<{ readonly problemId: string; readonly threadId: string }> {
  if (!(PROBLEM_KINDS as readonly string[]).includes(r.kind))
    throw new Refusal('Which problem?', { code: 'bad-kind' });
  const kind = r.kind as ProblemKind;
  // eslint-disable-next-line no-control-regex
  const note = r.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (note.length > 1000) throw new Refusal('At most 1,000 letters', { code: 'too-long' });
  if (kind === 'other' && note.length < 3)
    throw new Refusal('Say what is wrong', { code: 'say-what' });
  let photo: { key: string; type: 'png' | 'jpeg' | 'webp' } | null = null;
  if (r.photo) {
    if (!store) throw new Refusal('Photos are not set up yet', { code: 'not-set-up' });
    if (r.photo.length === 0 || r.photo.length > MAX_DOCUMENT_BYTES)
      throw new Refusal('A photo is at most 10 MB', { code: 'too-big' });
    const type = documentFileType(r.photo);
    if (!type || type === 'pdf') throw new Refusal('Send a photo', { code: 'not-a-photo' });
    photo = { key: '', type };
  }
  const screen = await fittedScreen(pool, r.riderId, now);
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`problems:${r.riderId}`]);
    const n = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM screen_problems
        WHERE rider_id = $1 AND at > to_timestamp($2) - interval '1 day'`,
      [r.riderId, now],
    );
    if ((n.rows[0]?.n ?? 0) >= PROBLEMS_PER_DAY)
      throw new Refusal('Too many reports today: call support', { code: 'too-many-reports' });
    if (photo && r.photo && store) {
      const stored = await store.put(r.photo, DOCUMENT_CONTENT_TYPE[photo.type]);
      photo = { ...photo, key: stored.key };
    }
    const threadId = await threadFromRiderApp(c, {
      riderId: r.riderId,
      phone: r.phone,
      subject: `${KIND_WORDS[kind]} (${screen?.screenId ?? 'no screen on record'})`,
      text: [
        `${KIND_WORDS[kind]}, reported on the rider app.`,
        note && `He says: ${note}`,
        photo ? 'Photo attached (see below).' : 'No photo.',
      ]
        .filter(Boolean)
        .join('\n'),
      at: now,
    });
    const problemId = `PRB-${randomBytes(5).toString('hex').toUpperCase()}`;
    await c.query(
      `INSERT INTO screen_problems (problem_id, rider_id, screen_id, kind, note, photo_key,
         photo_type, thread_id, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
      [
        problemId,
        r.riderId,
        screen?.screenId ?? null,
        kind,
        note,
        photo?.key ?? null,
        photo?.type ?? null,
        threadId,
        now,
      ],
    );
    return { problemId, threadId };
  });
}

export interface RiderProblem {
  readonly problemId: string;
  readonly kind: ProblemKind;
  readonly at: number;
  /** Where its conversation stands: open (we are on it), waiting (on him), done. */
  readonly state: 'open' | 'waiting' | 'done';
}

/** His reports, newest first (at most 20). */
export async function riderProblems(c: Q, riderId: string): Promise<RiderProblem[]> {
  const r = await c.query<{ problem_id: string; kind: ProblemKind; at: string; state: string }>(
    `SELECT p.problem_id, p.kind, extract(epoch FROM p.at)::bigint AS at,
            (SELECT state FROM support_steps s WHERE s.thread_id = p.thread_id
              ORDER BY seq DESC LIMIT 1) AS state
       FROM screen_problems p WHERE p.rider_id = $1 ORDER BY p.at DESC LIMIT 20`,
    [riderId],
  );
  return r.rows.map((x) => ({
    problemId: x.problem_id,
    kind: x.kind,
    at: Number(x.at),
    state: x.state === 'done' ? 'done' : x.state === 'waiting' ? 'waiting' : 'open',
  }));
}

/** The problems behind a conversation, for staff (with the photo's key to link to). */
export async function problemsOfThread(c: Q, threadId: string) {
  const r = await c.query<{
    problem_id: string;
    kind: ProblemKind;
    screen_id: string | null;
    photo_key: string | null;
  }>(
    `SELECT problem_id, kind, screen_id, photo_key FROM screen_problems
      WHERE thread_id = $1 ORDER BY at`,
    [threadId],
  );
  return r.rows.map((x) => ({
    problemId: x.problem_id,
    kind: x.kind,
    screenId: x.screen_id,
    photoKey: x.photo_key,
  }));
}
