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
//   GET  /rider/today             his screen now, moving hours and earnings today and this week
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
  setting,
  type RiderSession,
} from '@recall/db';
import {
  MAX_DOCUMENT_BYTES,
  indiaMobile,
  RIDER_LANGUAGES,
  showMobile,
  typedCode,
  type CodeChannel,
  type RiderLanguage,
} from '@recall/domain';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str, withUpload } from './http.js';
import { callerIp, type StaffApiConfig } from './staff-api.js';

/** Riders with an upload going now: one at a time each (a slow phone never holds two slots). */
const uploadingRiders = new Set<string>();
/** How often each rider asked the providers about his checks this hour (at most 30). */
const asked = new Map<string, { readonly hour: number; n: number }>();

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
      'access-control-allow-headers': 'authorization, content-type',
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
    await open();
    if ((await appUploadsToday(pool, riderId, now)) >= rules.uploadsPerRiderDay)
      throw new HttpError(429, 'Too many pictures today: try again tomorrow', {
        code: 'too-many-uploads',
      });
    if (uploadingRiders.has(riderId))
      throw new HttpError(429, 'One picture at a time', { code: 'one-at-a-time' });
    uploadingRiders.add(riderId);
    try {
      await withUpload(req, 'rider-documents', MAX_DOCUMENT_BYTES, async (data) => {
        // Still open once the picture has arrived (it may have been decided meanwhile).
        await open();
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
        ? { kind: 'upi', vpa: str(b, 'vpa', 256).trim(), name }
        : b.kind === 'bank'
          ? {
              kind: 'bank',
              accountNumber: str(b, 'accountNumber', 30).replace(/[\s-]/g, ''),
              ifsc: str(b, 'ifsc', 20).trim().toUpperCase(),
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
