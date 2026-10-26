// P3.11.1 in the database: riders (details as versions, latest wins), their steps with who and why,
// the documents they send and each review, notes, and one rider's page.
import { fileKey, type FileStore } from '@recall/adapters';
import {
  approvalChecklist,
  DOCUMENT_NAMES,
  documentFileType,
  DOCUMENT_CONTENT_TYPE,
  MAX_DOCUMENT_BYTES,
  RIDER_DOCUMENTS,
  riderIdOf,
  riderProblems,
  riderStepProblem,
  type CheckItem,
  type DocumentFileType,
  type DocumentState,
  type RiderApp,
  type RiderDetails,
  type RiderDocumentKind,
  type RiderFacts,
  type RiderStatus,
} from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RiderRow extends RiderDetails {
  readonly riderId: string;
  readonly status: RiderStatus;
  readonly version: number;
  readonly createdAt: number;
}

const LATEST = `
  SELECT r.rider_id, r.created_at, v.version, v.name, v.phone, v.bike_plate, v.rides, v.apps,
         s.status
    FROM riders r
    JOIN LATERAL (SELECT * FROM rider_versions x WHERE x.rider_id = r.rider_id
                   ORDER BY version DESC LIMIT 1) v ON true
    JOIN LATERAL (SELECT status FROM rider_steps x WHERE x.rider_id = r.rider_id
                   ORDER BY seq DESC LIMIT 1) s ON true`;

interface LatestRow {
  rider_id: string;
  created_at: Date;
  version: number;
  name: string;
  phone: string;
  bike_plate: string | null;
  rides: string;
  apps: RiderApp[];
  status: RiderStatus;
}
const toRider = (r: LatestRow): RiderRow => ({
  riderId: r.rider_id,
  status: r.status,
  version: r.version,
  createdAt: secs(r.created_at),
  name: r.name,
  phone: r.phone,
  bikePlate: r.bike_plate,
  rides: r.rides,
  apps: r.apps,
});

const reasonOk = (reason: string) => {
  const r = reason.trim();
  if (r.length < 3 || r.length > 300 || CONTROL.test(r))
    throw new Refusal('Say why (3 to 300 letters)');
  return r;
};

/** Refuses details that do not pass, or a phone or plate another rider already has. */
async function checkDetails(c: Q, d: RiderDetails, riderId: string | null): Promise<void> {
  const problems = riderProblems(d);
  if (problems.length) throw new Refusal(problems.join('; '));
  const taken = await c.query<{ rider_id: string; phone: string; bike_plate: string | null }>(
    `SELECT rider_id, phone, bike_plate FROM (${LATEST}) l
      WHERE (l.phone = $1 OR (l.bike_plate IS NOT NULL AND l.bike_plate = $2))
        AND l.rider_id IS DISTINCT FROM $3 LIMIT 1`,
    [d.phone, d.bikePlate, riderId],
  );
  const t = taken.rows[0];
  if (t)
    throw new Refusal(
      t.phone === d.phone
        ? `This phone is already rider ${t.rider_id}`
        : `This number plate is already rider ${t.rider_id}`,
    );
}

const lockRiders = (c: PoolClient) => c.query("SELECT pg_advisory_xact_lock(hashtext('riders'))");

