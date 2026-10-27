// P4.5: a rider's monthly statement, a printable page (the phone's browser saves it as a PDF). The
// app asks for a link (signed, his and that month only, working 15 minutes) and opens it: the page
// needs no sign-in token, so it opens in any browser, and the link is no use to anyone after.
import { formatRupees, paise } from '@recall/domain';
import { riderEarnings, type RiderEarnings } from '@recall/db';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

const LIFE_SECONDS = 15 * 60;

const key = (secret: Buffer) => createHmac('sha256', secret).update('rider-statements').digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A link token for his statement of `month`, working 15 minutes from `now`. */
export function statementToken(secret: Buffer, riderId: string, month: string, now: number) {
  const body = b64(`${riderId}|${month}|${now + LIFE_SECONDS}`);
  return `${body}.${b64(createHmac('sha256', key(secret)).update(body).digest())}`;
}

/** Whose statement and which month a token is for, or null when it is not ours or has run out. */
export function readStatementToken(
  secret: Buffer,
  token: string,
  now: number,
): { riderId: string; month: string } | null {
  const parts = token.split('.');
  const [body, sig] = parts;
  if (parts.length !== 2 || !body || !sig || token.length > 300) return null;
  const want = createHmac('sha256', key(secret)).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const [riderId, month, until] = Buffer.from(body, 'base64url').toString().split('|');
  if (!riderId || !month || !until || !(Number(until) >= now)) return null;
  return { riderId, month };
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const rupees = (p: number) => formatRupees(paise(p));
const hours = (s: number) => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
const dateOf = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** The statement page (English: a document he may hand to a bank or the tax office). */
export function statementHtml(
  e: RiderEarnings,
  who: { readonly riderId: string; readonly name: string },
): string {
  const rows = e.days
    .map(
      (d) =>
        `<tr><td>${dateOf(d.day)}</td><td>${hours(d.countedSeconds)}</td><td class="n">${rupees(d.earnedPaise)}</td></tr>`,
    )
    .join('');
  const line = (label: string, p: number) =>
    `<tr><td>${esc(label)}</td><td class="n">${rupees(p)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RECALL statement ${esc(e.month)} · ${esc(who.riderId)}</title>
<style>
body{font-family:system-ui,sans-serif;color:#111;margin:24px;max-width:720px}
h1{font-size:22px;margin:0 0 4px}table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;font-size:14px}
.n{text-align:right;font-variant-numeric:tabular-nums}.muted{color:#555;font-size:13px}
.total td{font-weight:700;border-top:2px solid #111}
</style></head><body>
<h1>RECALL rider statement</h1>
<p>${esc(who.name)} · ${esc(who.riderId)} · ${esc(e.month)}${e.closed ? '' : ' (month not yet closed: figures so far)'}</p>
<p class="muted">To keep it: your browser's menu, then Share or Print, then Save as PDF.</p>
<table><tbody>
${line(`Moving hours paid: ${hours(e.paidSeconds)} × ${rupees(e.perMovingHourPaise)} (up to ${e.monthlyCapHours} h a month; ${hours(e.countedSeconds)} counted)`, e.hourlyPaise)}
${e.pocPaise > 0 ? line('Test-period (POC) daily pay', e.pocPaise) : ''}
${line('Share of sales', e.soldPaise)}
${e.adjustmentPaise !== 0 ? line('Adjusted as paid (hours that arrived after the month closed are not paid)', e.adjustmentPaise) : ''}
${e.bonusPaise > 0 ? line('Founding bonus', e.bonusPaise) : ''}
<tr class="total"><td>Total before tax</td><td class="n">${rupees(e.totalPaise)}</td></tr>
</tbody></table>
<p class="muted">TDS is held back when you are paid, at the rate the law sets, and shown on your tax certificate. Payouts go to your checked bank or UPI every Monday.</p>
<table><thead><tr><th>Day</th><th>Moving hours</th><th class="n">Earned</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Made ${esc(new Date(e.at * 1000).toISOString().slice(0, 10))}. Moving hours are counted by the screen on your bike, inside the pay zone and business hours.</p>
</body></html>`;
}

/** The page for a token, or null. */
export async function statementPage(
  pool: Pool,
  secret: Buffer,
  token: string,
  now: number,
): Promise<string | null> {
  const t = readStatementToken(secret, token, now);
  if (!t) return null;
  const r = await pool.query<{ name: string }>(
    'SELECT name FROM rider_versions WHERE rider_id = $1 ORDER BY version DESC LIMIT 1',
    [t.riderId],
  );
  const name = r.rows[0]?.name;
  if (!name) return null;
  return statementHtml(await riderEarnings(pool, t.riderId, t.month, now), {
    riderId: t.riderId,
    name,
  });
}
