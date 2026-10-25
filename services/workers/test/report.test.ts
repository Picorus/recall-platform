import {
  campaignReport,
  DEFAULT_REPORT_RULES,
  peopleEstimate,
  type LineForReport,
  type PlacedPlay,
} from '@recall/domain';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { drawHeat } from '../src/report-heat.js';
import { escapeHtml, renderReportHtml } from '../src/report-html.js';
import { pdfSafe, renderReportPdf } from '../src/report-pdf.js';

const spread = (screenId: string, n: number): PlacedPlay[] =>
  Array.from({ length: n }, (_, i) => ({
    screenId,
    latE6: 17_440_000 + (i % 30) * 400,
    lngE6: 78_380_000 + Math.floor(i / 30) * 500,
  }));

export function sample(lines = 2): ReturnType<typeof campaignReport> {
  const ls: LineForReport[] = Array.from({ length: lines }, (_, i) => ({
    lineId: `BK-S/hyd-madhapur/2027-09-${String(1 + Math.floor(i / 18)).padStart(2, '0')}/${8 + (i % 18)}`,
    areaId: 'hyd-madhapur',
    areaName: i === 0 ? 'Madhapur <script>alert(1)</script>' : 'Madhapur',
    date: `2027-09-${String(1 + Math.floor(i / 18)).padStart(2, '0')}`,
    startHour: 8 + (i % 18),
    bikes: 5,
    promised: 1_000,
    hourPlays: spread(`s${i % 7}`, i === 1 ? 600 : 1_000),
    makeUpPlays: i === 1 ? spread('s9', 100) : [],
    ...(i === 1 ? { refund: { paise: 37_500, status: 'under review' as const } } : {}),
  }));
  return campaignReport({
    bookingId: 'BK-S',
    brandId: 'b-s',
    from: 0,
    until: 3600,
    builtAt: Date.UTC(2027, 9, 2, 5) / 1000,
    lines: ls,
    makeUpsOpened: 1,
    streetOf: new Map(),
    people: peopleEstimate(17_000),
    rules: DEFAULT_REPORT_RULES,
  });
}

describe('the report page and PDF (P1.9.2)', () => {
  it('the page shows the summary, the people range marked approximate, every line, and escapes outside text', () => {
    const html = renderReportHtml(sample());
    expect(html).toContain('1,700 of 2,000 plays delivered (85%) on 3 different bikes.');
    expect(html).toContain('14,000–20,000 people (approximate)');
    expect(html).toContain('₹375.00');
    expect(html).toContain('<polygon');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  it('the PDF is a real A4 PDF, the same bytes every time, with more pages for long campaigns', async () => {
    const a = await renderReportPdf(sample());
    expect(Buffer.from(a.slice(0, 5)).toString()).toBe('%PDF-');
    expect(Buffer.from(await renderReportPdf(sample())).equals(Buffer.from(a))).toBe(true);
    const short = await PDFDocument.load(a);
    expect(short.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
    const long = await PDFDocument.load(await renderReportPdf(sample(180)));
    expect(long.getPageCount()).toBeGreaterThan(short.getPageCount());
  });

  it('text the PDF font cannot print is replaced, never crashes it', () => {
    expect(pdfSafe('₹375 – ok · మాదాపూర్')).toBe('Rs. 375 – ok · ????????');
  });

  it('heat map: every hexagon inside the box, the busiest in the darkest shade', () => {
    const r = sample();
    const hexes = drawHeat(r.heatMap, 640, 360, 3);
    expect(hexes).toHaveLength(r.heatMap.length);
    for (const h of hexes)
      for (const [x, y] of h.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(640);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(360);
      }
    expect(hexes[0]?.step).toBe(2);
    expect(drawHeat([], 640, 360, 3)).toEqual([]);
  });
});