const insertVersion = (
  c: PoolClient,
  id: string,
  v: number,
  d: RiderDetails,
  by: string,
  reason: string,
  now: number,
) =>
  c.query(
    `INSERT INTO rider_versions (rider_id, version, name, phone, bike_plate, rides, apps, reason,
                                 set_by, set_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
    [id, v, d.name.trim(), d.phone, d.bikePlate, d.rides.trim(), d.apps, reason, by, now],
  );

/** A new rider (an application): applied, with why. Phone and plate belong to one rider each. */
export async function createRider(
  pool: Pool,
  a: {
    readonly details: RiderDetails;
    readonly channel: 'app' | 'admin';
    readonly by: string;
    readonly reason: string;
  },
  now: number,
): Promise<string> {
  const reason = reasonOk(a.reason);
  return inTransaction(pool, async (c) => {
    // One at a time: two riders can never take the same phone or plate.
    await lockRiders(c);
    await checkDetails(c, a.details, null);
    const n = await c.query<{ n: string }>("SELECT nextval('rider_numbers') AS n");
    const id = riderIdOf(Number(n.rows[0]?.n));
    await c.query(
      `INSERT INTO riders (rider_id, channel, created_by, created_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [id, a.channel, a.by, now],
    );
    await insertVersion(c, id, 1, a.details, a.by, reason, now);
    await c.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       VALUES ($1, 1, 'applied', $2, $3, to_timestamp($4))`,
      [id, reason, a.by, now],
    );
    return id;
  });
}

/** New details for a rider (the next version), with why. */
export async function reviseRider(
  pool: Pool,
  riderId: string,
  details: RiderDetails,
  by: string,
  reason: string,
  now: number,
): Promise<number> {
  const why = reasonOk(reason);
  return inTransaction(pool, async (c) => {
    await lockRiders(c);
    const r = await c.query<{ v: number }>(
      'SELECT max(version) AS v FROM rider_versions WHERE rider_id = $1',
      [riderId],
    );
    const v = r.rows[0]?.v;
    if (!v) throw new Refusal(`No rider ${riderId}`);
    await checkDetails(c, details, riderId);
    await insertVersion(c, riderId, v + 1, details, by, why, now);
    return v + 1;
  });
}

/** Riders, newest first: by status, and by name, phone, id or plate. */
export async function riderList(
  pool: Q,
  f: { readonly status?: RiderStatus; readonly q?: string },
): Promise<RiderRow[]> {
  const q = (f.q ?? '').trim();
  const digits = q.replace(/\D/g, '');
  const r = await pool.query<LatestRow>(
    `SELECT * FROM (${LATEST}) l
      WHERE ($1::text IS NULL OR l.status = $1)
        AND ($2 = '' OR l.name ILIKE '%' || $2 || '%' OR l.rider_id ILIKE '%' || $2 || '%'
             OR coalesce(l.bike_plate, '') ILIKE '%' || replace(upper($2), ' ', '') || '%'
             OR ($3 <> '' AND l.phone LIKE '%' || $3 || '%'))
      ORDER BY l.created_at DESC, l.rider_id DESC LIMIT 200`,
    [f.status ?? null, q.replace(/[%_\\]/g, ''), digits.length >= 4 ? digits : ''],
  );
  return r.rows.map(toRider);
}

/** Is a screen fitted to this rider now (the latest fitting of a screen he ever had)? */
async function screenFittedTo(c: Q, riderId: string, now: number): Promise<string | null> {
  const r = await c.query<{ screen_id: string }>(
    `SELECT f.screen_id FROM (
       SELECT DISTINCT ON (screen_id) screen_id, rider_id FROM screen_fittings
        WHERE screen_id IN (SELECT screen_id FROM screen_fittings WHERE rider_id = $1)
          AND from_at <= to_timestamp($2)
        ORDER BY screen_id, from_at DESC) f
      WHERE f.rider_id = $1 LIMIT 1`,
    [riderId, now],
  );
  return r.rows[0]?.screen_id ?? null;
}

export interface RiderDocument {
  readonly docId: string;
  readonly kind: RiderDocumentKind;
  readonly fileKey: string;
  readonly fileType: DocumentFileType;
  readonly bytes: number;
  readonly uploadedBy: string;
  readonly uploadedAt: number;
  readonly review: {
    readonly decision: 'accepted' | 'rejected';
    readonly reason: string;
    readonly expiresOn: string | null;
    readonly by: string;
    readonly at: number;
  } | null;
}

interface DocRow {
  doc_id: string;
  kind: RiderDocumentKind;
  file_key: string;
  file_type: DocumentFileType;
  bytes: string;
  uploaded_by: string;
  uploaded_at: Date;
  decision: 'accepted' | 'rejected' | null;
  reason: string | null;
  expires_on: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}
const toDoc = (r: DocRow): RiderDocument => ({
  docId: r.doc_id,
  kind: r.kind,
  fileKey: r.file_key,
  fileType: r.file_type,
  bytes: Number(r.bytes),
  uploadedBy: r.uploaded_by,
  uploadedAt: secs(r.uploaded_at),
  review:
    r.decision && r.reviewed_by && r.reviewed_at
      ? {
          decision: r.decision,
          reason: r.reason ?? '',
          expiresOn: r.expires_on,
          by: r.reviewed_by,
          at: secs(r.reviewed_at),
        }
      : null,
});

async function documentsOf(c: Q, riderId: string): Promise<RiderDocument[]> {
  const r = await c.query<DocRow>(
    `SELECT d.doc_id, d.kind, d.file_key, d.file_type, d.bytes, d.uploaded_by, d.uploaded_at,
            v.decision, v.reason, v.expires_on::text AS expires_on, v.reviewed_by, v.reviewed_at
       FROM rider_documents d LEFT JOIN rider_document_reviews v USING (doc_id)
      WHERE d.rider_id = $1 ORDER BY d.seq DESC`,
    [riderId],
  );
  return r.rows.map(toDoc);
}

/** What the rules read: status, details, the newest document of each kind, a screen fitted. */
async function factsOf(c: Q, riderId: string, now: number): Promise<RiderFacts | undefined> {
  const r = await c.query<LatestRow>(`SELECT * FROM (${LATEST}) l WHERE l.rider_id = $1`, [
    riderId,
  ]);
  const row = r.rows[0];
  if (!row) return undefined;
  const docs = await documentsOf(c, riderId);
  const documents: DocumentState[] = RIDER_DOCUMENTS.flatMap((kind) => {
    const d = docs.find((x) => x.kind === kind);
    return d
      ? [{ kind, decision: d.review?.decision ?? null, expiresOn: d.review?.expiresOn ?? null }]
      : [];
  });
  const rider = toRider(row);
  return {
    status: rider.status,
    details: rider,
    documents,
    screenFitted: (await screenFittedTo(c, riderId, now)) !== null,
  };
}

/** Moves a rider to his next step if the rules allow it now; logs who and why. */
export async function stepRider(
  pool: Pool,
  riderId: string,
  to: RiderStatus,
  by: string,
  reason: string,
  now: number,
): Promise<void> {
  await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider:${riderId}`]);
    const f = await factsOf(c, riderId, now);
    if (!f) throw new Refusal(`No rider ${riderId}`);
    const problem = riderStepProblem(f, to, reason, now);
    if (problem) throw new Refusal(problem);
    await c.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, to_timestamp($5)
         FROM rider_steps WHERE rider_id = $1`,
      [riderId, to, reason.trim(), by, now],
    );
  });
}

/**
 * A document from a rider (sent from his phone, or by Operations for him): read from its own bytes
 * (a picture or a PDF, at most 10 MB), recorded, and stored by fingerprint in the same transaction
 * (if either fails, neither is kept). It waits for a look.
 */
export async function uploadRiderDocument(
  pool: Pool,
  store: FileStore,
  a: {
    readonly riderId: string;
    readonly kind: string;
    readonly data: Uint8Array;
    readonly by: string;
  },
  now: number,
): Promise<RiderDocument> {
  if (!(RIDER_DOCUMENTS as readonly string[]).includes(a.kind))
    throw new Refusal('Which document? (photo, rc or insurance)');
  if (a.data.length === 0 || a.data.length > MAX_DOCUMENT_BYTES)
    throw new Refusal('A document is at most 10 MB');
  const type = documentFileType(a.data);
  if (!type) throw new Refusal('Send a photo (JPEG, PNG, WebP) or a PDF');
  if (a.kind === 'photo' && type === 'pdf') throw new Refusal('His photo must be a picture');
  const key = fileKey(a.data);
  const docId = `DOC-${randomBytes(5).toString('hex').toUpperCase()}`;
  return inTransaction(pool, async (c) => {
    const r = await c.query<{ n: number }>('SELECT 1 AS n FROM riders WHERE rider_id = $1', [
      a.riderId,
    ]);
    if (!r.rows[0]) throw new Refusal(`No rider ${a.riderId}`);
    await c.query(
      `INSERT INTO rider_documents (doc_id, rider_id, kind, file_key, file_type, bytes, uploaded_by,
                                    uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
      [docId, a.riderId, a.kind, key, type, a.data.length, a.by, now],
    );
    const stored = await store.put(a.data, DOCUMENT_CONTENT_TYPE[type]);
    if (stored.key !== key) throw new Error('the file store keyed the file differently');
    const doc = (await documentsOf(c, a.riderId)).find((d) => d.docId === docId);
    if (!doc) throw new Error('document not saved');
    return doc;
  });
}

