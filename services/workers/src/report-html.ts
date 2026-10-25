// P1.9.2: the final report as one self-contained web page (also the body of the email). Night Signal,
// light theme, colours written out (email apps drop CSS variables). Every text from outside (area and
// street names, ids) is escaped.
import { heatRamp, resolve, themes } from '@recall/design';
import {
  deliveredText,
  formatIndiaTime,
  formatRupees,
  indianNumber,
  paise,
  reportPeriod,
  reportSummary,
  type CampaignReport,
} from '@recall/domain';
import { drawHeat } from './report-heat.js';

const C = themes.light;
const HEAT = resolve('light', heatRamp.light);

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

/** "10:00–11:00" for a start hour (24 → 00:00, 25 → 01:00). */
export const hourText = (h: number) => {
  const two = (x: number) => String(x % 24).padStart(2, '0');
  return `${two(h)}:00–${two(h + 1)}:00`;
};

function heatSvg(r: CampaignReport): string {
  const hexes = drawHeat(r.heatMap, 640, 360, HEAT.length);
  if (hexes.length === 0) return '<p class="muted">No plays to map.</p>';
  const shapes = hexes
    .map(
      (h) =>
        `<polygon points="${h.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="${HEAT[h.step] ?? C.ink}" stroke="${C['surface-1']}" stroke-width="1"><title>${indianNumber(h.plays)} plays</title></polygon>`,
    )
    .join('');
  return `<svg viewBox="0 0 640 360" width="100%" role="img" aria-label="Heat map of where the ads played">${shapes}</svg>`;
}

export function renderReportHtml(r: CampaignReport): string {
  const e = escapeHtml;
  const tile = (label: string, value: string, note = '') =>
    `<div class="tile"><div class="label">${e(label)}</div><div class="value">${e(value)}</div>${note ? `<div class="muted">${e(note)}</div>` : ''}</div>`;
  const rows = r.lines
    .map(
      (l) =>
        `<tr><td>${e(l.date)}</td><td>${hourText(l.startHour)}</td><td class="area">${e(l.areaName)}</td><td class="n">${l.bikes}</td><td class="n">${indianNumber(l.promised)}</td><td class="n">${indianNumber(l.delivered)}</td><td class="n">${indianNumber(l.madeUp)}</td><td class="n">${indianNumber(l.missing)}</td></tr>`,
    )
    .join('');
  const streets =
    r.streets.length === 0
      ? '<p class="muted">No street names for these places yet.</p>'
      : `<ol>${r.streets.map((s) => `<li>${e(s.name)} <span class="muted">· ${indianNumber(s.plays)} plays</span></li>`).join('')}</ol>`;
  const refund =
    r.refund && r.refund.status !== 'rejected'
      ? `<section><h2>Refund</h2><p>${indianNumber(r.missing)} plays could not be made up. ${e(formatRupees(paise(r.refund.paise)))} plus GST ${r.refund.status === 'approved' ? 'is refunded; a credit note is on its way' : 'is being processed'}.</p></section>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Campaign report ${e(r.bookingId)}</title>
<style>
  body { margin: 0; background: ${C['surface-0']}; color: ${C.ink}; font-family: "Anek Latin", Arial, sans-serif; line-height: 1.45; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { font-weight: 700; letter-spacing: 0.08em; }
  h1 { font-size: 28px; margin: 8px 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 8px; }
  .muted { color: ${C['ink-muted']}; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 24px; }
  .tile { background: ${C['surface-1']}; border: 1px solid ${C.line}; border-radius: 14px; padding: 16px; }
  .label { font-size: 13px; color: ${C['ink-muted']}; }
  .value { font-size: 18px; white-space: nowrap; font-weight: 700; font-family: "IBM Plex Mono", "Courier New", monospace; }
  .card { background: ${C['surface-1']}; border: 1px solid ${C.line}; border-radius: 14px; padding: 8px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid ${C.line}; white-space: nowrap; }
  td.area { white-space: normal; }
  td.n, th.n { text-align: right; font-family: "IBM Plex Mono", "Courier New", monospace; }
  footer { margin-top: 40px; font-size: 13px; color: ${C['ink-muted']}; }
</style>
</head>
<body>
<main>
  <div class="brand">RECALL</div>
  <h1>Campaign report</h1>
  <div class="muted">${e(r.bookingId)} · ${e(reportPeriod(r))}</div>
  <p>${reportSummary(r).map(e).join('<br>')}</p>
  <div class="tiles">
    ${tile('Plays delivered', `${indianNumber(r.promised - r.missing)} / ${indianNumber(r.promised)}`, deliveredText(r.deliveredBp))}
    ${tile('Different bikes', indianNumber(r.bikes))}
    ${tile('Made-up plays', indianNumber(r.makeUps.plays))}
    ${tile('People (approximate)', `${indianNumber(r.people.low)}–${indianNumber(r.people.high)}`, 'estimate, never billed')}
  </div>
  <h2>Where your ads played</h2>
  <div class="card">${heatSvg(r)}</div>
  <p class="muted">Darker hexagons had more plays.</p>
  <h2>Busiest streets</h2>
  ${streets}
  ${refund}
  <h2>Hour by hour</h2>
  <div class="scroll"><table>
    <thead><tr><th>Day</th><th>Hour</th><th>Area</th><th class="n">Bikes</th><th class="n">Promised</th><th class="n">Delivered</th><th class="n">Made up</th><th class="n">Missing</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <footer>
    Plays are counted from each screen's signed records, inside the area you booked. People counts are estimates from the screen's camera, shown as a rounded range; only numbers leave the screen, never pictures. They are never billed or guaranteed. Prices are before GST.<br>
    Report made ${e(formatIndiaTime(new Date(r.builtAt * 1000)))}.
  </footer>
</main>
</body>
</html>
`;
}
