// P1.7.9 in the database: each brand's tax details, tax invoices (issued when a booking is paid)
// and credit notes (issued when a refund is approved), numbered in one unbroken series per
// financial year; the monthly GST summary; and the files for the accountant.
import {
  docNumber,
  financialYearOf,
  gstinProblems,
  isoAt,
  priceBookAt,
  rupees,
  splitGst,
  toCsv,
  type GstSplit,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { setting } from './settings.js';

type Q = Pick<PoolClient, 'query'>;

export interface BrandTaxProfile {
  readonly legalName: string;
  /** Absent for a brand not registered for GST. */
  readonly gstin?: string;
  /** Two-digit state code: the place of supply. */
  readonly stateCode: string;
  readonly address?: string;
  /** P5.8: staff checked the GST number (certificate or GST records). Not checked: kept as typed,
   * and not printed on invoices until it is. Absent: checked (staff's own entry). */
  readonly gstinChecked?: boolean;
}

/** Sets a brand's tax details (the latest are used on new invoices; old ones never change). */
export async function setBrandTaxProfile(
  pool: Pool,
  brandId: string,
  p: BrandTaxProfile,
  by: string,
): Promise<void> {
  if (p.gstin !== undefined) {
    const problems = gstinProblems(p.gstin);
    if (problems.length > 0) throw new RangeError(problems.join('; '));
    if (p.gstin.slice(0, 2) !== p.stateCode)
      throw new RangeError('The GSTIN belongs to another state');
  }
  if (!/^\d{2}$/.test(p.stateCode)) throw new RangeError('State code must be 2 digits');
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO brand_tax_profiles (brand_id, legal_name, gstin, state_code, address, set_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        brandId,
        p.legalName.trim(),
        p.gstin ?? null,
        p.stateCode,
        p.address ?? '',
        by,
        p.gstin !== undefined && p.gstinChecked === false ? 'typed' : 'staff',
      ],
    ),
  );
}

export interface PartnerInvoice {
  readonly partnerId: string;
  readonly invoiceNo: string;
  /** "YYYY-MM-DD" */
  readonly invoiceDate: string;
  /** Absent for a partner not registered for GST (then no GST on it). */
  readonly gstin?: string;
  readonly taxablePaise: number;
  readonly gstPaise: number;
}

/**
 * Records an invoice a partner sent for its cuts (Prateek, 25 Oct 2026: best practice). Its GST
 * can then be claimed back; GST we booked for a partner with no invoice behind it is not claimed.
 * Refused when it claims more GST than RECALL booked for that partner (a 1-rupee rounding margin).
 */
export async function recordPartnerInvoice(
  pool: Pool,
  inv: PartnerInvoice,
  by: string,
): Promise<void> {
  if (inv.gstin !== undefined) {
    const problems = gstinProblems(inv.gstin);
    if (problems.length > 0) throw new RangeError(problems.join('; '));
  } else if (inv.gstPaise > 0) throw new RangeError('GST on an invoice needs the partner’s GSTIN');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoiceDate)) throw new RangeError('Date must be YYYY-MM-DD');
  if (
    ![inv.taxablePaise, inv.gstPaise].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    inv.taxablePaise === 0
  )
    throw new RangeError('Amounts must be whole paise; the invoice value more than 0');
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('partner-invoices'))");
    const r = await c.query<{ booked: string; backed: string }>(
      `SELECT (SELECT coalesce(sum(debit - credit), 0) FROM ledger_postings
                WHERE account = 'gst-input' AND party = $1) AS booked,
              (SELECT coalesce(sum(gst_paise), 0) FROM partner_invoices WHERE partner_id = $1) AS backed`,
      [inv.partnerId],
    );
    const room = Number(r.rows[0]?.booked ?? 0) - Number(r.rows[0]?.backed ?? 0) + 100;
    if (inv.gstPaise > room)
      throw new Refusal(
        `This invoice claims ₹${inv.gstPaise / 100} GST; RECALL booked only ₹${(room - 100) / 100} more for ${inv.partnerId}`,
      );
    const dup = await c.query(
      'SELECT 1 FROM partner_invoices WHERE partner_id = $1 AND invoice_no = $2',
      [inv.partnerId, inv.invoiceNo],
    );
    if (dup.rows.length > 0)
      throw new Refusal(`Invoice ${inv.invoiceNo} of ${inv.partnerId} is already recorded`);
    await c.query(
      `INSERT INTO partner_invoices (partner_id, invoice_no, invoice_date, gstin, taxable_paise,
         gst_paise, recorded_by) VALUES ($1, $2, $3::date, $4, $5, $6, $7)`,
      [
        inv.partnerId,
        inv.invoiceNo,
        inv.invoiceDate,
        inv.gstin ?? null,
        inv.taxablePaise,
        inv.gstPaise,
        by,
      ],
    );
  });
}

