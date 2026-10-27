// P4.1: the rider app's sign-in, over HTTP. The app keeps its session token itself (on the phone's
// secure store) and sends it as "Authorization: Bearer <token>"; no cookies, so pages elsewhere
// cannot act for the rider. The web build (for tests and screenshots) is let in from its own
// origins only (RIDER_APP_ORIGINS).
//   POST /rider/code        { phone, channel: whatsapp|sms, language: te|hi|en }  a code is sent
//   POST /rider/sign-in     { phone, code }        a session token; riderId null: a new rider
//   GET  /rider/me          who is signed in (phone, rider, name, step)
//   POST /rider/sign-out    ends this phone's session
import {
  askRiderCode,
  checkRiderCode,
  endRiderSession,
  Refusal,
  riderSession,
  type RiderSession,
} from '@recall/db';
import {
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
import { HttpError, jsonBody, send, str } from './http.js';
import { callerIp, type StaffApiConfig } from './staff-api.js';

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
  const s = m?.[1] ? await riderSession(pool, m[1], now) : undefined;
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
        throw new HttpError(e.message.startsWith('Too many') ? 429 : 400, e.message, e.why);
      throw e;
    }
  };
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
      checkRiderCode(pool, { phone, code, ip: ip() }, codeKey(cfg), now),
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

  throw new HttpError(404, 'Not found');
}
