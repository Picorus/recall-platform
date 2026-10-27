// P5.8: invoices and credit notes as a PDF: a page each, the same bytes for the same documents,
// and every kind of document drawn (CGST + SGST, IGST, credit note, no GST number, company details
// not filled in yet).
import { DEFAULT_SETTINGS, type TaxDocument } from '@recall/domain';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { renderTaxDocumentsPdf } from '../src/tax-document-pdf.js';

const INVOICE: TaxDocument = {
  docNo: 'RC/27-28/000001',
  kind: 'invoice',
  issuedAt: Date.UTC(2027, 6, 1, 4, 30) / 1000,
  againstDoc: null,
  bookingId: 'BK-1',
  brandId: 'irani-chai',
  legalName: 'Irani Chai Private Limited',
  gstin: '36AABCU9603R1ZO',
  gstinHeld: false,
  placeOfSupply: '36',
  sac: '998365',
  taxablePaise: 4_800_000,
  cgstPaise: 432_000,
  sgstPaise: 432_000,
  igstPaise: 0,
  totalPaise: 5_664_000,
  gstBp: 1_800,
  recipientAddress: '12 Road No. 36, Jubilee Hills, Hyderabad 500033',
  supplier: {
    legalName: 'Recall Media Private Limited',
    gstin: '36AABCU9603R1ZO',
    address: 'Plot 1, Madhapur, Hyderabad 500081, Telangana',
  },
  supplierState: '36',
  bikeHours: 160,
  firstDay: '2027-08-23',
  lastDay: '2027-08-29',
};
const OTHER_STATE: TaxDocument = {
  ...INVOICE,
  docNo: 'RC/27-28/000002',
  gstin: null,
  gstinHeld: true,
  placeOfSupply: '27',
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 864_000,
};
const CREDIT: TaxDocument = {
  ...INVOICE,
  docNo: 'CN/27-28/000001',
  kind: 'credit-note',
  againstDoc: 'RC/27-28/000001',
  taxablePaise: 100_000,
  cgstPaise: 9_000,
  sgstPaise: 9_000,
  totalPaise: 118_000,
};
describe('tax documents as a PDF (P5.8)', () => {
  it('a page each, every kind drawn, with or without the company details', async () => {
    for (const supplier of [INVOICE.supplier, DEFAULT_SETTINGS.company]) {
      const docs = [INVOICE, OTHER_STATE, CREDIT].map((d) => ({ ...d, supplier }));
      const bytes = await renderTaxDocumentsPdf(docs);
      expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    }
  });
  it('the same documents give the same file', async () => {
    const a = await renderTaxDocumentsPdf([INVOICE]);
    const b = await renderTaxDocumentsPdf([INVOICE]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
