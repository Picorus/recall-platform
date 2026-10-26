// P3.8.1 in the database: brand and agency accounts (details as versions, latest wins), notes, and
// one account's page: its details' history, contacts, tax details, bookings and holds.
import { accountProblems, type AccountDetails, type AccountKind } from '@recall/domain';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

export interface Account extends AccountDetails {
  readonly brandId: string;
  readonly kind: AccountKind;
  readonly version: number;
  readonly createdAt: number;
}

export interface AccountRow extends Account {
  readonly agencyName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  /** Bookings not cancelled (drafts included), and the newest one's first hour. */
  readonly bookings: number;
  readonly lastFirstHour: number | null;
}

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

const LATEST = `
  SELECT DISTINCT ON (v.brand_id) v.brand_id, b.kind, b.created_at, v.version, v.name, v.agency_id,
         v.referred_by, v.active
    FROM brand_versions v JOIN brands b USING (brand_id)
   ORDER BY v.brand_id, v.version DESC`;

interface LatestRow {
  brand_id: string;
  kind: AccountKind;
  created_at: Date;
  version: number;
  name: string;
  agency_id: string | null;
  referred_by: string | null;
  active: boolean;
}
const toAccount = (r: LatestRow): Account => ({
  brandId: r.brand_id,
  kind: r.kind,
  version: r.version,
  createdAt: secs(r.created_at),
  name: r.name,
  agencyId: r.agency_id,
  referredBy: r.referred_by,
  active: r.active,
});

/** The latest details of one account, or undefined. */
export async function findAccount(pool: Q, id: string): Promise<Account | undefined> {
  const r = await pool.query<LatestRow>(`SELECT * FROM (${LATEST}) l WHERE l.brand_id = $1`, [id]);
  return r.rows[0] ? toAccount(r.rows[0]) : undefined;
}

async function check(pool: Q, id: string, kind: AccountKind, d: AccountDetails): Promise<void> {
  const agency = d.agencyId === null ? undefined : await findAccount(pool, d.agencyId);
  const problems = accountProblems(id, kind, d, agency?.kind);
  if (agency && !agency.active && d.agencyId !== null) problems.push(`${agency.name} is closed`);
  if (problems.length > 0) throw new Refusal(problems.join('; '));
}

