// P4.1: the rider app's sign-in, over HTTP. The app keeps its session token itself (on the phone's
// secure store) and sends it as "Authorization: Bearer <token>"; no cookies, so pages elsewhere
// cannot act for the rider. The web build (for tests and screenshots) is let in from its own
// origins only (RIDER_APP_ORIGINS).
//   POST /rider/code        { phone, channel: whatsapp|sms, language: te|hi|en }  a code is sent
//   POST /rider/sign-in     { phone, code }        a session token; riderId null: a new rider
//   GET  /rider/me          who is signed in (phone, rider, name, step)
//   POST /rider/sign-out    ends this phone's session
// P4.2, joining (his own record only; changes while his application is open):
//   GET  /rider/join        the six steps and where each stands
//   POST /rider/join        { name, rides, apps, bikePlate }  a new number signs up
//   POST /rider/profile     { name, rides, apps, bikePlate }  his details again
//   POST /rider/documents?kind=photo|rc|insurance   the picture as the body (at most 10 MB)
//   POST /rider/identity    start his ID check: a link to open (DigiLocker through the provider)
//   POST /rider/agreement   the agreement to sign: a link to open
//   POST /rider/bank        { kind: bank, accountNumber, ifsc, name } or { kind: upi, vpa, name }
//   POST /rider/checks      ask the providers about his ID and agreement
// P4.3, fitting (once approved):
//   GET  /rider/fitting           his booking, slots he can book, his screen and its latest check
//   POST /rider/fitting/book      { slotId }  book (or move his booking)
//   POST /rider/fitting/cancel    cancel his booking
//   POST /rider/fitting/fit       { code }  the screen's QR (or the id printed under it), at his slot
//   POST /rider/fitting/check     start the fitting check on his screen
//   POST /rider/fitting/panel     { commandId, seen }  every part of the panel lit up, or not
// P4.4:
//   GET  /rider/today             his screen now, screen-on and moving hours and earnings today and
//                                 this week
//   GET  /rider/where[?roads=no]  where he is (his screen's last position, its age), the street, his
//                                 route today, the roads around him (bounded; never anyone else)
// P4.5:
//   GET  /rider/earnings?month=YYYY-MM   days, weeks and the month's parts (this month by default)
//   GET  /rider/earnings/range?from=YYYY-MM-DD&to=YYYY-MM-DD   days he picks (at most 92, none
//                                 after today): screen-on and moving hours, earnings, by day
//   POST /rider/statement         { month }  a link to his statement page (15 minutes)
//   GET  /rider/statement/<token> the statement page itself (printable; no sign-in needed)
// P4.6:
//   GET  /rider/payouts           next Monday's payout, his account (masked), history, TDS by quarter
// P4.7:
//   GET  /rider/loan              his screen loan as the bank reports it, the EMI holiday, the day-90 bonus
// P4.8:
//   GET  /rider/care              his screen problem reports and where each stands
//   POST /rider/problems?kind=    a problem: { note } as JSON, or the photo as the body with the note
//                                 in an X-Note header (URL-encoded)
// P4.9:
//   GET  /rider/help              support's numbers (WhatsApp, call), whether open now, his requests
//   POST /rider/help              { text }  a question to support (a conversation, replies on WhatsApp)
// P4.10:
//   POST /rider/push              { token, language }  this phone's notification token
//   GET  /rider/alerts            his alerts, newest first
// P4.11:
//   GET  /rider/profile           his details, papers, where he is paid (masked), open requests
//   POST /rider/requests          { kind: bank-change | leave | delete }  a request to staff
//   GET  /rider/delete-account    a public page: how to ask for an account to be deleted (Google Play)
// Papers: once approved he may still send a renewed RC or insurance (staff look at it as before).
import type { PayoutDestination } from '@recall/adapters';
import {
  answerPanel,
  appDetails,
  appFittingPage,
  appUploadsToday,
  bookFromApp,
  cancelFromApp,
  fitFromApp,
  startFittingFromApp,
  beforeAppCheck,
  changeOwnDetails,
  checkRiderBank,
  joinAsRider,
  joinPage,
  refreshRiderChecks,
  RIDER_APP,
  sendAgreement,
  startIdentityCheck,
  uploadRiderDocument,
  askRiderCode,
  checkRiderCode,
  endRiderSession,
  Refusal,
  riderSession,
  riderToday,
  riderEarnings,
  riderRange,
  riderWhere,
  riderPayouts,
  riderLoanPage,
  reportScreenProblem,
  riderProblems,
  problemsToday,
  PROBLEMS_PER_DAY,
  riderRequests,
  askSupport,
  registerPush,
  riderProfile,
  riderRequest,
  riderAlerts,
  riderMonths,
  setting,
  type RiderSession,
} from '@recall/db';
import {
  checkDayRange,
  todayOf,
  MAX_DOCUMENT_BYTES,
  accountNumberOf,
  ifscOf,
  indiaMobile,
  upiIdOf,
  RIDER_LANGUAGES,
  showMobile,
  supportOpenAt,
  typedCode,
  type CodeChannel,
  type RiderLanguage,
} from '@recall/domain';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str, withUpload } from './http.js';
import { statementPage, statementToken } from './rider-statement.js';
import { callerIp, type StaffApiConfig } from './staff-api.js';

