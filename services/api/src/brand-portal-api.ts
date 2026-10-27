// P5.1: the brand portal's sign-in, over HTTP. The portal site passes /api/... here as /portal/...
// (and nothing else), so a portal page can never reach a staff route. The session is a cookie
// scripts cannot read (HttpOnly, SameSite=Strict, its own name), and every change must come from
// the portal's own origins (BRAND_ORIGINS).
//   POST /portal/code       { address, channel: whatsapp|sms|email }  a code is sent
//   POST /portal/sign-in    { address, code }   a session; the accounts it may act for
//   GET  /portal/me         who is signed in and their accounts (none: a new business, P5.2)
//   POST /portal/sign-out   ends this session
// P5.2, your business:
//   GET  /portal/business-form              the kinds of business and the states, for the form
//   POST /portal/gst        { gstin }       its details from the GST records (or "type them")
//   POST /portal/business   { gstin|null, name, kind, businessType, invoiceEmail, phone,
//                             legalName?, stateCode?, address? }   sets it up; the person owns it
//   GET  /portal/business?brand=<id>        its details and the free week, for its people only
// P5.3:
//   GET  /portal/campaigns?brand=<id>       its campaigns: Scheduled, Running, Done (To pay, Cancelled)
// P5.4:
//   GET  /portal/book-form?brand=<id>[&again=<booking>]  areas, hours, picks, limits (and the plan
//                                           of an earlier booking, for "Book again")
//   POST /portal/quote?brand=<id>    { plan }  the live price and what stops it
//   POST /portal/bookings?brand=<id> { plan }  saves it as the business's booking (to pay next)
import {
  bookForm,
  bookFromPortal,
  planFrom,
  portalQuote,
  portalCampaigns,
  businessPage,
  lookUpGst,
  setUpBusiness,
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
  BUSINESS_TYPES,
  GST_STATES,
  isBusinessType,
  typedGstin,
  emailAddress,
  type PortalPlan,
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

/** People whose booking is being saved now. */
const saving = new Set<string>();

/** Price checks each person made this hour (the live summary asks on every change). */
const quotes = new Map<string, { readonly hour: number; n: number }>();

/** One more for this key this hour, or false when it is out of them. */
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

/** Who did something on the portal, as bookings keep it (the column holds 120 characters). */
const portalBy = (address: string) => `portal:${address}`.slice(0, 120);

/** A booking plan from a request body, checked for shape (the rules check the rest). */
function planOf(b: Record<string, unknown>): PortalPlan {
  const p = b.plan;
  if (typeof p !== 'object' || p === null || Array.isArray(p))
    throw new HttpError(400, 'Send a plan');
  const x = p as Record<string, unknown>;
  const ints = (k: string, max: number) => {
    const v = x[k];
    if (!Array.isArray(v) || v.length > max || !v.every((n) => Number.isInteger(n)))
      throw new HttpError(400, `${k}: a list of whole numbers`);
    return v as number[];
  };
  const ids = x.areaIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    !ids.every((v) => typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v))
  )
    throw new HttpError(400, 'areaIds: area ids');
  const int = (k: string) => {
    const v = x[k];
    if (!Number.isSafeInteger(v)) throw new HttpError(400, `${k}: a whole number`);
    return v as number;
  };
  const startDate = x.startDate;
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    throw new HttpError(400, 'startDate: YYYY-MM-DD');
  return {
    areaIds: ids as string[],
    hours: ints('hours', 30),
    weekdays: ints('weekdays', 7),
    startDate,
    weeks: int('weeks'),
    bikes: int('bikes'),
    repeatMonths: int('repeatMonths'),
  };
}

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
  if (path === '/portal/business-form' && method === 'GET') {
    send(res, 200, {
      types: BUSINESS_TYPES.map(([key, label]) => ({ key, label })),
      states: GST_STATES.map(([code, name]) => ({ code, name })),
    });
    return true;
  }
  if (path === '/portal/gst' && method === 'POST') {
    const b = await jsonBody(req);
    const gstin = typedGstin(str(b, 'gstin', 40));
    send(
      res,
      200,
      await refused(() => lookUpGst(pool, cfg.gst, { gstin, asker: me.address }, now, rules)),
    );
    return true;
  }
  if (path === '/portal/business' && method === 'POST') {
    const b = await jsonBody(req);
    const gstText = b.gstin === null || b.gstin === undefined ? '' : str(b, 'gstin', 40);
    const kind = b.kind;
    if (kind !== 'brand' && kind !== 'agency') throw new HttpError(400, 'A brand or an agency?');
    const businessType = b.businessType;
    if (!isBusinessType(businessType)) throw new HttpError(400, 'Which kind of business?');
    const phone = indiaMobile(str(b, 'phone', 30));
    if (!phone) throw new HttpError(400, 'A 10-digit mobile number for WhatsApp messages');
    const invoiceEmail = emailAddress(str(b, 'invoiceEmail', 254));
    if (!invoiceEmail) throw new HttpError(400, 'An email address for invoices');
    const opt = (k: string, max: number) =>
      b[k] === undefined || b[k] === null ? undefined : str(b, k, max);
    const legalName = opt('legalName', 200);
    const stateCode = opt('stateCode', 2);
    const address = opt('address', 300);
    const brandId = await refused(() =>
      setUpBusiness(
        pool,
        {
          asker: me.address,
          gstin: gstText.trim() === '' ? null : typedGstin(gstText),
          name: str(b, 'name', 120),
          kind,
          businessType,
          invoiceEmail,
          phone,
          ...(legalName !== undefined ? { legalName } : {}),
          ...(stateCode !== undefined ? { stateCode } : {}),
          ...(address !== undefined ? { address } : {}),
        },
        now,
        rules,
      ),
    );
    send(res, 200, { brandId });
    return true;
  }
  /** The account asked for (?brand=), if this person may act for it; otherwise a 404 (not theirs
   * and not there look the same). */
  const account = async () => {
    const brandId = new URL(req.url ?? '/', 'http://x').searchParams.get('brand') ?? '';
    const a = (await portalAccounts(pool, me.address)).find((x) => x.brandId === brandId);
    if (!a) throw new HttpError(404, 'No such business', { code: 'no-business' });
    return a;
  };
  if (path === '/portal/book-form' && method === 'GET') {
    const a = await account();
    const again = new URL(req.url ?? '/', 'http://x').searchParams.get('again');
    const plan = again
      ? await refused(() => planFrom(pool, a.brandId, again, now, rules))
      : undefined;
    const form = await refused(() => bookForm(pool, now, rules));
    send(res, 200, { account: a, form, plan: plan ?? null });
    return true;
  }
  if (path === '/portal/quote' && method === 'POST') {
    await account();
    // A live price on every change: a few hundred an hour each is plenty.
    if (!tryOnce(quotes, me.address, now, 600))
      throw new HttpError(429, 'Too many price checks: wait a minute');
    const plan = planOf(await jsonBody(req));
    send(res, 200, await refused(() => portalQuote(pool, plan, now, rules)));
    return true;
  }
  if (path === '/portal/bookings' && method === 'POST') {
    const a = await account();
    const plan = planOf(await jsonBody(req));
    // One at a time per person, so the day's limit is counted right.
    if (saving.has(me.address))
      throw new HttpError(429, 'Your last booking is still being saved: wait a moment');
    saving.add(me.address);
    let bookingId: string;
    try {
      bookingId = await refused(() =>
        bookFromPortal(pool, { brandId: a.brandId, plan, by: portalBy(me.address) }, now, rules),
      );
    } finally {
      saving.delete(me.address);
    }
    send(res, 200, { bookingId });
    return true;
  }
  if (path === '/portal/campaigns' && method === 'GET') {
    const a = await account();
    send(res, 200, { at: now, account: a, campaigns: await portalCampaigns(pool, a.brandId, now) });
    return true;
  }
  if (path === '/portal/business' && method === 'GET') {
    const a = await account();
    const page = await businessPage(pool, a.brandId, now, me.address);
    if (!page) throw new HttpError(404, 'No such business', { code: 'no-business' });
    send(res, 200, page);
    return true;
  }
  throw new HttpError(404, 'Not found');
}
