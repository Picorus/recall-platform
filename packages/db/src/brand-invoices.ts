// P5.8 in the database: a business's tax invoices and credit notes on the brand portal, by financial
// year (April–March), newest first. Read only: documents are issued with payments and refunds
// (P1.7.9) and never changed.
import { financialYearOf, priceBookAt, type TaxDocument } from '@recall/domain';
import type { Pool } from 'pg';
import { priceBooks } from './bookings.js';

type Q = Pick<Pool, 'query'>;

/** At most this many documents are listed or put in one "all for the year" PDF. */
export const MAX_YEAR_DOCUMENTS = 500;

const indiaDate = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 10);

interface Row {
  doc_no: string;
  kind: TaxDocument['kind'];
  issued_at: Date;
  against_doc: string | null;
  booking_id: string;
  poc_ref: string | null;
  brand_id: string;
  legal_name: string;
  gstin: string | null;
  held: boolean;
  place_of_supply: string;
  sac: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  bike_hours: string;
  gst_bp: number | null;
  recipient_address: string | null;
  supplier_name: string | null;
  supplier_gstin: string | null;
  supplier_address: string | null;
  supplier_state: string | null;
  first_day: string;
  last_day: string;
}

const SELECT = `SELECT d.doc_no, d.kind, d.issued_at, d.against_doc,
       coalesce(d.booking_id, d.poc_ref) AS booking_id, d.poc_ref, d.brand_id,
       d.legal_name, d.gstin, d.gstin_held IS NOT NULL AS held, d.place_of_supply, d.sac, d.taxable_paise AS taxable,
       d.cgst_paise AS cgst, d.sgst_paise AS sgst, d.igst_paise AS igst, d.total_paise AS total,
       d.gst_bp, d.recipient_address, d.supplier_name, d.supplier_gstin, d.supplier_address,
       d.supplier_state, coalesce(l.bike_hours, 0) AS bike_hours,
       -- P7.8: a POC month runs from its 1st to its last day.
       coalesce(l.first_day, to_date(right(d.poc_ref, 7), 'YYYY-MM'))::text AS first_day,
       coalesce(l.last_day,
                (to_date(right(d.poc_ref, 7), 'YYYY-MM') + interval '1 month' - interval '1 day')::date
       )::text AS last_day
  FROM gst_documents d
  JOIN LATERAL (SELECT sum(bikes) AS bike_hours, min(day) AS first_day, max(day) AS last_day
                  FROM booking_lines WHERE booking_id = d.booking_id) l ON true`;

async function shaped(c: Q, rows: readonly Row[]): Promise<TaxDocument[]> {
  const books = rows.length > 0 ? await priceBooks(c) : [];
  return rows.map((r) => {
    const at = Math.floor(r.issued_at.getTime() / 1000);
    const book = priceBookAt(books, r.issued_at.toISOString());
    return {
      docNo: r.doc_no,
      kind: r.kind,
      issuedAt: at,
      againstDoc: r.against_doc,
      bookingId: r.booking_id,
      brandId: r.brand_id,
      legalName: r.legal_name,
      gstin: r.gstin,
      gstinHeld: r.held,
      placeOfSupply: r.place_of_supply,
      sac: r.sac,
      taxablePaise: Number(r.taxable),
      cgstPaise: Number(r.cgst),
      sgstPaise: Number(r.sgst),
      igstPaise: Number(r.igst),
      totalPaise: Number(r.total),
      // Documents from before P5.8 kept no rate or details: the price book of the day, and none.
      gstBp: r.gst_bp ?? book?.gstBp ?? 0,
      recipientAddress: r.recipient_address ?? '',
      supplier: {
        legalName: r.supplier_name ?? '',
        gstin: r.supplier_gstin ?? '',
        address: r.supplier_address ?? '',
      },
      supplierState: r.supplier_state ?? book?.taxes.supplierStateCode ?? '36',
      bikeHours: Number(r.bike_hours),
      firstDay: r.first_day,
      lastDay: r.last_day,
      ...(r.poc_ref ? { pocMonth: r.poc_ref.slice(-7) } : {}),
    };
  });
}

/** The business's documents in a financial year ("2027-28"), newest first, and the years it has
 * any in (newest first). */
export async function brandDocuments(
  c: Q,
  brandId: string,
  fy: string | null,
  now: number,
): Promise<{ years: string[]; fy: string; documents: TaxDocument[]; truncated: boolean }> {
  const ys = await c.query<{ fy: string }>(
    'SELECT DISTINCT fy FROM gst_documents WHERE brand_id = $1 ORDER BY fy DESC',
    [brandId],
  );
  const years = ys.rows.map((r) => r.fy);
  const year = fy && /^\d{4}-\d{2}$/.test(fy) ? fy : (years[0] ?? financialYearOf(indiaDate(now)));
  const r = await c.query<Row>(
    `${SELECT} WHERE d.brand_id = $1 AND d.fy = $2 ORDER BY d.issued_at DESC, d.doc_no DESC
      LIMIT ${MAX_YEAR_DOCUMENTS + 1}`,
    [brandId, year],
  );
  return {
    years,
    fy: year,
    documents: await shaped(c, r.rows.slice(0, MAX_YEAR_DOCUMENTS)),
    truncated: r.rows.length > MAX_YEAR_DOCUMENTS,
  };
}

/** One document of the business, or undefined (not theirs and not there look the same). */
export async function brandDocument(
  c: Q,
  brandId: string,
  docNo: string,
): Promise<TaxDocument | undefined> {
  const r = await c.query<Row>(`${SELECT} WHERE d.brand_id = $1 AND d.doc_no = $2`, [
    brandId,
    docNo,
  ]);
  return (await shaped(c, r.rows))[0];
}