/** Riders with an upload going now: one at a time each (a slow phone never holds two slots). */
const uploadingRiders = new Set<string>();
/** How often each rider asked the providers about his checks this hour (at most 30). */
const asked = new Map<string, { readonly hour: number; n: number }>();

/** "Where am I" looks each rider made this hour (each may ask the maps provider: at most 240). */
const whereLooks = new Map<string, { readonly hour: number; n: number }>();

/** Screen codes each rider tried this hour (a QR is only an id: at most 20 tries). */
const fitTries = new Map<string, { readonly hour: number; n: number }>();

/** One more try for this rider this hour, or false when he is out of them. */
function tryOnce(
  m: Map<string, { readonly hour: number; n: number }>,
  key: string,
  now: number,
  max: number,
) {
  const hour = Math.floor(now / 3600);
  const mine = m.get(key);
  if (mine?.hour === hour && mine.n >= max) return false;
  if (m.size > 10_000) m.clear();
  m.set(key, mine?.hour === hour ? { hour, n: mine.n + 1 } : { hour, n: 1 });
  return true;
}

/** P4.11: the public page on asking for a rider account to be deleted (English; plain words). */
const DELETE_ACCOUNT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Delete your RECALL rider account</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:640px;line-height:1.5;color:#111}</style></head><body>
<h1>Delete your RECALL rider account</h1>
<p>In the RECALL rider app: open <b>Today</b>, then <b>Profile and settings</b>, then <b>Delete my account</b>. Or message RECALL support on WhatsApp from the number you signed up with.</p>
<p>We first take back the screen and settle your last pay and your screen loan with the bank. Then your name, phone number, photos, vehicle papers and bank details are erased. We keep only what the law requires (pay and tax records), for as long as it requires.</p>
</body></html>`;

/** P4.5: why a pick of days is refused, in plain words (the app words it by the code). */
const RANGE_REFUSED = {
  'bad-date': 'Pick real dates',
  backwards: 'The first day must come before the last',
  future: 'Pick days up to today',
  'too-long': 'Pick at most 92 days',
  'too-old': 'Pick days in the last year',
} as const;

/** The key sign-in codes are fingerprinted with: its own, made from the API's secret key. */
const codeKey = (cfg: StaffApiConfig) =>
  createHmac('sha256', cfg.secretKey).update('rider-sign-in-codes').digest();

/** The signed-in rider behind the request's bearer token, or 401. */
export async function riderFor(
  pool: Pool,
  req: IncomingMessage,
  now: number,
): Promise<RiderSession> {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? ''));
  const s = m?.[1]
    ? await riderSession(pool, m[1], now, await setting(pool, 'riderSignIn'))
    : undefined;
  if (!s) throw new HttpError(401, 'Please sign in again', { code: 'signed-out' });
  return s;
}

export async function handleRiderApp(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!path.startsWith('/rider/')) return false;
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';
  // The web build only, from its own origins; the phone app sends no Origin.
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!(cfg.riderOrigins ?? []).includes(origin)) throw new HttpError(403, 'Not allowed here');
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'authorization, content-type, x-note',
      'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  const refused = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof Refusal)
        throw new HttpError(
          /^(Too many|Sign-in is busy)/.test(e.message) ? 429 : 400,
          e.message,
          e.why,
        );
      throw e;
    }
  };
  // P4.11: how to ask for an account to be deleted, for anyone (a store listing links here).
  if (path === '/rider/delete-account' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(DELETE_ACCOUNT_PAGE);
    return true;
  }
  // P4.5: the statement page, opened in the phone's browser from a signed link (no token header).
  const st = /^\/rider\/statement\/([A-Za-z0-9_.-]{20,300})$/.exec(path);
  if (st && method === 'GET') {
    const html = await statementPage(pool, cfg.secretKey, st[1] ?? '', now);
    if (!html)
      throw new HttpError(404, 'This link has run out: open the statement again in the app');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      // No scripts at all: the page is words and a table.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(html);
    return true;
  }
  // The limits in force (a super admin's setting; P4.1).
  const rules = await setting(pool, 'riderSignIn');
  const ip = () =>
    callerIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, cfg.proxyHops);

  if (path === '/rider/code') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const messages = cfg.messages;
    if (!messages)
      throw new HttpError(503, 'Sign-in codes are not set up yet', { code: 'not-set-up' });
    const b = await jsonBody(req);
    const phone = indiaMobile(str(b, 'phone', 30));
    if (!phone) throw new HttpError(400, 'Type your 10-digit mobile number', { code: 'bad-phone' });
    const channel = str(b, 'channel', 10);
    if (channel !== 'whatsapp' && channel !== 'sms') throw new HttpError(400, 'WhatsApp or SMS?');
    const language = (RIDER_LANGUAGES as readonly string[]).includes(String(b.language))
      ? (b.language as RiderLanguage)
      : 'en';
    const out = await refused(() =>
      askRiderCode(
        pool,
        messages,
        { phone, channel: channel as CodeChannel, ip: ip(), language },
        codeKey(cfg),
        now,
        rules,
      ),
    );
    send(res, 200, { phone, shown: showMobile(phone), expiresAt: out.expiresAt });
    return true;
  }

  if (path === '/rider/sign-in') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const b = await jsonBody(req);
    const phone = indiaMobile(str(b, 'phone', 30));
    if (!phone) throw new HttpError(400, 'Type your 10-digit mobile number', { code: 'bad-phone' });
    const code = typedCode(str(b, 'code', 20));
    if (!code) throw new HttpError(400, 'The code has 6 digits', { code: 'bad-code' });
    const s = await refused(() =>
      checkRiderCode(pool, { phone, code, ip: ip() }, codeKey(cfg), now, rules),
    );
    send(res, 200, { token: s.token, riderId: s.riderId });
    return true;
  }

  if (path === '/rider/me') {
    if (method !== 'GET') throw new HttpError(405, 'Not allowed');
    const s = await riderFor(pool, req, now);
    const r = s.riderId
      ? (
          await pool.query<{ name: string; status: string }>(
            `SELECT (SELECT name FROM rider_versions WHERE rider_id = $1 ORDER BY version DESC LIMIT 1) AS name,
                    (SELECT status FROM rider_steps WHERE rider_id = $1 ORDER BY seq DESC LIMIT 1) AS status`,
            [s.riderId],
          )
        ).rows[0]
      : undefined;
    send(res, 200, {
      phone: s.phone,
      shown: showMobile(s.phone),
      riderId: s.riderId,
      name: r?.name ?? null,
      status: r?.status ?? null,
    });
    return true;
  }

  if (path === '/rider/sign-out') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const s = await riderFor(pool, req, now);
    await endRiderSession(
      pool,
      s.tokenHash,
      { by: s.riderId ?? 'new rider', why: 'signed out on the app', riderId: s.riderId },
      now,
    );
    send(res, 200, { ok: true });
    return true;
  }

  // P4.2: joining. Every route below is his own record, from his signed-in session.
  const s = await riderFor(pool, req, now);
  if (path === '/rider/join' && method === 'POST') {
    const d = appDetails(await jsonBody(req), s.phone);
    if (!d) throw new HttpError(400, 'Fill in your name, where you ride and your apps');
    const riderId = await refused(() => joinAsRider(pool, s, d, now));
    send(res, 200, { riderId });
    return true;
  }
  const riderId = s.riderId;
  if (!riderId) throw new HttpError(404, 'Sign up first', { code: 'not-joined' });
  if (path === '/rider/join') {
    if (method !== 'GET') throw new HttpError(405, 'Not allowed');
    const page = await refused(() => joinPage(pool, riderId, now));
    send(res, 200, { ...page, loanBank: (await setting(pool, 'loanBank')).name });
    return true;
  }
  if (path === '/rider/today' && method === 'GET') {
    send(res, 200, await riderToday(pool, riderId, now));
    return true;
  }
  if (path === '/rider/where' && method === 'GET') {
    // Each look may ask the maps provider (paid, in production): a few a minute at most.
    if (!tryOnce(whereLooks, riderId, now, 240))
      throw new HttpError(429, 'Too many looks: wait a while', { code: 'too-many-tries' });
    const roads = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('roads') !== 'no';
    send(res, 200, await riderWhere(pool, cfg.maps ?? cfg.reports?.maps, riderId, now, { roads }));
    return true;
  }
  if (path === '/rider/earnings/range' && method === 'GET') {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const ok = checkDayRange(from, to, todayOf(now));
    if (!ok.ok) throw new HttpError(400, RANGE_REFUSED[ok.why], { code: `range-${ok.why}` });
    send(res, 200, await riderRange(pool, riderId, from, to, now));
    return true;
  }
  if (path === '/rider/earnings' && method === 'GET') {
    const asked = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('month');
    const months = await riderMonths(pool, riderId, now);
    const month = asked ?? months[0] ?? '';
    if (!months.includes(month))
      throw new HttpError(400, 'Pick one of your months', { code: 'bad-month' });
    send(res, 200, await riderEarnings(pool, riderId, month, now, months));
    return true;
  }
  if (path === '/rider/profile' && method === 'GET') {
    send(res, 200, await refused(() => riderProfile(pool, riderId, now)));
    return true;
  }
  if (path === '/rider/requests' && method === 'POST') {
    const kind = str(await jsonBody(req), 'kind', 20);
    send(res, 200, await refused(() => riderRequest(pool, { riderId, phone: s.phone, kind }, now)));
    return true;
  }
  if (path === '/rider/alerts' && method === 'GET') {
    send(res, 200, { alerts: await riderAlerts(pool, riderId) });
    return true;
  }
  if (path === '/rider/push' && method === 'POST') {
    const b = await jsonBody(req);
    await refused(() =>
      registerPush(pool, s.tokenHash, str(b, 'token', 300), str(b, 'language', 5), now),
    );
    send(res, 200, { ok: true });
    return true;
  }
  if (path === '/rider/help' && method === 'GET') {
    const support = await setting(pool, 'support');
    // The riders' line(s) when labelled so; otherwise every number.
    const riders = support.phones.filter((p) => /rider/i.test(p.label));
    send(res, 200, {
      phones: (riders.length ? riders : support.phones).map((p) => ({
        label: p.label,
        phone: p.phone,
        whatsapp: p.whatsapp,
      })),
      open: supportOpenAt(support, now),
      days: support.days,
      opens: support.opens,
      closes: support.closes,
      requests: await riderRequests(pool, riderId),
    });
    return true;
  }
  if (path === '/rider/help' && method === 'POST') {
    const text = str(await jsonBody(req), 'text', 4000);
    send(res, 200, await refused(() => askSupport(pool, { riderId, phone: s.phone, text }, now)));
    return true;
  }
  if (path === '/rider/care' && method === 'GET') {
    send(res, 200, { problems: await riderProblems(pool, riderId) });
    return true;
  }
  if (path === '/rider/problems' && method === 'POST') {
    const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const report = (note: string, photo: Uint8Array | null) =>
      refused(() =>
        reportScreenProblem(
          pool,
          cfg.files,
          { riderId, phone: s.phone, kind: q.get('kind') ?? '', note, photo },
          now,
        ),
      );
    if (String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) {
      // Refused before a photo is read: storage not set up, or his reports for today used up.
      if (!cfg.files) throw new HttpError(503, 'Photos are not set up yet', { code: 'not-set-up' });
      if ((await problemsToday(pool, riderId, now)) >= PROBLEMS_PER_DAY)
        throw new HttpError(429, 'Too many reports today: call support', {
          code: 'too-many-reports',
        });
      let note = '';
      try {
        note = decodeURIComponent(String(req.headers['x-note'] ?? '')).slice(0, 2000);
      } catch {
        throw new HttpError(400, 'The note could not be read');
      }
      if (uploadingRiders.has(riderId))
        throw new HttpError(429, 'One picture at a time', { code: 'one-at-a-time' });
      uploadingRiders.add(riderId);
      try {
        await withUpload(req, 'rider-problems', MAX_DOCUMENT_BYTES, async (data) => {
          send(res, 200, await report(note, data));
        });
      } finally {
        uploadingRiders.delete(riderId);
      }
    } else {
      const b = await jsonBody(req);
      send(res, 200, await report(typeof b.note === 'string' ? b.note.slice(0, 2000) : '', null));
    }
    return true;
  }
  if (path === '/rider/loan' && method === 'GET') {
    const bank = (await setting(pool, 'loanBank')).name;
    send(res, 200, await riderLoanPage(pool, riderId, now, bank));
    return true;
  }
  if (path === '/rider/payouts' && method === 'GET') {
    send(res, 200, await riderPayouts(pool, riderId, now));
    return true;
  }
  if (path === '/rider/statement' && method === 'POST') {
    const month = str(await jsonBody(req), 'month', 7);
    if (!(await riderMonths(pool, riderId, now)).includes(month))
      throw new HttpError(400, 'Pick one of your months', { code: 'bad-month' });
    send(res, 200, {
      path: `/rider/statement/${statementToken(cfg.secretKey, riderId, month, now)}`,
    });
    return true;
  }
  if (path === '/rider/fitting' && method === 'GET') {
    send(res, 200, await refused(() => appFittingPage(pool, riderId, now, rules)));
    return true;
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  if (path.startsWith('/rider/fitting/')) {
    const what = path.slice('/rider/fitting/'.length);
    const b = await jsonBody(req);
    if (what === 'book') await refused(() => bookFromApp(pool, riderId, str(b, 'slotId', 20), now));
    else if (what === 'cancel') await refused(() => cancelFromApp(pool, riderId, now));
    else if (what === 'fit') {
      if (!tryOnce(fitTries, riderId, now, 20))
        throw new HttpError(429, 'Too many tries: wait a while', { code: 'too-many-tries' });
      const screenId = await refused(() =>
        fitFromApp(pool, riderId, str(b, 'code', 100), now, rules),
      );
      send(res, 200, { screenId });
      return true;
    } else if (what === 'check') {
      send(res, 200, await refused(() => startFittingFromApp(pool, riderId, now, rules)));
      return true;
    } else if (what === 'panel') {
      if (typeof b.seen !== 'boolean') throw new HttpError(400, 'seen must be true or false');
      const seen = b.seen;
      await refused(() => answerPanel(pool, riderId, str(b, 'commandId', 64), seen, now));
    } else throw new HttpError(404, 'Not found');
    send(res, 200, { ok: true });
    return true;
  }
  // Changes only while his application is open (after that, staff help on a call).
  const open = async () => {
    const page = await refused(() => joinPage(pool, riderId, now));
    if (!page.canChange)
      throw new HttpError(409, 'Your application is decided: call support', { code: 'decided' });
  };
  if (path === '/rider/profile') {
    const d = appDetails(await jsonBody(req), s.phone);
    if (!d) throw new HttpError(400, 'Fill in your name, where you ride and your apps');
    await refused(() => changeOwnDetails(pool, riderId, d, now));
    send(res, 200, { ok: true });
    return true;
  }
  if (path === '/rider/documents') {
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'Uploads are not set up yet', { code: 'not-set-up' });
    const kind = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('kind') ?? '';
    // While his application is open, any of his papers; after approval, a renewed RC or insurance.
    const renewal = async () => {
      const page = await refused(() => joinPage(pool, riderId, now));
      if (page.canChange) return;
      if (
        !['approved', 'active', 'paused'].includes(page.status) ||
        !['rc', 'insurance'].includes(kind)
      )
        throw new HttpError(409, 'Your application is decided: call support', { code: 'decided' });
    };
    await renewal();
    if ((await appUploadsToday(pool, riderId, now)) >= rules.uploadsPerRiderDay)
      throw new HttpError(429, 'Too many pictures today: try again tomorrow', {
        code: 'too-many-uploads',
      });
    if (uploadingRiders.has(riderId))
      throw new HttpError(429, 'One picture at a time', { code: 'one-at-a-time' });
    uploadingRiders.add(riderId);
    try {
      await withUpload(req, 'rider-documents', MAX_DOCUMENT_BYTES, async (data) => {
        // Still allowed once the picture has arrived (it may have been decided meanwhile).
        await renewal();
        const doc = await refused(() =>
          uploadRiderDocument(pool, store, { riderId, kind, data, by: RIDER_APP }, now),
        );
        send(res, 200, { docId: doc.docId, kind: doc.kind });
      });
    } finally {
      uploadingRiders.delete(riderId);
    }
    return true;
  }
  const checks = cfg.riderChecks;
  if (!checks) throw new HttpError(503, 'Checks are not set up yet', { code: 'not-set-up' });
  if (path === '/rider/identity') {
    await open();
    // A check still waiting is opened again (never paid for twice); a few a day.
    const waiting = await refused(() => beforeAppCheck(pool, riderId, 'identity', now, rules));
    send(
      res,
      200,
      waiting
        ? { link: waiting }
        : await refused(() => startIdentityCheck(pool, checks.kyc, riderId, RIDER_APP, now)),
    );
    return true;
  }
  if (path === '/rider/agreement') {
    await open();
    const waiting = await refused(() => beforeAppCheck(pool, riderId, 'agreement', now, rules));
    send(
      res,
      200,
      waiting
        ? { link: waiting }
        : await refused(() => sendAgreement(pool, checks.esign, riderId, RIDER_APP, now)),
    );
    return true;
  }
  if (path === '/rider/checks') {
    // The providers are asked at most 30 times an hour for one rider.
    if (!tryOnce(asked, riderId, now, 30))
      throw new HttpError(429, 'Too many tries: wait a while', { code: 'too-many-checks' });
    send(res, 200, { answered: await refreshRiderChecks(pool, checks, riderId, now) });
    return true;
  }
  if (path === '/rider/bank') {
    await open();
    const b = await jsonBody(req);
    const name = str(b, 'name', 120).trim();
    const to: PayoutDestination =
      b.kind === 'upi'
        ? { kind: 'upi', vpa: upiIdOf(str(b, 'vpa', 256)), name }
        : b.kind === 'bank'
          ? {
              kind: 'bank',
              accountNumber: accountNumberOf(str(b, 'accountNumber', 30)),
              ifsc: ifscOf(str(b, 'ifsc', 20)),
              name,
            }
          : (() => {
              throw new HttpError(400, 'Bank account or UPI?');
            })();
    await refused(() => beforeAppCheck(pool, riderId, 'bank', now, rules));
    const out = await refused(() =>
      checkRiderBank(pool, checks.bank, riderId, to, { who: RIDER_APP, superAdmin: false }, now),
    );
    // Never the name the bank holds (anyone could look up whose an account is): staff see it.
    send(res, 200, {
      outcome: out.outcome,
      reason:
        out.outcome === 'failed' && /^the bank holds it as/.test(out.reason ?? '')
          ? 'the name on the account is not yours'
          : out.reason,
    });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
