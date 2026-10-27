// P5.8: tax invoices and credit notes as a PDF (A4), one document a page: one to download, or all of
// a year's in one file. RECALL's legal name, GSTIN and address come from the company setting; until
// they are filled in, each page says plainly it is not a valid tax invoice yet. Helvetica has no
// rupee sign, so amounts read "Rs." (pdfSafe).
import { themes } from '@recall/design';
import {
  companySet,
  formatIndiaTime,
  formatRupees,
  paise,
  stateName,
  type CompanyDetails,
  type TaxDocument,
} from '@recall/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { pdfSafe } from './report-pdf.js';

const hex = (h: string) =>
  rgb(
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  );
const C = themes.light;
const A4 = [595.28, 841.89] as const;
const M = 48;

const rs = (p: number) => formatRupees(paise(p));
const dayText = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const rate = (bp: number) => `${bp / 100}%`;

function drawOne(
  page: PDFPage,
  d: TaxDocument,
  company: CompanyDetails,
  supplierState: string,
  font: PDFFont,
  bold: PDFFont,
) {
  let y = A4[1] - M;
  const at = (t: string, x: number, size: number, f = font, color = hex(C.ink)) =>
    page.drawText(pdfSafe(t), { x, y, size, font: f, color });
  const right = (t: string, xRight: number, size: number, f = font) =>
    at(t, xRight - f.widthOfTextAtSize(pdfSafe(t), size), size, f);
  const muted = hex(C['ink-muted']);

  at(d.kind === 'invoice' ? 'TAX INVOICE' : 'CREDIT NOTE', M, 18, bold);
  right(d.docNo, A4[0] - M, 12, bold);
  y -= 16;
  right(`Date: ${formatIndiaTime(new Date(d.issuedAt * 1000)).slice(0, 10)}`, A4[0] - M, 10);
  if (d.againstDoc) {
    y -= 14;
    right(`Against invoice ${d.againstDoc}`, A4[0] - M, 10);
  }
  y -= 28;

  if (!companySet(company)) {
    page.drawRectangle({
      x: M,
      y: y - 30,
      width: A4[0] - 2 * M,
      height: 40,
      color: hex(C['surface-1']),
      borderColor: hex(C.line),
      borderWidth: 1,
    });
    y -= 8;
    at(
      "Not a valid tax invoice yet: RECALL's company details are not filled in.",
      M + 10,
      10,
      bold,
    );
    y -= 14;
    at('Download it again once they are: the same document, with them.', M + 10, 9);
    y -= 36;
  }

  // From and to.
  const colX = A4[0] / 2 + 8;
  const top = y;
  at('From', M, 9, font, muted);
  y -= 14;
  at(company.legalName || 'RECALL', M, 11, bold);
  y -= 14;
  if (company.gstin) {
    at(`GSTIN ${company.gstin}`, M, 10);
    y -= 13;
  }
  for (const line of wrap(company.address, font, 9, A4[0] / 2 - M - 16)) {
    at(line, M, 9);
    y -= 12;
  }
  at(`State: ${stateName(supplierState) ?? supplierState} (${supplierState})`, M, 9);
  const leftEnd = y;
  y = top;
  at('Billed to', colX, 9, font, muted);
  y -= 14;
  at(d.legalName, colX, 11, bold);
  y -= 14;
  at(d.gstin ? `GSTIN ${d.gstin}` : 'GSTIN: not given', colX, 10);
  y -= 13;
  at(
    `Place of supply: ${stateName(d.placeOfSupply) ?? d.placeOfSupply} (${d.placeOfSupply})`,
    colX,
    9,
  );
  y -= 12;
  at(`Account: ${d.brandId}`, colX, 9);
  y = Math.min(y, leftEnd) - 30;

  // The line.
  const cols = [M, M + 280, A4[0] - M];
  page.drawLine({
    start: { x: M, y: y + 12 },
    end: { x: A4[0] - M, y: y + 12 },
    color: hex(C.line),
  });
  at('Description', cols[0] ?? M, 9, bold);
  at('SAC', cols[1] ?? M, 9, bold);
  right('Amount', cols[2] ?? M, 9, bold);
  y -= 18;
  const what =
    d.kind === 'invoice'
      ? `Advertising on RECALL moving screens: booking ${d.bookingId}`
      : `Refund for plays not delivered: booking ${d.bookingId}`;
  at(what, cols[0] ?? M, 10);
  at(d.sac, cols[1] ?? M, 10);
  right(rs(d.taxablePaise), cols[2] ?? M, 10);
  y -= 13;
  at(
    `${d.bikeHours.toLocaleString('en-IN')} bike-hours, ${dayText(d.firstDay)} to ${dayText(d.lastDay)}`,
    cols[0] ?? M,
    9,
    font,
    muted,
  );
  y -= 20;
  page.drawLine({
    start: { x: M, y: y + 10 },
    end: { x: A4[0] - M, y: y + 10 },
    color: hex(C.line),
  });

  const sums: [string, number, boolean][] = [['Taxable value', d.taxablePaise, false]];
  if (
    d.igstPaise > 0 ||
    (d.cgstPaise === 0 && d.sgstPaise === 0 && d.placeOfSupply !== supplierState)
  )
    sums.push([`IGST ${rate(d.gstBp)}`, d.igstPaise, false]);
  else
    sums.push(
      [`CGST ${rate(d.gstBp / 2)}`, d.cgstPaise, false],
      [`SGST ${rate(d.gstBp / 2)}`, d.sgstPaise, false],
    );
  sums.push([d.kind === 'invoice' ? 'Total' : 'Total credited', d.totalPaise, true]);
  for (const [label, amount, strong] of sums) {
    y -= 4;
    at(label, cols[1] ?? M, strong ? 11 : 10, strong ? bold : font);
    right(rs(amount), cols[2] ?? M, strong ? 11 : 10, strong ? bold : font);
    y -= 16;
  }
  y -= 24;
  at(
    'Paid in full in advance. Billed by bike-hours of screen time, never by views.',
    M,
    9,
    font,
    muted,
  );
  y -= 12;
  at('Tax is not payable on reverse charge.', M, 9, font, muted);
}

function wrap(t: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of pdfSafe(t).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}

/** The documents in one PDF, a page each, in the order given. */
export async function renderTaxDocumentsPdf(
  docs: readonly TaxDocument[],
  company: CompanyDetails,
  supplierState: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const first = docs[0];
  pdf.setTitle(
    docs.length === 1 && first ? `RECALL ${first.docNo}` : 'RECALL invoices and credit notes',
  );
  pdf.setProducer('RECALL');
  // Same documents, same bytes: dates from the documents, not the clock.
  const when = new Date((first?.issuedAt ?? 0) * 1000);
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const d of docs) drawOne(pdf.addPage([...A4]), d, company, supplierState, font, bold);
  if (docs.length === 0) pdf.addPage([...A4]);
  return pdf.save();
}
