// P5.2 in the database: a business sets itself up on the brand portal. Its GST number is looked up
// in the GST records (each lookup kept, a few a day per person) and the legal name, state and
// address on its invoices come from the record; with no lookup service (production until P6) or the
// service down, or no GST number at all, the business types them. A GST number is public, so it never
// blocks anyone: a second account with the same number is shown to staff, who settle it before an
// invoice carries the number. The business name (shown on campaigns) is its own, apart from the
// legal name on invoices. Setting up makes the
// account, its tax details, its contact (invoice email and WhatsApp number), its type and the person
// as its owner, all at once. New businesses are offered one free week (the price book's trial).
import type { GstAdapter, GstLookup, GstRecord } from '@recall/adapters';
import {
  BUSINESS_TYPES,
  DEFAULT_BRAND_SIGN_IN,
  accountIdFrom,
  gstinProblems,
  isoAt,
  priceBookAt,
  stateName,
  trialKeys,
  type AccountKind,
  type BrandSignInRules,
  type BusinessType,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { setting } from './settings.js';

type Q = Pick<PoolClient, 'query'>;

/** How long the GST service has to answer. */
const LOOKUP_WAIT_MS = 10_000;
/** A lookup counts for setting up for a day. */
const LOOKUP_LIFE_S = 86_400;

/** The start of the India day `now` falls in (UTC seconds). */
const indiaDayStart = (now: number) => {
  const shift = 330 * 60;
  return Math.floor((now + shift) / 86_400) * 86_400 - shift;
};

/** Who made an account on the portal, as kept on it (the column holds 120 characters). */
const portalBy = (asker: string) => `portal:${asker}`.slice(0, 120);

/**
 * Other active accounts whose tax details carry the same GST number as this one's. A GST number is
 * public, so anyone can type a business's number: it never blocks a second account (the real owner
 * is never locked out), and staff see the clash on both accounts and settle it before an invoice
 * carries the number (P5.6).
 */
export async function sameGstinAccounts(
  c: Q,
  brandId: string,
): Promise<{ brandId: string; name: string }[]> {
  const r = await c.query<{ brand_id: string; name: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (brand_id) brand_id, gstin FROM brand_tax_profiles
        ORDER BY brand_id, set_at DESC),
     live AS (
       SELECT DISTINCT ON (brand_id) brand_id, name, active FROM brand_versions
        ORDER BY brand_id, version DESC)
     SELECT o.brand_id, v.name
       FROM latest me JOIN latest o ON o.gstin = me.gstin AND o.brand_id <> me.brand_id
       JOIN live v ON v.brand_id = o.brand_id
      WHERE me.brand_id = $1 AND me.gstin IS NOT NULL AND v.active
      ORDER BY v.name`,
    [brandId],
  );
  return r.rows.map((x) => ({ brandId: x.brand_id, name: x.name }));
}

export type GstLookupAnswer =
  | {
      readonly status: 'found';
      readonly legalName: string;
      readonly tradeName: string | null;
      readonly stateCode: string;
      readonly stateName: string | null;
      readonly address: string;
    }
  /** No lookup service, or it did not answer: the business types its details. */
  | { readonly status: 'type-it' };

/**
 * Looks a GST number up for a person setting up a business. Refused when it is not a GSTIN, is
 * not in the records, is cancelled, or the person has looked up too many today. Says nothing about
 * whether the number is with RECALL already (nobody learns who our customers are).
 */
export async function lookUpGst(
  pool: Pool,
  gst: GstAdapter | undefined,
  ask: { readonly gstin: string; readonly asker: string },
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<GstLookupAnswer> {
  const problems = gstinProblems(ask.gstin);
  if (problems.length > 0)
    throw new Refusal('This is not a GST number: check it (15 characters, like 36ABCDE1234F1Z5)', {
      code: 'bad-gstin',
    });
  // Every lookup is kept and counted (each costs).
  const used = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM gst_lookups WHERE asker = $1 AND at >= to_timestamp($2)',
    [ask.asker, indiaDayStart(now)],
  );
  if (Number(used.rows[0]?.n ?? 0) >= rules.gstLookupsPerDay)
    throw new Refusal('Too many GST lookups today: try again tomorrow, or call us', {
      code: 'too-many-lookups',
    });
  const keep = (status: string, rec?: GstRecord) =>
    pool.query(
      `INSERT INTO gst_lookups (gstin, asker, status, legal_name, trade_name, state_code, address,
                                active, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
      [
        ask.gstin,
        ask.asker,
        status,
        rec?.legalName.trim().slice(0, 200) ?? null,
        rec?.tradeName?.trim().slice(0, 200) || null,
        rec?.stateCode ?? null,
        rec?.address.trim().slice(0, 500) ?? null,
        rec?.active ?? null,
        now,
      ],
    );
  if (!gst) {
    await keep('no-service');
    return { status: 'type-it' };
  }
  let timer: NodeJS.Timeout | undefined;
  const answer: GstLookup = await Promise.race([
    gst.lookup(ask.gstin).catch((e: unknown): GstLookup => ({
      status: 'unavailable',
      reason: e instanceof Error ? e.message : String(e),
    })),
    new Promise<GstLookup>((ok) => {
      timer = setTimeout(() => ok({ status: 'unavailable', reason: 'no answer' }), LOOKUP_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  // A record for another number is never taken as this one's.
  const rec =
    answer.status === 'found' &&
    answer.record.gstin === ask.gstin &&
    answer.record.stateCode === ask.gstin.slice(0, 2)
      ? answer.record
      : undefined;
  const status = rec ? 'found' : answer.status === 'found' ? 'unavailable' : answer.status;
  await keep(status, rec);
  if (status === 'not-found')
    throw new Refusal('This GST number is not in the GST records: check it', {
      code: 'gstin-not-found',
    });
  if (!rec) return { status: 'type-it' };
  if (!rec.active)
    throw new Refusal('This GST number is cancelled or suspended in the GST records', {
      code: 'gstin-inactive',
    });
  return {
    status: 'found',
    legalName: rec.legalName.trim(),
    tradeName: rec.tradeName?.trim() || null,
    stateCode: rec.stateCode,
    stateName: stateName(rec.stateCode) ?? null,
    address: rec.address.trim(),
  };
}

export interface NewBusiness {
  /** The portal sign-in's number or email: the business's first owner. */
  readonly asker: string;
  /** Null: the business has no GST number. */
  readonly gstin: string | null;
  /** The name shown on its campaigns and report. */
  readonly name: string;
  readonly kind: AccountKind;
  readonly businessType: BusinessType;
  readonly invoiceEmail: string;
  /** For WhatsApp messages ("booked and paid", "your report"): +91 and 10 digits. */
  readonly phone: string;
  /** Typed: used only with no GST number, or when the GST record could not be read. */
  readonly legalName?: string;
  readonly stateCode?: string;
  readonly address?: string;
}

/** Sets up a business (one transaction). Returns its account id. */
export async function setUpBusiness(
  pool: Pool,
  b: NewBusiness,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<string> {
  const name = b.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) throw new Refusal('Business name: 2 to 120 characters');
  if (!BUSINESS_TYPES.some(([k]) => k === b.businessType))
    throw new Refusal('Which kind of business?');
  if (!/^\+91[6-9]\d{9}$/.test(b.phone)) throw new Refusal('A 10-digit mobile number for WhatsApp');
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$/.test(b.invoiceEmail))
    throw new Refusal('An email address for invoices');
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-set-up:${b.asker}`]);
    const made = await c.query<{ n: string }>(
      'SELECT count(*) AS n FROM brands WHERE created_by = $1 AND created_at >= to_timestamp($2)',
      [portalBy(b.asker), indiaDayStart(now)],
    );
    if (Number(made.rows[0]?.n ?? 0) >= rules.businessesPerDay)
      throw new Refusal('Too many businesses set up today: try again tomorrow, or call us', {
        code: 'too-many-businesses',
      });

    let tax: {
      legalName: string;
      stateCode: string;
      address: string;
      source: 'gst-record' | 'typed';
      lookupId: string | null;
    };
    if (b.gstin) {
      if (gstinProblems(b.gstin).length > 0) throw new Refusal('This is not a GST number');
      const l = await c.query<{
        id: string;
        status: string;
        legal_name: string | null;
        state_code: string | null;
        address: string | null;
        active: boolean | null;
      }>(
        // The service's last real answer wins over a later failure to answer.
        `SELECT id, status, legal_name, state_code, address, active FROM gst_lookups
          WHERE gstin = $1 AND asker = $2 AND at > to_timestamp($3)
          ORDER BY (status IN ('found', 'not-found')) DESC, at DESC, id DESC LIMIT 1`,
        [b.gstin, b.asker, now - LOOKUP_LIFE_S],
      );
      const x = l.rows[0];
      if (!x)
        throw new Refusal('Find your business by its GST number again, then save', {
          code: 'look-up-again',
        });
      if (x.status === 'found') {
        // The record's details, never what was typed.
        if (!x.active)
          throw new Refusal('This GST number is cancelled or suspended in the GST records');
        tax = {
          legalName: x.legal_name ?? '',
          stateCode: x.state_code ?? '',
          address: x.address ?? '',
          source: 'gst-record',
          lookupId: x.id,
        };
      } else if (x.status === 'not-found') {
        throw new Refusal('This GST number is not in the GST records: check it');
      } else {
        // No lookup service (or it did not answer): what the business typed, in the GSTIN's state.
        // Not checked: it never blocks the number's owner, and staff check it before invoicing.
        tax = {
          legalName: (b.legalName ?? '').trim(),
          stateCode: b.gstin.slice(0, 2),
          address: (b.address ?? '').trim(),
          source: 'typed',
          lookupId: null,
        };
      }
    } else {
      tax = {
        legalName: (b.legalName ?? '').trim(),
        stateCode: b.stateCode ?? '',
        address: (b.address ?? '').trim(),
        source: 'typed',
        lookupId: null,
      };
    }
    if (tax.legalName.length < 2 || tax.legalName.length > 200)
      throw new Refusal('Legal name: 2 to 200 characters (as on your registration)');
    if (!stateName(tax.stateCode)) throw new Refusal('Which state is your business in?');
    if (tax.address.length > 300) throw new Refusal('Address: at most 300 characters');

    // Its id from its name: the first one free (one set-up at a time per name).
    const base = accountIdFrom(name);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-id:${base}`]);
    let brandId = '';
    for (let i = 1; i <= 50 && !brandId; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      const t = await c.query('SELECT 1 FROM brands WHERE brand_id = $1', [id]);
      if (t.rowCount === 0) brandId = id;
    }
    if (!brandId) throw new Refusal('Choose another business name');
    const by = portalBy(b.asker);
    await c.query(
      'INSERT INTO brands (brand_id, kind, created_by, created_at) VALUES ($1, $2, $3, to_timestamp($4))',
      [brandId, b.kind, by, now],
    );
    await c.query(
      `INSERT INTO brand_versions (brand_id, version, name, agency_id, referred_by, active, reason,
                                   set_by, set_at)
       VALUES ($1, 1, $2, NULL, NULL, true, 'set up on the brand portal', $3, to_timestamp($4))`,
      [brandId, name, by, now],
    );
    await c.query(
      `INSERT INTO brand_tax_profiles (brand_id, set_at, legal_name, gstin, state_code, address, set_by,
                                       source, gst_lookup_id)
       VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9)`,
      [
        brandId,
        now,
        tax.legalName,
        b.gstin,
        tax.stateCode,
        tax.address,
        by,
        tax.source,
        tax.lookupId,
      ],
    );
    await c.query(
      `INSERT INTO brand_contacts (brand_id, set_at, phone, email, set_by)
       VALUES ($1, to_timestamp($2), $3, $4, $5)`,
      [brandId, now, b.phone, b.invoiceEmail, by],
    );
    await c.query(
      `INSERT INTO brand_profiles (brand_id, set_at, business_type, set_by)
       VALUES ($1, to_timestamp($2), $3, $4)`,
      [brandId, now, b.businessType, b.asker],
    );
    await c.query(
      `INSERT INTO brand_members (brand_id, address, version, role, active, reason, set_by, set_at)
       VALUES ($1, $2, 1, 'owner', true, 'set up the business on the brand portal', $4,
               to_timestamp($3))`,
      [brandId, b.asker, now, b.asker],
    );
    return brandId;
  });
}

export interface BusinessPage {
  readonly brandId: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly businessType: BusinessType | null;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly stateName: string | null;
  readonly address: string | null;
  readonly invoiceEmail: string | null;
  readonly phone: string | null;
  /** The free week, while this business can still have it (null: it had it, or none is offered). */
  readonly freeWeek: { readonly days: number; readonly bikeHours: number } | null;
}

/**
 * What a free week is counted against: the business's phone and GST number, and the portal person
 * asking (one free week per person, however many businesses they set up). The trial booking (P5.4)
 * writes all of them; undefined when the phone is not a mobile number.
 */
export function freeWeekKeys(
  business: { readonly phone: string; readonly gstin: string | null },
  person: string,
): string[] | undefined {
  const keys = trialKeys({
    phone: business.phone,
    ...(business.gstin ? { gstin: business.gstin } : {}),
  });
  return keys ? [...keys, `member:${person}`] : undefined;
}

/**
 * A business's details as its portal shows them, and whether its free week is still open for the
 * person looking (`person`: their number or email).
 */
export async function businessPage(
  c: Q,
  brandId: string,
  now: number,
  person: string,
): Promise<BusinessPage | undefined> {
  const r = await c.query<{
    name: string;
    kind: AccountKind;
    business_type: BusinessType | null;
    legal_name: string | null;
    gstin: string | null;
    state_code: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  }>(
    `SELECT v.name, b.kind, p.business_type, t.legal_name, t.gstin, t.state_code, t.address,
            k.email, k.phone
       FROM brands b
       JOIN LATERAL (SELECT name FROM brand_versions x WHERE x.brand_id = b.brand_id
                      ORDER BY version DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT business_type FROM brand_profiles x WHERE x.brand_id = b.brand_id
                           ORDER BY set_at DESC LIMIT 1) p ON true
       LEFT JOIN LATERAL (SELECT legal_name, gstin, state_code, address FROM brand_tax_profiles x
                           WHERE x.brand_id = b.brand_id ORDER BY set_at DESC LIMIT 1) t ON true
       LEFT JOIN LATERAL (SELECT email, phone FROM brand_contacts x WHERE x.brand_id = b.brand_id
                           ORDER BY set_at DESC LIMIT 1) k ON true
      WHERE b.brand_id = $1`,
    [brandId],
  );
  const x = r.rows[0];
  if (!x) return undefined;
  let freeWeek: BusinessPage['freeWeek'] = null;
  const keys =
    x.kind === 'brand' && x.phone
      ? freeWeekKeys({ phone: x.phone, gstin: x.gstin }, person)
      : undefined;
  const book = (await setting(c, 'freeWeek')).on
    ? priceBookAt(await priceBooks(c), isoAt(now))
    : undefined;
  if (keys && book && book.trialDays > 0 && book.trialBikeHours > 0) {
    const used = await c.query('SELECT 1 FROM trials_used WHERE identity = ANY($1)', [keys]);
    if (used.rowCount === 0) freeWeek = { days: book.trialDays, bikeHours: book.trialBikeHours };
  }
  return {
    brandId,
    name: x.name,
    kind: x.kind,
    businessType: x.business_type,
    legalName: x.legal_name,
    gstin: x.gstin,
    stateCode: x.state_code,
    stateName: x.state_code ? (stateName(x.state_code) ?? null) : null,
    address: x.address,
    invoiceEmail: x.email,
    phone: x.phone,
    freeWeek,
  };
}
