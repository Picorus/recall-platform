import { launchAreas, lineIdOf, lineStartsAt, PRICE_BOOK_V1 } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { decideRefund } from '../../src/earnings.js';
import {
  accountantExport,
  gstSummary,
  recordPartnerInvoice,
  setBrandTaxProfile,
} from '../../src/gst.js';
import { createAccount } from '../../src/brands.js';
import { accountTotals, post } from '../../src/ledger.js';
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
      'partner-invoices-2027-07.csv',
      'journal-2027-07.csv',
      'gst-summary-2027-07.csv',
    ]);
    const inv = files[0]?.csv.split('\r\n') ?? [];
    expect(inv[0]).toBe(
      'number,date,booking,customer,gstin,place of supply,sac,taxable,cgst,sgst,igst,total',
    );
    expect(inv[2]).toBe(
      'RC/27-28/000002,2027-07-01,BK-G2,Mumbai Retail LLP,27AAPFU0939F1ZV,27,998365,1500.00,0.00,0.00,270.00,1770.00',
    );
    const postings = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE to_char(e.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = '2027-07'`,
    );
    expect((files[3]?.csv.trim().split('\r\n').length ?? 0) - 1).toBe(postings.rows[0]?.n);
  });

  it('credit notes copy their invoice: the brand changing its tax details later changes nothing', async () => {
    await book('BK-G5', 'brand-mum', 21);
    // The brand moves its registration to Telangana after it was invoiced.
    await setBrandTaxProfile(
      pool,
      'brand-mum',
      { legalName: 'Mumbai Retail (Hyd branch)', gstin: '36AAPFU0939F1ZW', stateCode: '36' },
      'priya',
    );
    const start = lineStartsAt({ date: DATE, startHour: 21 });
    await moveBooking(
      pool,
      'BK-G5',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand pulled out' },
      start - 5 * 86_400,
    );
    await settleDue(pool, start - 5 * 86_400 + 60);
    const line = lineIdOf('BK-G5', 'hyd-madhapur', DATE, 21);
    await decideRefund(
      pool,
      `${line}#refund`,
      'approved',
      SUPER,
      'cancelled early',
      start - 5 * 86_400 + 120,
    );
    const r = await pool.query(
      `SELECT n.legal_name = i.legal_name AS same_name, n.gstin = i.gstin AS same_gstin,
              n.place_of_supply = i.place_of_supply AS same_place
         FROM gst_documents n JOIN gst_documents i ON i.doc_no = n.against_doc
        WHERE n.booking_id = 'BK-G5'`,
    );
    expect(r.rows).toEqual([{ same_name: true, same_gstin: true, same_place: true }]);
  });

  it('several credit notes against one invoice add back to its CGST and SGST exactly', async () => {
    // Two lines, refunded one by one: each line's credit note takes CGST / SGST from what is left.
    await createBooking(
      pool,
      {
        bookingId: 'BK-G6',
        brandId: 'brand-hyd',
        request: {
          lines: [
            { areaId: 'hyd-madhapur', date: DATE, startHour: 22, bikes: 5 },
            { areaId: 'hyd-kondapur', date: DATE, startHour: 22, bikes: 7 },
          ],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-G6', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-G6', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    const start = lineStartsAt({ date: DATE, startHour: 22 });
    await moveBooking(
      pool,
      'BK-G6',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand pulled out' },
      start - 5 * 86_400,
    );
    await settleDue(pool, start - 5 * 86_400 + 60);
    for (const area of ['hyd-madhapur', 'hyd-kondapur'])
      await decideRefund(
        pool,
        `${lineIdOf('BK-G6', area, DATE, 22)}#refund`,
        'approved',
        SUPER,
        'cancelled early',
        start - 5 * 86_400 + 120,
      );
    const r = await pool.query(
      `SELECT kind, sum(taxable_paise)::int AS taxable, sum(cgst_paise)::int AS cgst, sum(sgst_paise)::int AS sgst
         FROM gst_documents WHERE booking_id = 'BK-G6' GROUP BY kind ORDER BY kind`,
    );
    const [cn, inv] = r.rows;
    expect(cn).toMatchObject({
      kind: 'credit-note',
      taxable: inv.taxable,
      cgst: inv.cgst,
      sgst: inv.sgst,
    });
  });

  it("a partner's GST is claimed back only with its invoice recorded, never more than was booked", async () => {
    // RECALL booked ₹21.60 GST on AdFirst's cut (as a cut entry would).
    await post(
      pool,
      {
        entryId: 'test:itc:1',
        at: Date.UTC(2027, 7, 10) / 1000,
        kind: 'manual-adjustment',
        ref: 'adfirst',
        memo: 'GST on a cut (test)',
        postings: [
          { account: 'gst-input', debit: 2_160, credit: 0, party: 'adfirst' },
          { account: 'agency-payable', debit: 0, credit: 2_160, party: 'adfirst' },
        ],
      },
      'test',
    );
    const before = await gstSummary(pool, '2027-08');
    expect([before.inputTaxCredit, before.inputGstAwaitingInvoices]).toEqual([0, 2_160]);
    const inv = {
      partnerId: 'adfirst',
      invoiceNo: 'AF/104',
      invoiceDate: '2027-08-31',
      gstin: '27AAPFU0939F1ZV',
      taxablePaise: 12_000,
      gstPaise: 2_160,
    };
    const noGstin = {
      partnerId: inv.partnerId,
      invoiceNo: 'AF/998',
      invoiceDate: inv.invoiceDate,
      taxablePaise: inv.taxablePaise,
      gstPaise: inv.gstPaise,
    };
    await expect(
      recordPartnerInvoice(pool, { ...inv, invoiceNo: 'AF/999', gstPaise: 9_999 }, 'meena'),
    ).rejects.toThrow(/booked only/);
    await expect(recordPartnerInvoice(pool, noGstin, 'meena')).rejects.toThrow(/GSTIN/);
    await recordPartnerInvoice(pool, inv, 'meena');
    await expect(recordPartnerInvoice(pool, inv, 'meena')).rejects.toThrow(); // same number twice
    const after = await gstSummary(pool, '2027-08');
    expect([after.inputTaxCredit, after.inputGstAwaitingInvoices]).toEqual([2_160, 0]);
    const files = await accountantExport(pool, '2027-08');
    expect(files[2]?.csv).toContain('adfirst,AF/104,2027-08-31,27AAPFU0939F1ZV,120.00,21.60');
  });

  it('a document can never be changed or deleted', async () => {
    await expect(
      pool.query("UPDATE gst_documents SET legal_name = 'X' WHERE n = 1"),
    ).rejects.toThrow();
    await expect(pool.query('DELETE FROM gst_documents')).rejects.toThrow();
  });

  it('a GST number goes on an invoice only when safe: staff-set, or from the GST record and on no other account (P5.8)', async () => {
    for (const id of ['brand-real', 'brand-copy', 'brand-typed'])
      await createAccount(
        pool,
        {
          brandId: id,
          kind: 'brand',
          details: { name: id, agencyId: null, referredBy: null, active: true },
          by: 'priya',
          reason: 'test',
        },
        BOOKED - 3600,
      );
    const gstin = '36AABCU9603R1ZO';
    const lookup = async () =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO gst_lookups (gstin, asker, status, legal_name, state_code, active, at)
           VALUES ($1, '+919800000001', 'found', 'Real Foods Pvt Ltd', '36', true, now()) RETURNING id`,
          [gstin],
        )
      ).rows[0]?.id;
    const fromRecord = async (brand: string) =>
      pool.query(
        `INSERT INTO brand_tax_profiles (brand_id, set_at, legal_name, gstin, state_code, set_by, source, gst_lookup_id)
         VALUES ($1, to_timestamp($2), 'Real Foods Pvt Ltd', $3, '36', 'portal', 'gst-record', $4)`,
        [brand, BOOKED - 1800, gstin, await lookup()],
      );
    // From the record, on one account: printed.
    await fromRecord('brand-real');
    await book('BK-P1', 'brand-real', 9);
    // Typed by the brand: held back.
    await pool.query(
      `INSERT INTO brand_tax_profiles (brand_id, set_at, legal_name, gstin, state_code, set_by, source)
       VALUES ('brand-typed', to_timestamp($1), 'Typed Co', '27AAPFU0939F1ZV', '27', 'portal', 'typed')`,
      [BOOKED - 1800],
    );
    await book('BK-P2', 'brand-typed', 10);
    // Someone else sets up the same number later: both accounts' next invoices hold it back.
    await pool.query(
      `INSERT INTO brand_tax_profiles (brand_id, set_at, legal_name, gstin, state_code, set_by, source, gst_lookup_id)
       VALUES ('brand-copy', to_timestamp($1), 'Real Foods Pvt Ltd', $2, '36', 'portal', 'gst-record', $3)`,
      [BOOKED - 900, gstin, await lookup()],
    );
    await book('BK-P3', 'brand-copy', 11);
    await book('BK-P4', 'brand-real', 12);
    // Staff check the certificate and set the real one's details: printed again.
    await pool.query(
      `INSERT INTO brand_tax_profiles (brand_id, set_at, legal_name, gstin, state_code, set_by)
       VALUES ('brand-real', to_timestamp($1), 'Real Foods Pvt Ltd', $2, '36', 'priya')`,
      [BOOKED - 600, gstin],
    );
    await book('BK-P5', 'brand-real', 13);
    const r = await pool.query<{
      booking_id: string;
      gstin: string | null;
      gstin_held: string | null;
      gstin_held_why: string | null;
    }>(
      `SELECT booking_id, gstin, gstin_held, gstin_held_why FROM gst_documents
        WHERE booking_id LIKE 'BK-P%' ORDER BY booking_id`,
    );
    expect(r.rows).toEqual([
      { booking_id: 'BK-P1', gstin, gstin_held: null, gstin_held_why: null },
      { booking_id: 'BK-P2', gstin: null, gstin_held: '27AAPFU0939F1ZV', gstin_held_why: 'typed' },
      { booking_id: 'BK-P3', gstin: null, gstin_held: gstin, gstin_held_why: 'shared' },
      { booking_id: 'BK-P4', gstin: null, gstin_held: gstin, gstin_held_why: 'shared' },
      { booking_id: 'BK-P5', gstin, gstin_held: null, gstin_held_why: null },
    ]);
    const s = await gstSummary(pool, '2027-07');
    expect(s.gstinHeld.map((h) => h.why)).toEqual(['typed', 'shared', 'shared']);
  });
});
