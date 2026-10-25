// P1.9.2: the final report as a PDF (A4), attached to the email and downloadable from the portal.
// Built with pdf-lib and its standard Helvetica, so it needs no font files; that font has no rupee
// sign, so amounts read "Rs." here (the web page shows ₹).
import { heatRamp, resolve, themes } from '@recall/design';
import {
  deliveredText,
  formatIndiaTime,
  indianNumber,
  reportPeriod,
  reportSummary,
  type CampaignReport,
} from '@recall/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { drawHeat } from './report-heat.js';
import { hourText } from './report-html.js';

const hex = (h: string) =>
  rgb(
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  );
const C = themes.light;
const HEAT = resolve('light', heatRamp.light).map(hex);

/** Text Helvetica can print: ₹ → "Rs. ", dashes and quotes kept, anything else outside it → "?". */
export function pdfSafe(s: string): string {
  return s.replaceAll('₹', 'Rs. ').replace(/[^\x20-\x7e–—‘’“”·]/g, '?');
}

const A4 = [595.28, 841.89] as const;
const M = 48;

export async function renderReportPdf(r: CampaignReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`RECALL campaign report ${r.bookingId}`);
  doc.setProducer('RECALL');
  doc.setCreationDate(new Date(r.builtAt * 1000));
  doc.setModificationDate(new Date(r.builtAt * 1000));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([...A4]);
  let y = A4[1] - M;
  const text = (t: string, size: number, f: PDFFont = font, x = M, color = hex(C.ink)) =>
    page.drawText(pdfSafe(t), { x, y, size, font: f, color });
  const newPageIfBelow = (need: number) => {
    if (y - need > M) return;
    page = doc.addPage([...A4]);
    y = A4[1] - M;
  };
  /** Wraps a paragraph to the page width. */
  const para = (t: string, size: number, color = hex(C.ink)) => {
    const words = pdfSafe(t).split(' ');
    let lineText = '';
    for (const w of words) {
      const next = lineText ? `${lineText} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > A4[0] - 2 * M && lineText) {
        newPageIfBelow(size + 4);
        text(lineText, size, font, M, color);
        y -= size + 4;
        lineText = w;
      } else lineText = next;
    }
    if (lineText) {
      newPageIfBelow(size + 4);
      text(lineText, size, font, M, color);
      y -= size + 4;
    }
  };

  text('RECALL', 11, bold);
  y -= 26;
  text('Campaign report', 22, bold);
  y -= 18;
  text(`${r.bookingId} · ${reportPeriod(r)}`, 11, font, M, hex(C['ink-muted']));
  y -= 24;
  for (const s of reportSummary(r)) para(s, 11);
  y -= 8;

  // Stat tiles
  const tiles: [string, string, string][] = [
    [
      'Plays delivered',
      `${indianNumber(Math.min(r.delivered, r.promised))} / ${indianNumber(r.promised)}`,
      deliveredText(r.deliveredBp),
    ],
    ['Different bikes', indianNumber(r.bikes), ''],
    ['Made-up plays', indianNumber(r.makeUps.plays), ''],
    [
      'People (approx.)',
      `${indianNumber(r.people.low)}–${indianNumber(r.people.high)}`,
      'never billed',
    ],
  ];
  const tw = (A4[0] - 2 * M - 3 * 8) / 4;
  tiles.forEach(([label, value, note], i) => {
    const x = M + i * (tw + 8);
    page.drawRectangle({
      x,
      y: y - 62,
      width: tw,
      height: 62,
      color: hex(C['surface-1']),
      borderColor: hex(C.line),
      borderWidth: 1,
    });
    page.drawText(pdfSafe(label), {
      x: x + 8,
      y: y - 16,
      size: 8,
      font,
      color: hex(C['ink-muted']),
    });
    page.drawText(pdfSafe(value), { x: x + 8, y: y - 36, size: 13, font: bold, color: hex(C.ink) });
    if (note)
      page.drawText(pdfSafe(note), {
        x: x + 8,
        y: y - 52,
        size: 8,
        font,
        color: hex(C['ink-muted']),
      });
  });
  y -= 86;

  // Heat map
  text('Where your ads played', 14, bold);
  y -= 12;
  const mapW = A4[0] - 2 * M;
  const mapH = 260;
  const hexes = drawHeat(r.heatMap, mapW, mapH, HEAT.length);
  page.drawRectangle({
    x: M,
    y: y - mapH,
    width: mapW,
    height: mapH,
    color: hex(C['surface-1']),
    borderColor: hex(C.line),
    borderWidth: 1,
  });
  for (const h of hexes) {
    const path =
      h.points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join(' ') + ' Z';
    page.drawSvgPath(path, {
      x: M,
      y,
      color: HEAT[h.step] ?? hex(C.ink),
      borderColor: hex(C['surface-1']),
      borderWidth: 0.5,
    });
  }
  y -= mapH + 14;
  text('Darker hexagons had more plays.', 9, font, M, hex(C['ink-muted']));
  y -= 26;

  // Busiest streets
  newPageIfBelow(40 + r.streets.length * 15);
  text('Busiest streets', 14, bold);
  y -= 18;
  if (r.streets.length === 0)
    para('No street names for these places yet.', 10, hex(C['ink-muted']));
  r.streets.forEach((s, i) => {
    text(`${i + 1}. ${s.name} · ${indianNumber(s.plays)} plays`, 10);
    y -= 15;
  });
  y -= 10;

  if (r.refund && r.refund.status !== 'rejected') {
    newPageIfBelow(50);
    text('Refund', 14, bold);
    y -= 18;
    const rupees = `Rs. ${indianNumber(Math.trunc(r.refund.paise / 100))}.${String(r.refund.paise % 100).padStart(2, '0')}`;
    para(
      `${indianNumber(r.missing)} plays could not be made up. ${rupees} plus GST ${r.refund.status === 'approved' ? 'is refunded; a credit note is on its way.' : 'is being processed.'}`,
      10,
    );
    y -= 10;
  }

  // Hour by hour
  const cols: [string, number, boolean][] = [
    ['Day', M, false],
    ['Hour', M + 70, false],
    ['Area', M + 150, false],
    ['Bikes', M + 290, true],
    ['Promised', M + 340, true],
    ['Delivered', M + 395, true],
    ['Made up', M + 445, true],
    ['Missing', M + 490, true],
  ];
  const row = (cells: string[], f: PDFFont) => {
    cells.forEach((c, i) => {
      const [, x, right] = cols[i] ?? ['', M, false];
      const t = pdfSafe(c);
      page.drawText(t, {
        x: right ? x - f.widthOfTextAtSize(t, 9) + 30 : x,
        y,
        size: 9,
        font: f,
        color: hex(C.ink),
      });
    });
    y -= 14;
  };
  newPageIfBelow(60);
  text('Hour by hour', 14, bold);
  y -= 18;
  row(
    cols.map(([h]) => h),
    bold,
  );
  for (const l of r.lines) {
    if (y - 14 <= M) {
      page = doc.addPage([...A4]);
      y = A4[1] - M;
      row(
        cols.map(([h]) => h),
        bold,
      );
    }
    row(
      [
        l.date,
        hourText(l.startHour),
        l.areaName.slice(0, 28),
        String(l.bikes),
        indianNumber(l.promised),
        indianNumber(l.delivered),
        indianNumber(l.madeUp),
        indianNumber(l.missing),
      ],
      font,
    );
  }
  y -= 16;
  newPageIfBelow(60); // the footer stays in one piece
  para(
    "Plays are counted from each screen's signed records, inside the area you booked. People counts are estimates from the screen's camera, shown as a rounded range; only numbers leave the screen, never pictures. They are never billed or guaranteed. Prices are before GST.",
    8,
    hex(C['ink-muted']),
  );
  para(`Report made ${formatIndiaTime(new Date(r.builtAt * 1000))}.`, 8, hex(C['ink-muted']));
  return doc.save({ useObjectStreams: false });
}