/** India date of a moment ("YYYY-MM-DD"). */
const indiaDate = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 10);

/**
 * Issues a tax invoice or credit note for a ledger entry, inside the caller's transaction (the
 * same one that posts the entry). Once per entry; the next number in its series for the year.
 */
export async function issueGstDocument(
  c: Q,
  d: {
    readonly kind: 'invoice' | 'credit-note';
    readonly sourceEntry: string;
    readonly bookingId: string;
    readonly taxable: number;
    readonly gst: number;
    readonly at: number;
  },
): Promise<string> {
  const before = await c.query<{ doc_no: string }>(
    'SELECT doc_no FROM gst_documents WHERE source_entry = $1',
    [d.sourceEntry],
  );
  if (before.rows[0]) return before.rows[0].doc_no;
  // One number at a time, so the series has no gaps and no repeats.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('gst-documents'))");
  const b = await c.query<{ brand_id: string }>(
    'SELECT brand_id FROM bookings WHERE booking_id = $1',
    [d.bookingId],
  );
  const brandId = b.rows[0]?.brand_id;
  if (brandId === undefined) throw new Error(`No booking ${d.bookingId}`);
  const book = priceBookAt(await priceBooks(c), isoAt(d.at));
  if (!book) throw new Error('No price book in force');
  const supplier = book.taxes.supplierStateCode;
  // RECALL's details as they are today, kept with the document (P5.8).
  const company = await setting(c, 'company');
  let recipient: {
    legal_name: string;
    gstin: string | null;
    state_code: string;
    address: string;
  };
  let gstBp: number;
  let held: { gstin: string; why: 'typed' | 'shared' } | null = null;
  let against: string | null = null;
  let split: GstSplit;
  if (d.kind === 'invoice') {
    // The brand's tax details in force when the invoice is issued. A brand with none yet is billed
    // in RECALL's state under its brand id; the summary flags it so they are added before filing.
    const p = await c.query<{
      legal_name: string;
      gstin: string | null;
      state_code: string;
      address: string;
      source: 'staff' | 'gst-record' | 'typed';
      shared: boolean;
    }>(
      `SELECT p.legal_name, p.gstin, p.state_code, p.address, p.source,
              EXISTS (
                SELECT 1 FROM (SELECT DISTINCT ON (brand_id) brand_id, gstin FROM brand_tax_profiles
                                WHERE set_at <= to_timestamp($2) ORDER BY brand_id, set_at DESC) o
                  JOIN (SELECT DISTINCT ON (brand_id) brand_id, active FROM brand_versions
                         ORDER BY brand_id, version DESC) v ON v.brand_id = o.brand_id AND v.active
                 WHERE o.gstin = p.gstin AND o.brand_id <> p.brand_id) AS shared
         FROM brand_tax_profiles p
        WHERE p.brand_id = $1 AND p.set_at <= to_timestamp($2) ORDER BY p.set_at DESC LIMIT 1`,
      [brandId, d.at],
    );
    const t = p.rows[0];
    recipient = t ?? { legal_name: brandId, gstin: null, state_code: supplier, address: '' };
    // The rate the tax was worked out at: the booking's price book.
    const rb = await c.query<{ book: { gstBp: number } }>(
      `SELECT p.book FROM bookings b JOIN price_books p ON p.version = b.price_book_version
        WHERE b.booking_id = $1`,
      [d.bookingId],
    );
    gstBp = rb.rows[0]?.book.gstBp ?? book.gstBp;
    // A GST number is printed only when it is safe (Prateek, 27 Oct 2026): set by staff, or read
    // from the GST records and on no other account. Typed by the brand, or on two accounts, it is
    // held back (an invoice under someone else's number would give them a tax claim on it).
    if (t?.gstin && t.source !== 'staff' && (t.source === 'typed' || t.shared)) {
      held = { gstin: t.gstin, why: t.source === 'typed' ? 'typed' : 'shared' };
      recipient = { ...t, gstin: null };
    }
    split = splitGst(d.gst, supplier, recipient.state_code);
  } else {
    // A credit note copies its invoice's recipient and place of supply, and its CGST / SGST come
    // out of what the invoice still has, so all the credit notes add back to the invoice exactly.
    const inv = await c.query<{
      doc_no: string;
      legal_name: string;
      gstin: string | null;
      gstin_held: string | null;
      gstin_held_why: 'typed' | 'shared' | null;
      place_of_supply: string;
      recipient_address: string | null;
      gst_bp: number | null;
      taxable: string;
      cgst: string;
      sgst: string;
      igst: string;
      c_taxable: string;
      c_cgst: string;
      c_sgst: string;
      c_igst: string;
    }>(
      `SELECT i.doc_no, i.legal_name, i.gstin, i.gstin_held, i.gstin_held_why, i.place_of_supply,
              i.recipient_address, i.gst_bp,
              i.taxable_paise AS taxable, i.cgst_paise AS cgst, i.sgst_paise AS sgst, i.igst_paise AS igst,
              coalesce(sum(n.taxable_paise), 0) AS c_taxable, coalesce(sum(n.cgst_paise), 0) AS c_cgst,
              coalesce(sum(n.sgst_paise), 0) AS c_sgst, coalesce(sum(n.igst_paise), 0) AS c_igst
         FROM gst_documents i LEFT JOIN gst_documents n ON n.against_doc = i.doc_no
        WHERE i.booking_id = $1 AND i.kind = 'invoice'
        GROUP BY i.doc_no ORDER BY min(i.issued_at) LIMIT 1`,
      [d.bookingId],
    );
    const i = inv.rows[0];
    if (!i) throw new Error(`No invoice for booking ${d.bookingId} to credit`);
    against = i.doc_no;
    recipient = {
      legal_name: i.legal_name,
      gstin: i.gstin,
      state_code: i.place_of_supply,
      address: i.recipient_address ?? '',
    };
    // A credit note reverses the invoice's tax: at the invoice's rate.
    gstBp = i.gst_bp ?? book.gstBp;
    if (i.gstin_held && i.gstin_held_why) held = { gstin: i.gstin_held, why: i.gstin_held_why };
    const left = {
      taxable: Number(i.taxable) - Number(i.c_taxable),
      cgst: Number(i.cgst) - Number(i.c_cgst),
      sgst: Number(i.sgst) - Number(i.c_sgst),
      igst: Number(i.igst) - Number(i.c_igst),
    };
    if (d.taxable > left.taxable || d.gst > left.cgst + left.sgst + left.igst)
      throw new Error(`Credit notes would go beyond invoice ${i.doc_no}`);
    if (Number(i.igst) > 0) split = { cgst: 0, sgst: 0, igst: d.gst };
    else {
      const cgst = Math.max(d.gst - left.sgst, Math.min(Math.floor(d.gst / 2), left.cgst));
      split = { cgst, sgst: d.gst - cgst, igst: 0 };
    }
  }
  const fy = financialYearOf(indiaDate(d.at));
  const last = await c.query<{ n: number | null }>(
    'SELECT max(n) AS n FROM gst_documents WHERE kind = $1 AND fy = $2',
    [d.kind, fy],
  );
  const n = (last.rows[0]?.n ?? 0) + 1;
  const docNo = docNumber(d.kind, fy, n);
  await c.query(
    `INSERT INTO gst_documents (doc_no, kind, fy, n, source_entry, booking_id, brand_id, against_doc,
       legal_name, gstin, place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise,
       total_paise, issued_at, sac, gstin_held, gstin_held_why, supplier_name, supplier_gstin,
       supplier_address, supplier_state, gst_bp, recipient_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, to_timestamp($17),
             $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [
      docNo,
      d.kind,
      fy,
      n,
      d.sourceEntry,
      d.bookingId,
      brandId,
      against,
      recipient.legal_name,
      recipient.gstin,
      recipient.state_code,
      d.taxable,
      split.cgst,
      split.sgst,
      split.igst,
      d.taxable + d.gst,
      d.at,
      book.taxes.sacCode,
      held?.gstin ?? null,
      held?.why ?? null,
      company.legalName,
      company.gstin,
      company.address,
      supplier,
      gstBp,
      recipient.address.slice(0, 500),
    ],
  );
  return docNo;
}

/** UTC seconds of a month's start and end in India time ("YYYY-MM"). */
function monthRange(month: string): { from: number; to: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('Month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const ist = 330 * 60;
  return { from: Date.UTC(y, m - 1, 1) / 1000 - ist, to: Date.UTC(y, m, 1) / 1000 - ist };
}

export interface GstSummary {
  readonly month: string;
  /** Tax invoices issued in the month. */
  readonly invoices: { count: number; taxable: number; cgst: number; sgst: number; igst: number };
  /** Credit notes issued in the month (reduce what is owed). */
  readonly creditNotes: {
    count: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
  };
  /** GST on partner invoices dated this month: claimed back. */
  readonly inputTaxCredit: number;
  /** GST booked for partners so far with no invoice recorded yet: not claimed until one is. */
  readonly inputGstAwaitingInvoices: number;
  /** GST on sales less credit notes less input tax credit: what is paid for the month. */
  readonly netGstPayable: number;
  /** TDS held back in the month, to deposit by the 7th of the next month. */
  readonly tds: { riders: number; partners: number };
  /** Financial year so far (invoices less credit notes, before GST), and the e-invoice check. */
  readonly yearTurnover: number;
  readonly eInvoice: 'not needed' | 'getting close' | 'needed';
  /** Invoices billed to a brand with no tax details: add them before filing. */
  readonly missingTaxDetails: readonly string[];
  /** P5.8: invoices issued without the brand's GST number (typed, not checked, or on two
   * accounts): staff check it; a corrected invoice is a credit note and a new invoice. */
  readonly gstinHeld: readonly { docNo: string; gstin: string; why: 'typed' | 'shared' }[];
}

/** The month's GST summary (P1.7.9), from the documents and the ledger. */
export async function gstSummary(c: Q, month: string): Promise<GstSummary> {
  const { from, to } = monthRange(month);
  const docs = await c.query<{
    kind: string;
    count: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
  }>(
    `SELECT kind, count(*) AS count, coalesce(sum(taxable_paise), 0) AS taxable,
            coalesce(sum(cgst_paise), 0) AS cgst, coalesce(sum(sgst_paise), 0) AS sgst,
            coalesce(sum(igst_paise), 0) AS igst
       FROM gst_documents WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2)
      GROUP BY kind`,
    [from, to],
  );
  const of = (kind: string) => {
    const r = docs.rows.find((x) => x.kind === kind);
    return {
      count: Number(r?.count ?? 0),
      taxable: Number(r?.taxable ?? 0),
      cgst: Number(r?.cgst ?? 0),
      sgst: Number(r?.sgst ?? 0),
      igst: Number(r?.igst ?? 0),
    };
  };
  const invoices = of('invoice');
  const creditNotes = of('credit-note');
  const ledger = await c.query<{ tds_riders: string; tds_partners: string }>(
    `SELECT coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'
              AND e.kind IN ('rider-pay', 'poc-bonus', 'poc-finish-bonus')), 0) AS tds_riders,
            coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'
              AND e.kind IN ('agency-cut', 'aggregator-cut')), 0) AS tds_partners
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.at >= to_timestamp($1) AND e.at < to_timestamp($2)`,
    [from, to],
  );
  const gst = (x: typeof invoices) => x.cgst + x.sgst + x.igst;
  const partner = await c.query<{ itc: string; backed: string }>(
    `SELECT coalesce(sum(gst_paise) FILTER (WHERE invoice_date >= $1::date AND invoice_date < $2::date), 0) AS itc,
            coalesce(sum(gst_paise) FILTER (WHERE invoice_date < $2::date), 0) AS backed
       FROM partner_invoices`,
    [`${month}-01`, indiaDate(to)],
  );
  const itc = Number(partner.rows[0]?.itc ?? 0);
  const booked = await c.query<{ n: string }>(
    `SELECT coalesce(sum(p.debit - p.credit), 0) AS n FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE p.account = 'gst-input' AND e.at < to_timestamp($1)`,
    [to],
  );
  const awaiting = Math.max(
    0,
    Number(booked.rows[0]?.n ?? 0) - Number(partner.rows[0]?.backed ?? 0),
  );
  // The financial year from April to the end of this month.
  const fy = financialYearOf(`${month}-01`);
  const fyStart = monthRange(`${fy.slice(0, 4)}-04`).from;
  const year = await c.query<{ t: string }>(
    `SELECT coalesce(sum(CASE kind WHEN 'invoice' THEN taxable_paise ELSE -taxable_paise END), 0) AS t
       FROM gst_documents WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2)`,
    [fyStart, to],
  );
  const yearTurnover = Number(year.rows[0]?.t ?? 0);
  const book = priceBookAt(await priceBooks(c), isoAt(from));
  const rules = book?.taxes;
  const eInvoice =
    rules === undefined ||
    yearTurnover < (rules.eInvoiceTurnoverPaise * rules.eInvoiceWarnBp) / 10_000
      ? 'not needed'
      : yearTurnover < rules.eInvoiceTurnoverPaise
        ? 'getting close'
        : 'needed';
  const missing = await c.query<{ doc_no: string }>(
    `SELECT doc_no FROM gst_documents d
      WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2) AND kind = 'invoice'
        AND NOT EXISTS (SELECT 1 FROM brand_tax_profiles p WHERE p.brand_id = d.brand_id
                         AND p.set_at <= d.issued_at)
      ORDER BY doc_no`,
    [from, to],
  );
  const heldBack = await c.query<{
    doc_no: string;
    gstin_held: string;
    gstin_held_why: 'typed' | 'shared';
  }>(
    `SELECT doc_no, gstin_held, gstin_held_why FROM gst_documents
      WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2) AND kind = 'invoice'
        AND gstin_held IS NOT NULL ORDER BY doc_no`,
    [from, to],
  );
  return {
    month,
    invoices,
    creditNotes,
    inputTaxCredit: itc,
    inputGstAwaitingInvoices: awaiting,
    netGstPayable: gst(invoices) - gst(creditNotes) - itc,
    tds: {
      riders: Number(ledger.rows[0]?.tds_riders ?? 0),
      partners: Number(ledger.rows[0]?.tds_partners ?? 0),
    },
    yearTurnover,
    eInvoice,
    missingTaxDetails: missing.rows.map((r) => r.doc_no),
    gstinHeld: heldBack.rows.map((r) => ({
      docNo: r.doc_no,
      gstin: r.gstin_held,
      why: r.gstin_held_why,
    })),
  };
}

/**
 * The month's files for the accountant: the invoice and credit-note registers, the full journal
 * (every ledger entry with its postings) and the summary, as CSV (amounts in rupees).
 */
export async function accountantExport(
  c: Q,
  month: string,
): Promise<{ name: string; csv: string }[]> {
  const { from, to } = monthRange(month);
  const docs = await c.query<{
    doc_no: string;
    kind: string;
    issued: string;
    against_doc: string | null;
    booking_id: string;
    legal_name: string;
    gstin: string | null;
    place_of_supply: string;
    sac: string;
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
  }>(
    `SELECT doc_no, kind, to_char(issued_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS issued,
            against_doc, booking_id, legal_name, gstin, place_of_supply, sac,
            taxable_paise AS taxable, cgst_paise AS cgst, sgst_paise AS sgst, igst_paise AS igst,
            total_paise AS total
       FROM gst_documents WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2)
      ORDER BY kind, n`,
    [from, to],
  );
  const header = [
    'number',
    'date',
    'booking',
    'customer',
    'gstin',
    'place of supply',
    'sac',
    'taxable',
    'cgst',
    'sgst',
    'igst',
    'total',
  ];
  const row = (d: (typeof docs.rows)[number]) => [
    d.doc_no,
    d.issued,
    d.booking_id,
    d.legal_name,
    d.gstin ?? '',
    d.place_of_supply,
    d.sac,
    rupees(Number(d.taxable)),
    rupees(Number(d.cgst)),
    rupees(Number(d.sgst)),
    rupees(Number(d.igst)),
    rupees(Number(d.total)),
  ];
  const journal = await c.query<{
    entry_id: string;
    at: string;
    kind: string;
    ref: string;
    memo: string;
    account: string;
    party: string | null;
    debit: string;
    credit: string;
  }>(
    `SELECT e.entry_id, to_char(e.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at,
            e.kind, e.ref, e.memo, p.account, p.party, p.debit, p.credit
       FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
      WHERE e.at >= to_timestamp($1) AND e.at < to_timestamp($2)
      ORDER BY e.at, e.entry_id, p.n`,
    [from, to],
  );
  const partners = await c.query<{
    partner_id: string;
    invoice_no: string;
    invoice_date: string;
    gstin: string | null;
    taxable: string;
    gst: string;
  }>(
    `SELECT partner_id, invoice_no, invoice_date::text AS invoice_date, gstin,
            taxable_paise AS taxable, gst_paise AS gst
       FROM partner_invoices WHERE invoice_date >= $1::date AND invoice_date < $2::date
      ORDER BY invoice_date, partner_id, invoice_no`,
    [`${month}-01`, indiaDate(to)],
  );
  const s = await gstSummary(c, month);
  const gst = (x: GstSummary['invoices']) => x.cgst + x.sgst + x.igst;
  return [
    {
      name: `invoices-${month}.csv`,
      csv: toCsv(header, docs.rows.filter((d) => d.kind === 'invoice').map(row)),
    },
    {
      name: `credit-notes-${month}.csv`,
      csv: toCsv(
        ['against', ...header],
        docs.rows.filter((d) => d.kind === 'credit-note').map((d) => [d.against_doc, ...row(d)]),
      ),
    },
    {
      name: `partner-invoices-${month}.csv`,
      csv: toCsv(
        ['partner', 'invoice', 'date', 'gstin', 'taxable', 'gst'],
        partners.rows.map((p) => [
          p.partner_id,
          p.invoice_no,
          p.invoice_date,
          p.gstin ?? '',
          rupees(Number(p.taxable)),
          rupees(Number(p.gst)),
        ]),
      ),
    },
    {
      name: `journal-${month}.csv`,
      csv: toCsv(
        ['entry', 'time', 'kind', 'about', 'memo', 'account', 'party', 'debit', 'credit'],
        journal.rows.map((j) => [
          j.entry_id,
          j.at,
          j.kind,
          j.ref,
          j.memo,
          j.account,
          j.party ?? '',
          rupees(Number(j.debit)),
          rupees(Number(j.credit)),
        ]),
      ),
    },
    {
      name: `gst-summary-${month}.csv`,
      csv: toCsv(
        ['item', 'amount'],
        [
          ['invoices issued', s.invoices.count],
          ['taxable value', rupees(s.invoices.taxable)],
          ['GST on invoices', rupees(gst(s.invoices))],
          ['credit notes issued', s.creditNotes.count],
          ['GST on credit notes', rupees(gst(s.creditNotes))],
          ['input tax credit (partner invoices this month)', rupees(s.inputTaxCredit)],
          ['partner GST waiting for an invoice', rupees(s.inputGstAwaitingInvoices)],
          ['net GST payable', rupees(s.netGstPayable)],
          ['TDS held back from riders', rupees(s.tds.riders)],
          ['TDS held back from partners', rupees(s.tds.partners)],
          ['turnover this financial year', rupees(s.yearTurnover)],
          ['e-invoicing', s.eInvoice],
          ['invoices missing tax details', s.missingTaxDetails.join(' ')],
          [
            'invoices without the brand GST number (check it)',
            s.gstinHeld.map((h) => `${h.docNo}:${h.gstin}:${h.why}`).join(' '),
          ],
        ],
      ),
    },
  ];
}