/** A real calendar date "YYYY-MM-DD". */
const isDay = (x: string) =>
  /^20\d{2}-\d{2}-\d{2}$/.test(x) && new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;

/**
 * One look at a document, final: accepted (insurance: with the last day it covers) or rejected with
 * why (the rider sends a new one).
 */
export async function reviewRiderDocument(
  pool: Pool,
  r: {
    readonly riderId: string;
    readonly docId: string;
    readonly decision: 'accepted' | 'rejected';
    readonly reason: string;
    readonly expiresOn: string | null;
    readonly by: string;
  },
  now: number,
): Promise<void> {
  const reason = reasonOk(r.reason);
  await inTransaction(pool, async (c) => {
    const d = await c.query<{ kind: RiderDocumentKind }>(
      'SELECT kind FROM rider_documents WHERE doc_id = $1 AND rider_id = $2',
      [r.docId, r.riderId],
    );
    const kind = d.rows[0]?.kind;
    if (!kind) throw new Refusal(`No document ${r.docId} for ${r.riderId}`);
    let expires: string | null = null;
    if (r.decision === 'accepted' && kind === 'insurance') {
      if (!r.expiresOn || !isDay(r.expiresOn))
        throw new Refusal('Give the last day the insurance covers (YYYY-MM-DD)');
      expires = r.expiresOn;
    }
    const saved = await c.query(
      `INSERT INTO rider_document_reviews (doc_id, decision, reason, expires_on, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4::date, $5, to_timestamp($6)) ON CONFLICT (doc_id) DO NOTHING`,
      [r.docId, r.decision, reason, expires, r.by, now],
    );
    if (!saved.rowCount) throw new Refusal('This document was already looked at');
  });
}