/** Opens an account (Sales). Refused when the id is taken. */
export async function createAccount(
  pool: Pool,
  a: { brandId: string; kind: AccountKind; details: AccountDetails; by: string; reason: string },
  now: number,
): Promise<void> {
  await check(pool, a.brandId, a.kind, a.details);
  await inTransaction(pool, async (c) => {
    const taken = await c.query('SELECT 1 FROM brands WHERE brand_id = $1', [a.brandId]);
    if (taken.rowCount) throw new Refusal(`The id ${a.brandId} is taken`);
    await c.query(
      'INSERT INTO brands (brand_id, kind, created_by, created_at) VALUES ($1, $2, $3, to_timestamp($4))',
      [a.brandId, a.kind, a.by, now],
    );
    await c.query(
      `INSERT INTO brand_versions (brand_id, version, name, agency_id, referred_by, active, reason,
                                   set_by, set_at)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
      [
        a.brandId,
        a.details.name.trim(),
        a.details.agencyId,
        a.details.referredBy,
        a.details.active,
        a.reason,
        a.by,
        now,
      ],
    );
  });
}

/**
 * Changes an account's details as its next version. `baseVersion` is the version the person saw:
 * someone else's change since then is never overwritten unseen.
 */
export async function reviseAccount(
  pool: Pool,
  a: { brandId: string; baseVersion: number; details: AccountDetails; by: string; reason: string },
  now: number,
): Promise<number> {
  const was = await findAccount(pool, a.brandId);
  if (!was) throw new Refusal(`No account ${a.brandId}`);
  if (was.version !== a.baseVersion)
    throw new Refusal('Someone changed this account just now: reload the page and try again');
  await check(pool, a.brandId, was.kind, a.details);
  // An agency being closed must not leave brands pointing at it unseen: say which ones.
  if (was.kind === 'agency' && was.active && !a.details.active) {
    const handled = await pool.query<{ name: string }>(
      `SELECT l.name FROM (${LATEST}) l WHERE l.agency_id = $1 AND l.active ORDER BY l.name`,
      [a.brandId],
    );
    if (handled.rows.length > 0)
      throw new Refusal(
        `Move these brands to another agency first: ${handled.rows.map((r) => r.name).join(', ')}`,
      );
  }
  const next = was.version + 1;
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO brand_versions (brand_id, version, name, agency_id, referred_by, active, reason,
                                   set_by, set_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
      [
        a.brandId,
        next,
        a.details.name.trim(),
        a.details.agencyId,
        a.details.referredBy,
        a.details.active,
        a.reason,
        a.by,
        now,
      ],
    ),
  ).catch((e: unknown) => {
    if ((e as { code?: string }).code === '23505')
      throw new Refusal('Someone changed this account just now: reload the page and try again');
    throw e;
  });
  return next;
}

export async function addAccountNote(
  pool: Pool,
  brandId: string,
  note: string,
  by: string,
  now: number,
): Promise<void> {
  const text = note.trim();
  if (text.length < 1 || text.length > 2000) throw new Refusal('A note is 1 to 2,000 characters');
  if (!(await findAccount(pool, brandId))) throw new Refusal(`No account ${brandId}`);
  await inTransaction(pool, (c) =>
    c.query(
      'INSERT INTO brand_notes (brand_id, note, by, at) VALUES ($1, $2, $3, to_timestamp($4))',
      [brandId, text, by, now],
    ),
  );
}

/** Every account with its latest details, contact, GSTIN and bookings, by name. */
export async function accountList(pool: Q): Promise<AccountRow[]> {
  const r = await pool.query<
    LatestRow & {
      agency_name: string | null;
      phone: string | null;
      email: string | null;
      gstin: string | null;
      bookings: string;
      last_first_hour: Date | null;
    }
  >(
    `WITH l AS (${LATEST})
     SELECT l.*, a.name AS agency_name, ct.phone, ct.email, tx.gstin,
            (SELECT count(*) FROM bookings bk
               WHERE bk.brand_id = l.brand_id
                 AND (SELECT state FROM booking_events e WHERE e.booking_id = bk.booking_id
                       ORDER BY seq DESC LIMIT 1) <> 'cancelled') AS bookings,
            (SELECT max(bk.first_hour_at) FROM bookings bk WHERE bk.brand_id = l.brand_id) AS last_first_hour
       FROM l
       LEFT JOIN l a ON a.brand_id = l.agency_id
       LEFT JOIN LATERAL (SELECT phone, email FROM brand_contacts c WHERE c.brand_id = l.brand_id
                           ORDER BY set_at DESC LIMIT 1) ct ON true
       LEFT JOIN LATERAL (SELECT gstin FROM brand_tax_profiles t WHERE t.brand_id = l.brand_id
                           ORDER BY set_at DESC LIMIT 1) tx ON true
      ORDER BY lower(l.name), l.brand_id`,
  );
  return r.rows.map((x) => ({
    ...toAccount(x),
    agencyName: x.agency_name,
    phone: x.phone,
    email: x.email,
    gstin: x.gstin,
    bookings: Number(x.bookings),
    lastFirstHour: x.last_first_hour ? secs(x.last_first_hour) : null,
  }));
}

export interface AccountPage {
  readonly account: Account;
  readonly history: readonly {
    version: number;
    name: string;
    agencyId: string | null;
    referredBy: string | null;
    active: boolean;
    reason: string;
    by: string;
    at: number;
  }[];
  readonly contact: { phone: string | null; email: string | null; by: string; at: number } | null;
  readonly tax: {
    legalName: string;
    gstin: string | null;
    stateCode: string;
    address: string;
    by: string;
    at: number;
  } | null;
  readonly notes: readonly { note: string; by: string; at: number }[];
  /** For an agency: the brands it handles now. */
  readonly brands: readonly { brandId: string; name: string; active: boolean }[];
  readonly bookings: readonly {
    bookingId: string;
    state: string;
    totalPaise: number;
    firstHour: number;
    trial: boolean;
    createdAt: number;
  }[];
}

/** One account's page: everything staff need on a call. */
export async function accountPage(pool: Q, brandId: string): Promise<AccountPage | undefined> {
  const account = await findAccount(pool, brandId);
  if (!account) return undefined;
  const [history, contact, tax, notes, brands, bookings] = await Promise.all([
    pool.query<{
      version: number;
      name: string;
      agency_id: string | null;
      referred_by: string | null;
      active: boolean;
      reason: string;
      set_by: string;
      set_at: Date;
    }>('SELECT * FROM brand_versions WHERE brand_id = $1 ORDER BY version DESC', [brandId]),
    pool.query<{ phone: string | null; email: string | null; set_by: string; set_at: Date }>(
      'SELECT phone, email, set_by, set_at FROM brand_contacts WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1',
      [brandId],
    ),
    pool.query<{
      legal_name: string;
      gstin: string | null;
      state_code: string;
      address: string;
      set_by: string;
      set_at: Date;
    }>(
      `SELECT legal_name, gstin, state_code, address, set_by, set_at FROM brand_tax_profiles
        WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1`,
      [brandId],
    ),
    pool.query<{ note: string; by: string; at: Date }>(
      'SELECT note, by, at FROM brand_notes WHERE brand_id = $1 ORDER BY id DESC LIMIT 200',
      [brandId],
    ),
    pool.query<{ brand_id: string; name: string; active: boolean }>(
      `SELECT brand_id, name, active FROM (${LATEST}) l WHERE l.agency_id = $1 ORDER BY lower(name)`,
      [brandId],
    ),
    pool.query<{
      booking_id: string;
      state: string;
      total_paise: string;
      first_hour_at: Date;
      trial: boolean;
      created_at: Date;
    }>(
      `SELECT b.booking_id, b.total_paise, b.first_hour_at, b.trial, b.created_at,
              (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                ORDER BY seq DESC LIMIT 1) AS state
         FROM bookings b WHERE b.brand_id = $1 ORDER BY b.created_at DESC LIMIT 200`,
      [brandId],
    ),
  ]);
  const c = contact.rows[0];
  const t = tax.rows[0];
  return {
    account,
    history: history.rows.map((h) => ({
      version: h.version,
      name: h.name,
      agencyId: h.agency_id,
      referredBy: h.referred_by,
      active: h.active,
      reason: h.reason,
      by: h.set_by,
      at: secs(h.set_at),
    })),
    contact: c ? { phone: c.phone, email: c.email, by: c.set_by, at: secs(c.set_at) } : null,
    tax: t
      ? {
          legalName: t.legal_name,
          gstin: t.gstin,
          stateCode: t.state_code,
          address: t.address,
          by: t.set_by,
          at: secs(t.set_at),
        }
      : null,
    notes: notes.rows.map((n) => ({ note: n.note, by: n.by, at: secs(n.at) })),
    brands: brands.rows.map((b) => ({ brandId: b.brand_id, name: b.name, active: b.active })),
    bookings: bookings.rows.map((b) => ({
      bookingId: b.booking_id,
      state: b.state,
      totalPaise: Number(b.total_paise),
      firstHour: secs(b.first_hour_at),
      trial: b.trial,
      createdAt: secs(b.created_at),
    })),
  };
}
