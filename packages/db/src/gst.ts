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
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';

type Q = Pick<PoolClient, 'query'>;

export interface BrandTaxProfile {
  readonly legalName: string;
  /** Absent for a brand not registered for GST. */
  readonly gstin?: string;
  /** Two-digit state code: the place of supply. */
  readonly stateCode: string;
  readonly address?: string;
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
      `INSERT INTO brand_tax_profiles (brand_id, legal_name, gstin, state_code, address, set_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [brandId, p.legalName.trim(), p.gstin ?? null, p.stateCode, p.address ?? '', by],
    ),
  );
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
  const p = await c.query<{ legal_name: string; gstin: string | null; state_code: string }>(
    `SELECT legal_name, gstin, state_code FROM brand_tax_profiles
      WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1`,
    [brandId],
  );
  // A brand with no tax details yet is billed in RECALL's state under its brand id; the register
  // shows it so the details are added before the return is filed.
  const profile = p.rows[0] ?? { legal_name: brandId, gstin: null, state_code: supplier };
  let against: string | null = null;
  if (d.kind === 'credit-note') {
    const inv = await c.query<{ doc_no: string; place_of_supply: string }>(
      `SELECT doc_no, place_of_supply FROM gst_documents
        WHERE booking_id = $1 AND kind = 'invoice' ORDER BY issued_at LIMIT 1`,
      [d.bookingId],
    );
    if (!inv.rows[0]) throw new Error(`No invoice for booking ${d.bookingId} to credit`);
    against = inv.rows[0].doc_no;
    // A credit note follows its invoice's place of supply.
    profile.state_code = inv.rows[0].place_of_supply;
  }
  const fy = financialYearOf(indiaDate(d.at));
  const last = await c.query<{ n: number | null }>(
    'SELECT max(n) AS n FROM gst_documents WHERE kind = $1 AND fy = $2',
    [d.kind, fy],
  );
  const n = (last.rows[0]?.n ?? 0) + 1;
  const docNo = docNumber(d.kind, fy, n);
  const split = splitGst(d.gst, supplier, profile.state_code);
  await c.query(
    `INSERT INTO gst_documents (doc_no, kind, fy, n, source_entry, booking_id, brand_id, against_doc,
       legal_name, gstin, place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise,
       total_paise, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, to_timestamp($17))`,
    [
      docNo,
      d.kind,
      fy,
      n,
      d.sourceEntry,
      d.bookingId,
      brandId,
      against,
      profile.legal_name,
      profile.gstin,
      profile.state_code,
      d.taxable,
      split.cgst,
      split.sgst,
      split.igst,
      d.taxable + d.gst,
      d.at,
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
  /** GST charged to RECALL by partners on their cuts, to claim back (CA to confirm each one). */
  readonly inputTaxCredit: number;
  /** GST on sales less credit notes less input tax credit: what is paid for the month. */
  readonly netGstPayable: number;
  /** TDS held back in the month, to deposit by the 7th of the next month. */
  readonly tds: { riders: number; partners: number };
  /** Financial year so far (invoices less credit notes, before GST), and the e-invoice check. */
  readonly yearTurnover: number;
  readonly eInvoice: 'not needed' | 'getting close' | 'needed';
  /** Invoices billed to a brand with no tax details: add them before filing. */
  readonly missingTaxDetails: readonly string[];
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
  const ledger = await c.query<{ itc: string; tds_riders: string; tds_partners: string }>(
    `SELECT coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = 'gst-input'), 0) AS itc,
            coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'
              AND e.kind IN ('rider-pay', 'poc-bonus', 'poc-finish-bonus')), 0) AS tds_riders,
            coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'
              AND e.kind IN ('agency-cut', 'aggregator-cut')), 0) AS tds_partners
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.at >= to_timestamp($1) AND e.at < to_timestamp($2)`,
    [from, to],
  );
  const gst = (x: typeof invoices) => x.cgst + x.sgst + x.igst;
  const itc = Number(ledger.rows[0]?.itc ?? 0);
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
  return {
    month,
    invoices,
    creditNotes,
    inputTaxCredit: itc,
    netGstPayable: gst(invoices) - gst(creditNotes) - itc,
    tds: {
      riders: Number(ledger.rows[0]?.tds_riders ?? 0),
      partners: Number(ledger.rows[0]?.tds_partners ?? 0),
    },
    yearTurnover,
    eInvoice,
    missingTaxDetails: missing.rows.map((r) => r.doc_no),
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
    taxable: string;
    cgst: string;
    sgst: string;
    igst: string;
    total: string;
  }>(
    `SELECT doc_no, kind, to_char(issued_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS issued,
            against_doc, booking_id, legal_name, gstin, place_of_supply,
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
          ['input tax credit (partners)', rupees(s.inputTaxCredit)],
          ['net GST payable', rupees(s.netGstPayable)],
          ['TDS held back from riders', rupees(s.tds.riders)],
          ['TDS held back from partners', rupees(s.tds.partners)],
          ['turnover this financial year', rupees(s.yearTurnover)],
          ['e-invoicing', s.eInvoice],
          ['invoices missing tax details', s.missingTaxDetails.join(' ')],
        ],
      ),
    },
  ];
}