/** A note on a rider (who and when kept). */
export async function addRiderNote(
  pool: Pool,
  riderId: string,
  note: string,
  by: string,
  now: number,
): Promise<void> {
  const text = note.trim();
  if (text.length < 1 || text.length > 2000) throw new Refusal('A note is 1 to 2,000 letters');
  await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider:${riderId}`]);
    const r = await c.query('SELECT 1 FROM riders WHERE rider_id = $1', [riderId]);
    if (!r.rowCount) throw new Refusal(`No rider ${riderId}`);
    await c.query(
      `INSERT INTO rider_notes (rider_id, seq, note, by_who, at)
       SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, to_timestamp($4)
         FROM rider_notes WHERE rider_id = $1`,
      [riderId, text, by, now],
    );
  });
}

export interface RiderPage {
  readonly rider: RiderRow;
  readonly channel: 'app' | 'admin';
  readonly checklist: readonly CheckItem[];
  /** The screen fitted to him now, if any. */
  readonly screenId: string | null;
  readonly documents: readonly RiderDocument[];
  /** Everything that happened, newest first: steps, details changed, documents, reviews, notes. */
  readonly timeline: readonly { readonly at: number; readonly by: string; readonly text: string }[];
}

/** One rider's page. */
export async function riderPage(
  pool: Q,
  riderId: string,
  now: number,
): Promise<RiderPage | undefined> {
  const facts = await factsOf(pool, riderId, now);
  if (!facts) return undefined;
  const [row, base, steps, versions, notes, documents, screenId] = await Promise.all([
    pool.query<LatestRow>(`SELECT * FROM (${LATEST}) l WHERE l.rider_id = $1`, [riderId]),
    pool.query<{ channel: 'app' | 'admin' }>('SELECT channel FROM riders WHERE rider_id = $1', [
      riderId,
    ]),
    pool.query<{ seq: number; status: string; reason: string; by_who: string; at: Date }>(
      'SELECT seq, status, reason, by_who, at FROM rider_steps WHERE rider_id = $1',
      [riderId],
    ),
    pool.query<{ version: number; reason: string; set_by: string; set_at: Date }>(
      'SELECT version, reason, set_by, set_at FROM rider_versions WHERE rider_id = $1 AND version > 1',
      [riderId],
    ),
    pool.query<{ note: string; by_who: string; at: Date }>(
      'SELECT note, by_who, at FROM rider_notes WHERE rider_id = $1',
      [riderId],
    ),
    documentsOf(pool, riderId),
    screenFittedTo(pool, riderId, now),
  ]);
  const rider = row.rows[0];
  if (!rider) return undefined;
  const STEP: Record<string, string> = {
    applied: 'Applied',
    approved: 'Approved',
    rejected: 'Rejected',
    active: 'Riding (active)',
    paused: 'Paused',
    left: 'Left RECALL',
  };
  const events = [
    ...steps.rows.map((s) => ({
      at: secs(s.at),
      by: s.by_who,
      text: `${STEP[s.status] ?? s.status}: ${s.reason}`,
      order: s.seq,
    })),
    ...versions.rows.map((v) => ({
      at: secs(v.set_at),
      by: v.set_by,
      text: `Details changed: ${v.reason}`,
      order: 0,
    })),
    ...documents.flatMap((d) => [
      { at: d.uploadedAt, by: d.uploadedBy, text: `Sent: ${DOCUMENT_NAMES[d.kind]}`, order: 0 },
      ...(d.review
        ? [
            {
              at: d.review.at,
              by: d.review.by,
              text: `${DOCUMENT_NAMES[d.kind]} ${d.review.decision}: ${d.review.reason}`,
              order: 0,
            },
          ]
        : []),
    ]),
    ...notes.rows.map((n) => ({ at: secs(n.at), by: n.by_who, text: `Note: ${n.note}`, order: 0 })),
  ].sort((a, b) => b.at - a.at || b.order - a.order);
  return {
    rider: toRider(rider),
    channel: base.rows[0]?.channel ?? 'admin',
    checklist: approvalChecklist(facts, now),
    screenId,
    documents,
    timeline: events.map(({ at, by, text }) => ({ at, by, text })),
  };
}
