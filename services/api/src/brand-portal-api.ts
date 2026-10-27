// P5.1: the brand portal's sign-in, over HTTP. The portal site passes /api/... here as /portal/...
// (and nothing else), so a portal page can never reach a staff route. The session is a cookie
// scripts cannot read (HttpOnly, SameSite=Strict, its own name), and every change must come from
// the portal's own origins (BRAND_ORIGINS).
//   POST /portal/code       { address, channel: whatsapp|sms|email }  a code is sent
//   POST /portal/sign-in    { address, code }   a session; the accounts it may act for
//   GET  /portal/me         who is signed in and their accounts (none: a new business, P5.2)
//   POST /portal/sign-out   ends this session
import {
  askBrandCode,
  brandSession,
  checkBrandCode,
  endBrandSession,
  portalAccounts,
  Refusal,
  setting,
  type BrandSession,
} from '@recall/db';
import {
  emailAddress,
  indiaMobile,
  showMobile,
  typedCode,
  type BrandCodeChannel,
} from '@recall/domain';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { cookies, HttpError, jsonBody, send, str } from './http.js';
import { callerIp, type StaffApiConfig } from './staff-api.js';

/** The cookie lasts at most this long; the session itself ends sooner when unused (Settings). */
const COOKIE_DAYS = 90;

const cookieName = (cfg: StaffApiConfig) =>
  cfg.secureCookies ? '__Host-recall_brand' : 'recall_brand';

function sessionCookie(cfg: StaffApiConfig, token: string, maxAgeS: number): string {
  return [
    `${cookieName(cfg)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeS}`,
    ...(cfg.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

/** The key sign-in codes are fingerprinted with: its own, made from the API's secret key. */
const codeKey = (cfg: StaffApiConfig) =>
  createHmac('sha256', cfg.secretKey).update('brand-sign-in-codes').digest();

/** A number or email as typed, in the shape it is kept in, or a 400. */
function addressOf(b: Record<string, unknown>): string {
  const typed = str(b, 'address', 254);
  const a = typed.includes('@') ? emailAddress(typed) : indiaMobile(typed);
  if (!a)
    throw new HttpError(400, 'Type your 10-digit mobile number or your email address', {
      code: 'bad-address',
    });
  return a;
}

/** How a number or email is shown back: "+91 98480 12345", or the email. */
const shown = (address: string) => (address.includes('@') ? address : showMobile(address));

/** The signed-in person behind the request's cookie, or 401. */
export async function brandPersonFor(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  now: number,
): Promise<BrandSession> {
  const token = cookies(req).get(cookieName(cfg));
  const s = token
    ? await brandSession(pool, token, now, await setting(pool, 'brandSignIn'))
    : undefined;
  if (!s) throw new HttpError(401, 'Please sign in', { code: 'signed-out' });
  return s;
}

export async function handleBrandPortal(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (!path.startsWith('/portal/')) return false;
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    // Changes only from the portal itself (with SameSite cookies: no cross-site forgery).
    const origin = req.headers.origin;
    if (!origin || !(cfg.brandOrigins ?? []).includes(origin))
      throw new HttpError(403, 'Not from the brand portal');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');
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
  const rules = await setting(pool, 'brandSignIn');
  const ip = () =>
    callerIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, cfg.proxyHops);

  if (path === '/portal/code' && method === 'POST') {
    const messages = cfg.messages;
    if (!messages)
      throw new HttpError(503, 'Sign-in codes are not set up yet', { code: 'not-set-up' });
    const b = await jsonBody(req);
    const address = addressOf(b);
    const channel = str(b, 'channel', 10);
    if (address.includes('@') ? channel !== 'email' : channel !== 'whatsapp' && channel !== 'sms')
      throw new HttpError(
        400,
        address.includes('@') ? 'An email gets its code by email' : 'WhatsApp or SMS?',
      );
    const out = await refused(() =>
      askBrandCode(
        pool,
        messages,
        { address, channel: channel as BrandCodeChannel, ip: ip() },
        codeKey(cfg),
        now,
        rules,
      ),
    );
    send(res, 200, { address, shown: shown(address), expiresAt: out.expiresAt });
    return true;
  }

  if (path === '/portal/sign-in' && method === 'POST') {
    const b = await jsonBody(req);
    const address = addressOf(b);
    const code = typedCode(str(b, 'code', 20));
    if (!code) throw new HttpError(400, 'The code has 6 digits', { code: 'bad-code' });
    const s = await refused(() =>
      checkBrandCode(pool, { address, code, ip: ip() }, codeKey(cfg), now, rules),
    );
    send(
      res,
      200,
      { address, shown: shown(address), accounts: await portalAccounts(pool, address) },
      { 'set-cookie': sessionCookie(cfg, s.token, COOKIE_DAYS * 86_400) },
    );
    return true;
  }

  if (path === '/portal/sign-out' && method === 'POST') {
    const token = cookies(req).get(cookieName(cfg));
    const s = token ? await brandSession(pool, token, now, rules) : undefined;
    if (s) await endBrandSession(pool, s, { by: s.address, why: 'signed out' }, now);
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(cfg, '', 0) });
    return true;
  }

  const me = await brandPersonFor(pool, cfg, req, now);
  if (path === '/portal/me' && method === 'GET') {
    send(res, 200, {
      address: me.address,
      shown: shown(me.address),
      accounts: await portalAccounts(pool, me.address),
    });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
