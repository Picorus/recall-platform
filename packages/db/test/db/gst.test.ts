import { launchAreas, lineIdOf, lineStartsAt, PRICE_BOOK_V1 } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { decideRefund } from '../../src/earnings.js';
import { accountantExport, gstSummary, setBrandTaxProfile } from '../../src/gst.js';
import { accountTotals } from '../../src/ledger.js';
import { settleDue } from '../../src/makeups.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000; // 1 July 2027, 10:00 India time
const DATE = '2027-08-24';
const SUPER = { id: 'prateek', role: 'super-admin' } as const;

async function book(id: string, brand: string, hour: number) {
  await createBooking(
    pool,
    {
      bookingId: id,
      brandId: brand,
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour: hour, bikes: 5 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, id, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, id, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
}, 60_000);
afterAll(async () => db.drop());

describe('GST and the books (P1.7.9)', () => {
  it('tax details are checked: GSTIN shape and check digit, and its state', async () => {
    await expect(
      setBrandTaxProfile(
        pool,
        'brand-x',
        { legalName: 'X Ltd', gstin: '27AAPFU0939F1ZX', stateCode: '27' },
        'priya',
      ),
    ).rejects.toThrow(/check digit/);
    await expect(
      setBrandTaxProfile(
        pool,
        'brand-x',
        { legalName: 'X Ltd', gstin: '27AAPFU0939F1ZV', stateCode: '36' },
        'priya',
      ),
    ).rejects.toThrow(/another state/);
    // A Maharashtra brand, and a Telangana brand not registered for GST.
    await setBrandTaxProfile(
      pool,
      'brand-mum',
      { legalName: 'Mumbai Retail LLP', gstin: '27AAPFU0939F1ZV', stateCode: '27' },
      'priya',
    );
    await setBrandTaxProfile(
      pool,
      'brand-hyd',
      { legalName: 'Hyderabad Foods', stateCode: '36' },
      'priya',
    );
  });

  it('a paid booking gets a numbered tax invoice at once: CGST + SGST in Telangana, IGST from another state', async () => {
    await book('BK-G1', 'brand-hyd', 18);
    await book('BK-G2', 'brand-mum', 19);
    await book('BK-G3', 'brand-new', 20); // no tax details yet
    const r = await pool.query(
      `SELECT doc_no, booking_id, place_of_supply, taxable_paise::int AS taxable, cgst_paise::int AS cgst,
              sgst_paise::int AS sgst, igst_paise::int AS igst, total_paise::int AS total
         FROM gst_documents ORDER BY n`,
    );
    expect(r.rows).toEqual([
      {
        doc_no: 'RC/27-28/000001',
        booking_id: 'BK-G1',
        place_of_supply: '36',
        taxable: 150_000,
        cgst: 13_500,
        sgst: 13_500,
        igst: 0,
        total: 177_000,
      },
      {
        doc_no: 'RC/27-28/000002',
        booking_id: 'BK-G2',
        place_of_supply: '27',
        taxable: 150_000,
        cgst: 0,
        sgst: 0,
        igst: 27_000,
        total: 177_000,
      },
      {
        doc_no: 'RC/27-28/000003',
        booking_id: 'BK-G3',
        place_of_supply: '36',
        taxable: 150_000,
        cgst: 13_500,
        sgst: 13_500,
        igst: 0,
        total: 177_000,
      },
    ]);
  });

  it('an approved refund gets a credit note against the invoice, with the invoice’s place of supply', async () => {
    const start = lineStartsAt({ date: DATE, startHour: 19 });
    await moveBooking(
      pool,
      'BK-G2',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand pulled out' },
      start - 5 * 86_400,
    );
    await settleDue(pool, start - 5 * 86_400 + 60);
    const line = lineIdOf('BK-G2', 'hyd-madhapur', DATE, 19);
    await decideRefund(
      pool,
      `${line}#refund`,
      'approved',
      SUPER,
      'cancelled early',
      start - 5 * 86_400 + 120,
    );
    const r = await pool.query(
      `SELECT doc_no, against_doc, place_of_supply, taxable_paise::int AS taxable, igst_paise::int AS igst
         FROM gst_documents WHERE kind = 'credit-note'`,
    );
    expect(r.rows).toEqual([
      {
        doc_no: 'CN/27-28/000001',
        against_doc: 'RC/27-28/000002',
        place_of_supply: '27',
        taxable: 150_000,
        igst: 27_000,
      },
    ]);
  });

  it("the month's summary agrees with the ledger, and shows invoices missing tax details", async () => {
    const july = await gstSummary(pool, '2027-07');
    expect(july.invoices).toEqual({
      count: 3,
      taxable: 450_000,
      cgst: 27_000,
      sgst: 27_000,
      igst: 27_000,
    });
    expect(july.netGstPayable).toBe(81_000);
    expect(july.missingTaxDetails).toEqual(['RC/27-28/000003']);
    expect(july.eInvoice).toBe('not needed');
    // The ledger's GST owed for July matches the documents.
    const owedJuly = await pool.query<{ n: string }>(
      `SELECT sum(p.credit - p.debit) AS n FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE p.account = 'gst-payable' AND e.at < to_timestamp($1)`,
      [Date.UTC(2027, 7, 1) / 1000 - 330 * 60],
    );
    expect(Number(owedJuly.rows[0]?.n)).toBe(july.netGstPayable + july.inputTaxCredit);
    const aug = await gstSummary(pool, '2027-08');
    expect(aug.creditNotes).toMatchObject({ count: 1, igst: 27_000 });
    expect(aug.netGstPayable).toBe(-27_000);
    expect(aug.yearTurnover).toBe(300_000);
    const all = await accountTotals(pool, 'gst-payable');
    expect(all.credit - all.debit).toBe(81_000 - 27_000);
  });

  it('files for the accountant: registers, journal and summary', async () => {
    const files = await accountantExport(pool, '2027-07');
    expect(files.map((f) => f.name)).toEqual([
      'invoices-2027-07.csv',
      'credit-notes-2027-07.csv',
      'journal-2027-07.csv',
      'gst-summary-2027-07.csv',
    ]);
    const inv = files[0]?.csv.split('\r\n') ?? [];
    expect(inv[0]).toBe(
      'number,date,booking,customer,gstin,place of supply,taxable,cgst,sgst,igst,total',
    );
    expect(inv[2]).toBe(
      'RC/27-28/000002,2027-07-01,BK-G2,Mumbai Retail LLP,27AAPFU0939F1ZV,27,1500.00,0.00,0.00,270.00,1770.00',
    );
    const postings = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE to_char(e.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = '2027-07'`,
    );
    expect((files[2]?.csv.trim().split('\r\n').length ?? 0) - 1).toBe(postings.rows[0]?.n);
  });

  it('a document can never be changed or deleted', async () => {
    await expect(
      pool.query("UPDATE gst_documents SET legal_name = 'X' WHERE n = 1"),
    ).rejects.toThrow();
    await expect(pool.query('DELETE FROM gst_documents')).rejects.toThrow();
  });
});
