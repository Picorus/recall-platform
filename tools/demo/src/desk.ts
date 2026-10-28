// The demo desk: one page with everything a person showing RECALL needs: where each app is, how to
// sign in (the staff code of the moment, the sign-in codes the stand-in WhatsApp and SMS "sent"), how
// many bikes are riding, and the stand-in payment page brands are sent to.
import type { Message } from '@recall/adapters';
import { totpCode } from '@recall/api';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AGENCY_EMAIL, BRAND_PHONE, riderOf, STAFF, STAFF_PASSWORD } from './world.js';

export interface DeskInfo {
  readonly urls: {
    readonly staff: string;
    readonly brand: string;
    readonly rider: string;
    readonly desk: string;
  };
  readonly totpSecret: string;
  /** The demo's clock (ms): the staff code follows it, as the API does. */
  readonly clock: () => number;
  readonly sent: readonly Message[];
  readonly stats: () => Record<string, number | string>;
  /** Pays a stand-in payment link (as the payment provider would), then where to go back to. */
  readonly pay: (linkId: string) => Promise<string>;
  readonly links: () => ReadonlyMap<string, { amountPaise: number; description?: string }>;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** The 6-digit code in a message the stand-in sent, if any. */
const codeOf = (m: Message): string => {
  const text = 'text' in m && typeof m.text === 'string' ? m.text : '';
  const params = 'params' in m && Array.isArray(m.params) ? m.params.join(' ') : '';
  return /\b(\d{6})\b/.exec(`${params} ${text}`)?.[1] ?? '';
};

const PAGE_STYLE = `
  :root { --bg:#0b1020; --card:#141b33; --ink:#eef1fb; --muted:#9aa4c4; --accent:#ffb020; --line:#26304f; }
  * { box-sizing:border-box; } body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:960px; margin:0 auto; padding:24px 16px 48px; } h1 { margin:0 0 4px; font-size:28px; }
  h2 { font-size:18px; margin:0 0 12px; } p.muted, .muted { color:var(--muted); }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); margin:20px 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
  a.btn, button { display:inline-block; background:var(--accent); color:#1a1300; font-weight:700; border:0; border-radius:8px; padding:10px 14px; text-decoration:none; cursor:pointer; font-size:15px; }
  code, .mono { font-family:ui-monospace,Menlo,monospace; } .big { font-size:34px; letter-spacing:4px; font-weight:800; color:var(--accent); }
  table { width:100%; border-collapse:collapse; } td,th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--line); font-size:14px; }
`;

function deskPage(d: DeskInfo, nowMs: number): string {
  const code = totpCode(d.totpSecret, Math.floor(nowMs / 30_000));
  const left = 30 - Math.floor((nowMs / 1000) % 30);
  const recent = [...d.sent]
    .reverse()
    .filter((m) => codeOf(m))
    .slice(0, 8);
  const s = d.stats();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>RECALL demo desk</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>RECALL demo desk</h1>
<p class="muted">Everything here is made up: no real money moves and no real message is sent. This page refreshes every 10 seconds.</p>
<div class="grid">
  <div class="card"><h2>Staff portal</h2><p>For RECALL's team: campaigns, fleet map, riders, money.</p><a class="btn" href="${esc(d.urls.staff)}" target="_blank">Open the staff portal</a></div>
  <div class="card"><h2>Brand portal</h2><p>For businesses: book, pay, choose ads, see reports.</p><a class="btn" href="${esc(d.urls.brand)}" target="_blank">Open the brand portal</a></div>
  <div class="card"><h2>Rider app</h2><p>For riders (the phone app, here in the browser).</p><a class="btn" href="${esc(d.urls.rider)}" target="_blank">Open the rider app</a></div>
</div>
<div class="grid">
  <div class="card"><h2>Staff sign-in</h2>
    <table><tr><th>Email</th><th>Who</th></tr>${STAFF.map((x) => `<tr><td class="mono">${esc(x.email)}</td><td>${esc(x.name)}</td></tr>`).join('')}</table>
    <p>Password: <b class="mono">${esc(STAFF_PASSWORD)}</b></p>
    <p>Code (changes every 30 seconds, ${left} s left):</p><div class="big mono">${code}</div></div>
  <div class="card"><h2>Brand and rider sign-in</h2>
    <p>Brand (Masala Chai Co): <b class="mono">${esc(BRAND_PHONE.slice(3))}</b></p>
    <p>Agency (Adwise Media): <b class="mono">${esc(AGENCY_EMAIL)}</b></p>
    <p>Rider (${esc(riderOf(0).name)}): <b class="mono">${esc(riderOf(0).phone.slice(3))}</b></p>
    <p class="muted">Ask for a code there; it appears below within a few seconds.</p>
    <table><tr><th>To</th><th>Code</th></tr>${
      recent.length === 0
        ? '<tr><td colspan="2" class="muted">No codes asked for yet.</td></tr>'
        : recent
            .map(
              (m) =>
                `<tr><td class="mono">${esc(m.to)}</td><td class="big mono" style="font-size:20px">${codeOf(m)}</td></tr>`,
            )
            .join('')
    }</table></div>
</div>
<div class="card"><h2>Right now</h2><table>${Object.entries(s)
    .map(
      ([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="mono">${esc(typeof v === 'number' ? v.toLocaleString('en-IN') : v)}</td></tr>`,
    )
    .join('')}</table></div>
</main></body></html>`;
}

function payPage(
  linkId: string,
  l: { amountPaise: number; description?: string } | undefined,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay (demo)</title><style>${PAGE_STYLE}</style></head><body><main>
<div class="card" style="max-width:420px;margin:40px auto"><h1>Payment</h1>
<p class="muted">A stand-in for the real payment page (cards, UPI, net banking). No money moves.</p>
${
  l
    ? `<p>${esc(l.description ?? 'RECALL campaign')}</p><p class="big">${rupees(l.amountPaise)}</p>
<form method="post"><button type="submit">Pay ${rupees(l.amountPaise)}</button></form>`
    : '<p>This payment link is not known (the demo was restarted?).</p>'
}
<p class="muted mono" style="font-size:12px">${esc(linkId)}</p></div></main></body></html>`;
}

export function startDesk(port: number, d: DeskInfo): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(html);
    };
    const pay = /^\/pay\/([A-Za-z0-9_-]{1,80})$/.exec(path);
    if (pay?.[1]) {
      const linkId = pay[1];
      if (req.method === 'POST') {
        d.pay(linkId)
          .then((back) => send(303, '', { location: back }))
          .catch((e: unknown) => send(500, `<p>Could not pay: ${esc(String(e))}</p>`));
        return;
      }
      return send(200, payPage(linkId, d.links().get(linkId)));
    }
    if (path === '/' || path === '/index.html') return send(200, deskPage(d, d.clock()));
    send(404, '<p>Not here. <a href="/">The demo desk</a></p>');
  });
  return new Promise((ok) => server.listen(port, '0.0.0.0', ok));
}
