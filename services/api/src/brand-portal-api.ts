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
// P5.5, your ads (a brand's own; an agency adds them on each of its brands' accounts, P5.10):
//   GET  /portal/ads?brand=<id>                     its ads with their automatic checks and review
//   POST /portal/ads/upload?brand=<id>&name=<name>  the file as the body (checked as staff uploads are)
//   GET  /portal/ads/file?brand=<id>&ad=<id>        the file itself, to see it
//   GET  /portal/booking-ads?brand=<id>&booking=<id>          the ads a booking runs, its deadline
//   POST /portal/booking-ads?brand=<id>&booking=<id> { adIds } choose 2 to 5 of them
//   POST /portal/logo?brand=<id>                    its logo as the body (a picture, up to 2 MB)
//   GET  /portal/logo?brand=<id>                    its logo
//   POST /portal/ads/template-preview?brand=<id> { template }        the ready-made ad, as a PNG
//   POST /portal/ads/template?brand=<id>         { template, name }  kept as one of its ads
// P5.6, review and pay:
//   GET  /portal/review?brand=<id>&booking=<id>   the booking line by line, GST, total, the rules
//   POST /portal/pay?brand=<id>&booking=<id> { agree: true, termsVersion }  the payment link
//   POST /portal/deal?brand=<id>&booking=<id>   a 6- or 12-month deal: the sales team calls
// P5.7, the final report (the link in the "Done" message has no brand: the report says whose it is):
//   GET  /portal/report?booking=<id>        the report as a page, its summary, the business
//   GET  /portal/report/pdf?booking=<id>    its PDF, to keep or share
// P5.9, help and team:
//   GET  /portal/help?brand=<id>    answers, our numbers and hours, the ad rules, its questions
//   POST /portal/help?brand=<id>    { subject, text }  a question to our support desk
//   GET  /portal/team?brand=<id>    who has access
//   POST /portal/team?brand=<id>    { address, role: owner|booker, active }  its owner only
// P5.10, agencies (an agency's people also see the brands our team linked to it, and book for them):
//   GET  /portal/statement?brand=<agency>&month=YYYY-MM   its monthly statement: cuts by booking,
//                                           GST, TDS, payments, invoices (never on a brand's invoice)
// P5.8, invoices and credit notes:
//   GET  /portal/invoices?brand=<id>[&fy=2027-28]      a year's documents, the years there are
//   GET  /portal/invoices/pdf?brand=<id>&doc=RC-27-28-000123  one as a PDF (its number, - for /)
//   GET  /portal/invoices/year-pdf?brand=<id>&fy=<fy>  all of a year's in one PDF
import {
  partnerStatement,
  askFromPortal,
  brandQuestions,
  brandTeam,
  setTeamMember,
  brandDocument,
  brandDocuments,
  priceBooks,
  campaignReportFor,
  askSalesForDeal,
  payFromPortal,
  NOT_STAFF_DRAFT,
  reviewPage,
  brandLogo,
  setBrandLogo,
  MAX_LOGO_BYTES,
  adById,
  bookingAds,
  brandAds,
  setBookingAds,
  uploadAd,
  type Ad,
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
  MAX_AD_UPLOAD_BYTES,
  templateProblems,
  type AdTemplate,
  type PortalPlan,
  indiaMobile,
  showMobile,
  typedCode,
  type BrandCodeChannel,
  reportPeriod,
  reportSummary,
  type TaxDocument,
  adRulesText,
  brandHelp,
  PRICE_BOOK_V1,
  BRAND_MEMBER_ROLES,
  DEFAULT_AD_RULES,
  priceBookAt,
  isoAt,
  supportOpenAt,
  type BrandMemberRole,
} from '@recall/domain';
import { renderReportHtml, renderReportPdf, renderTaxDocumentsPdf } from '@recall/workers';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { cookies, HttpError, jsonBody, send, str, withUpload } from './http.js';
import { renderAd } from './ad-render.js';
import { callerIp, type StaffApiConfig } from './staff-api.js';

/** Template previews each person drew this hour (each takes the server a moment). */
const previews = new Map<string, { readonly hour: number; n: number }>();

/** A ready-made ad from a request body, checked for shape (templateProblems checks the rest). */
function templateOf(b: Record<string, unknown>): AdTemplate {
  const t = b.template;
  if (typeof t !== 'object' || t === null || Array.isArray(t))
    throw new HttpError(400, 'Send a template');
  const x = t as Record<string, unknown>;
  const text = (k: string, max: number) => {
    const v = x[k] ?? '';
    if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${k}: text`);
    return v;
  };
  const out = {
    headline: text('headline', 60),
    offer: text('offer', 80),
    // A promo code never has a space ("chai 30" → "CHAI30").
    code: text('code', 32).replace(/\s/g, '').toUpperCase(),
    qr: text('qr', 300).trim(),
    colour: text('colour', 7),
    theme: text('theme', 10) as AdTemplate['theme'],
    layout: Number(x.layout ?? 0),
  };
  const problems = templateProblems(out);
  if (problems.length > 0) throw new HttpError(400, problems.join('. '), { code: 'bad-template' });
  return out;
}

/** Uploads each person tried this hour (refused ones too: a refused file still costs to send). */
const uploadsTried = new Map<string, { readonly hour: number; n: number }>();
/** People with an upload going now: one at a time each, so nobody holds every slot. */
const uploadingNow = new Set<string>();

/** One upload for this person: counted, one at a time; `use` gets the slot. */
async function oneUpload(address: string, now: number, use: () => Promise<void>) {
  if (!tryOnce(uploadsTried, address, now, 60))
    throw new HttpError(429, 'Too many uploads this hour: try again later');
  if (uploadingNow.has(address))
    throw new HttpError(429, 'Your last upload is still going: wait for it to finish');
  uploadingNow.add(address);
  try {
    await use();
  } finally {
    uploadingNow.delete(address);
  }
}

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
    const stateCode = opt('stateCode', 8)?.replace(/\s/g, '');
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
  // P5.5: ads. What a brand sees of an ad: never staff's names or notes.
  const adShown = (x: Ad) => ({
    adId: x.adId,
    name: x.name,
    kind: x.kind,
    width: x.width,
    height: x.height,
    durationMs: x.durationMs,
    checks: x.checks,
    outcome: x.outcome,
    review: x.review ? { decision: x.review.decision, reason: x.review.reason } : null,
    uploadedAt: x.uploadedAt,
  });
  const brandOnly = async () => {
    const a = await account();
    if (a.kind !== 'brand')
      throw new HttpError(400, 'Ads belong to a brand: open the brand you book for', {
        code: 'not-a-brand',
      });
    return a;
  };
  /** The booking asked for (?booking=), if it is this business's; otherwise a 404. */
  const ownBooking = async (brandId: string) => {
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('booking') ?? '';
    const r = await pool.query<{ ads_due_at: Date; first_hour_at: Date }>(
      `SELECT ads_due_at, first_hour_at FROM bookings b
        WHERE booking_id = $1 AND brand_id = $2 AND ${NOT_STAFF_DRAFT}`,
      [id, brandId],
    );
    const b = r.rows[0];
    if (!b) throw new HttpError(404, 'No such campaign', { code: 'no-booking' });
    return {
      bookingId: id,
      adsDueAt: Math.floor(b.ads_due_at.getTime() / 1000),
      firstHourAt: Math.floor(b.first_hour_at.getTime() / 1000),
    };
  };
  if (path === '/portal/ads' && method === 'GET') {
    const a = await brandOnly();
    send(res, 200, { ads: (await brandAds(pool, a.brandId)).map(adShown) });
    return true;
  }
  if (path === '/portal/ads/upload' && method === 'POST') {
    const a = await brandOnly();
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'Uploads are not set up yet: send your ads to us');
    const by = portalBy(me.address);
    const today = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ads WHERE uploaded_by = $1
         AND uploaded_at > to_timestamp($2) - interval '1 day'`,
      [by, now],
    );
    if (Number(today.rows[0]?.n ?? 0) >= rules.adUploadsPerDay)
      throw new HttpError(429, 'Too many ads uploaded today: try again tomorrow, or call us');
    const name = new URL(req.url ?? '/', 'http://x').searchParams.get('name') ?? '';
    await oneUpload(me.address, now, () =>
      withUpload(
        req,
        'brand-ads',
        MAX_AD_UPLOAD_BYTES,
        async (data) => {
          const ad = await refused(() =>
            uploadAd(pool, store, { brandId: a.brandId, name, data, by }, now),
          );
          send(res, 200, { ad: adShown(ad) });
        },
        a.brandId,
      ),
    );
    return true;
  }
  if (path === '/portal/ads/file' && method === 'GET') {
    const a = await brandOnly();
    const store = cfg.files;
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('ad') ?? '';
    const ad = /^AD-[0-9A-F]{10}$/.test(id) ? await adById(pool, id) : undefined;
    // Not theirs and not there look the same.
    const f = ad && ad.brandId === a.brandId && store ? await store.get(ad.fileKey) : null;
    if (!f) throw new HttpError(404, 'No such ad');
    res.writeHead(200, {
      'content-type': f.contentType,
      'content-length': f.data.length,
      'cache-control': 'private, max-age=600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    res.end(Buffer.from(f.data));
    return true;
  }
  if (path === '/portal/logo' && method === 'POST') {
    const a = await brandOnly();
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'Uploads are not set up yet: send your logo to us');
    if (!tryOnce(previews, `logo:${me.address}`, now, 30))
      throw new HttpError(429, 'Too many logos this hour: try again later');
    await oneUpload(me.address, now, () =>
      withUpload(
        req,
        'brand-logos',
        MAX_LOGO_BYTES,
        async (data) => {
          const l = await refused(() =>
            setBrandLogo(pool, store, { brandId: a.brandId, data, by: portalBy(me.address) }, now),
          );
          send(res, 200, { logo: { width: l.width, height: l.height } });
        },
        a.brandId,
      ),
    );
    return true;
  }
  /** The brand's logo with its bytes, or null. */
  const logoOf = async (brandId: string) => {
    const l = await brandLogo(pool, brandId);
    const f = l && cfg.files ? await cfg.files.get(l.fileKey) : null;
    return l && f ? { ...l, data: f.data } : null;
  };
  if (path === '/portal/logo' && method === 'GET') {
    const a = await brandOnly();
    const l = await logoOf(a.brandId);
    if (!l) throw new HttpError(404, 'No logo yet', { code: 'no-logo' });
    res.writeHead(200, {
      'content-type': l.contentType,
      'content-length': l.data.length,
      'cache-control': 'private, no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    res.end(Buffer.from(l.data));
    return true;
  }
  if (path === '/portal/ads/template-preview' && method === 'POST') {
    const a = await brandOnly();
    const t = templateOf(await jsonBody(req));
    if (!tryOnce(previews, me.address, now, 300))
      throw new HttpError(429, 'Too many previews this hour: wait a little');
    const png = renderAd(t, await logoOf(a.brandId));
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(Buffer.from(png));
    return true;
  }
  if (path === '/portal/ads/template' && method === 'POST') {
    const a = await brandOnly();
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'Uploads are not set up yet: ask us on Help');
    const body = await jsonBody(req);
    const t = templateOf(body);
    if (!tryOnce(previews, me.address, now, 300))
      throw new HttpError(429, 'Too many ads drawn this hour: wait a little');
    const by = portalBy(me.address);
    const today = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ads WHERE uploaded_by = $1
         AND uploaded_at > to_timestamp($2) - interval '1 day'`,
      [by, now],
    );
    if (Number(today.rows[0]?.n ?? 0) >= rules.adUploadsPerDay)
      throw new HttpError(429, 'Too many ads made today: try again tomorrow, or call us');
    const name =
      typeof body.name === 'string' && body.name.trim() !== ''
        ? body.name.trim().slice(0, 80)
        : t.headline.trim();
    const png = renderAd(t, await logoOf(a.brandId));
    const ad = await refused(() =>
      uploadAd(pool, store, { brandId: a.brandId, name, data: png, by }, now),
    );
    send(res, 200, { ad: adShown(ad) });
    return true;
  }
  if (path === '/portal/review' && method === 'GET') {
    const a = await account();
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('booking') ?? '';
    const page = await refused(() => reviewPage(pool, a.brandId, id, now));
    if (!page) throw new HttpError(404, 'No such campaign', { code: 'no-booking' });
    send(res, 200, page);
    return true;
  }
  if (path === '/portal/pay' && method === 'POST') {
    const a = await account();
    const payments = cfg.payments;
    if (!payments)
      throw new HttpError(503, 'Payments are not set up yet: ask us on Help', {
        code: 'not-set-up',
      });
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('booking') ?? '';
    const b = await jsonBody(req);
    if (b.agree !== true)
      throw new HttpError(400, 'Tick the box to agree to the rules', { code: 'not-agreed' });
    if (!Number.isSafeInteger(b.termsVersion))
      throw new HttpError(400, 'termsVersion: a whole number');
    const link = await refused(async () => {
      try {
        return await payFromPortal(
          pool,
          payments,
          {
            brandId: a.brandId,
            bookingId: id,
            by: portalBy(me.address),
            ip: ip(),
            termsVersion: b.termsVersion as number,
          },
          now,
        );
      } catch (e) {
        // Not theirs or not there: a 404 as everywhere; already paid or changed: a conflict.
        if (e instanceof Refusal && e.why?.code === 'no-booking')
          throw new HttpError(404, e.message, e.why);
        if (e instanceof Refusal && (e.why?.code === 'paid' || e.why?.code === 'changed'))
          throw new HttpError(409, e.message, e.why);
        throw e;
      }
    });
    send(res, 200, link);
    return true;
  }
  if (path === '/portal/deal' && method === 'POST') {
    const a = await account();
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('booking') ?? '';
    const threadId = await refused(() =>
      askSalesForDeal(pool, { brandId: a.brandId, bookingId: id, contact: me.address }, now),
    );
    send(res, 200, { threadId });
    return true;
  }
  if (path === '/portal/booking-ads' && method === 'GET') {
    const a = await brandOnly();
    const b = await ownBooking(a.brandId);
    send(res, 200, { ...b, ads: (await bookingAds(pool, b.bookingId)).map(adShown) });
    return true;
  }
  if (path === '/portal/booking-ads' && method === 'POST') {
    const a = await brandOnly();
    const b = await ownBooking(a.brandId);
    const body = await jsonBody(req);
    const ids = body.adIds;
    if (!Array.isArray(ids) || ids.length > 20 || !ids.every((x) => typeof x === 'string'))
      throw new HttpError(400, 'adIds: a list of ad ids');
    const version = await refused(() =>
      setBookingAds(pool, b.bookingId, ids as string[], portalBy(me.address), now),
    );
    send(res, 200, { version });
    return true;
  }
  /** The final report asked for (?booking=), if one of this person's businesses owns it; else 404
   * (not theirs and not there look the same). */
  const ownReport = async () => {
    const id = new URL(req.url ?? '/', 'http://x').searchParams.get('booking') ?? '';
    const report = /^BK-[A-Za-z0-9-]{1,36}$/.test(id)
      ? await campaignReportFor(pool, id)
      : undefined;
    const a = report
      ? (await portalAccounts(pool, me.address)).find((x) => x.brandId === report.brandId)
      : undefined;
    if (!report || !a)
      throw new HttpError(404, 'No report for this campaign yet', { code: 'no-report' });
    return { report, account: a };
  };
  if (path === '/portal/report' && method === 'GET') {
    const { report, account: a } = await ownReport();
    send(res, 200, {
      account: a,
      bookingId: report.bookingId,
      period: reportPeriod(report),
      summary: reportSummary(report),
      html: renderReportHtml(report),
    });
    return true;
  }
  if (path === '/portal/report/pdf' && method === 'GET') {
    const { report } = await ownReport();
    if (!tryOnce(previews, `pdf:${me.address}`, now, 30))
      throw new HttpError(429, 'Too many downloads this hour: try again later');
    const pdf = Buffer.from(await renderReportPdf(report));
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': pdf.length,
      'content-disposition': `attachment; filename="RECALL-report-${report.bookingId}.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(pdf);
    return true;
  }
  /** Documents as a PDF download (each prints what was kept with it when issued). */
  const sendDocuments = async (docs: readonly TaxDocument[], name: string) => {
    if (!tryOnce(previews, `pdf:${me.address}`, now, 30))
      throw new HttpError(429, 'Too many downloads this hour: try again later');
    const pdf = Buffer.from(await renderTaxDocumentsPdf(docs));
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': pdf.length,
      'content-disposition': `attachment; filename="${name}.pdf"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(pdf);
  };
  if (path === '/portal/invoices' && method === 'GET') {
    const a = await account();
    const fy = new URL(req.url ?? '/', 'http://x').searchParams.get('fy');
    send(res, 200, { account: a, ...(await brandDocuments(pool, a.brandId, fy, now)) });
    return true;
  }
  if (path === '/portal/invoices/pdf' && method === 'GET') {
    const a = await account();
    // The number with dashes for slashes ("RC-27-28-000123"): plain in an address.
    const m = /^(RC|CN)-(\d{2}-\d{2})-(\d{6})$/.exec(
      new URL(req.url ?? '/', 'http://x').searchParams.get('doc') ?? '',
    );
    const d = m ? await brandDocument(pool, a.brandId, `${m[1]}/${m[2]}/${m[3]}`) : undefined;
    if (!d) throw new HttpError(404, 'No such invoice', { code: 'no-document' });
    await sendDocuments([d], `RECALL-${d.docNo.replaceAll('/', '-')}`);
    return true;
  }
  if (path === '/portal/invoices/year-pdf' && method === 'GET') {
    const a = await account();
    const fy = new URL(req.url ?? '/', 'http://x').searchParams.get('fy') ?? '';
    if (!/^\d{4}-\d{2}$/.test(fy)) throw new HttpError(400, 'fy: like 2027-28');
    const y = await brandDocuments(pool, a.brandId, fy, now);
    if (y.documents.length === 0)
      throw new HttpError(404, 'No invoices that year', { code: 'no-document' });
    if (y.truncated)
      throw new HttpError(
        413,
        'More than 500 that year: download them one by one, or ask us on Help',
        { code: 'too-many' },
      );
    // Oldest first, as an accountant files them.
    await sendDocuments([...y.documents].reverse(), `RECALL-invoices-${fy}`);
    return true;
  }
  if (path === '/portal/help' && method === 'GET') {
    const a = await account();
    const support = await setting(pool, 'support');
    // The brands' line(s) when labelled so; otherwise every number.
    const brands = support.phones.filter((p) => /brand|sales/i.test(p.label));
    const book = priceBookAt(await priceBooks(pool), isoAt(now));
    send(res, 200, {
      account: a,
      phones: (brands.length ? brands : support.phones).map((p) => ({
        label: p.label,
        phone: p.phone,
        whatsapp: p.whatsapp,
      })),
      open: supportOpenAt(support, now),
      days: support.days,
      opens: support.opens,
      closes: support.closes,
      answers: brandHelp(book?.playsPerBikeHour ?? PRICE_BOOK_V1.playsPerBikeHour),
      adRules: adRulesText(book?.ads ?? DEFAULT_AD_RULES),
      questions: await brandQuestions(pool, a.brandId),
    });
    return true;
  }
  if (path === '/portal/help' && method === 'POST') {
    const a = await account();
    const b = await jsonBody(req);
    const threadId = await refused(() =>
      askFromPortal(
        pool,
        {
          brandId: a.brandId,
          contact: me.address,
          subject: str(b, 'subject', 200),
          text: str(b, 'text', 5000),
        },
        now,
        rules,
      ),
    );
    send(res, 200, { threadId });
    return true;
  }
  if (path === '/portal/statement' && method === 'GET') {
    const a = await account();
    if (a.kind !== 'agency')
      throw new HttpError(400, 'Statements are for agencies', { code: 'not-an-agency' });
    // Money owed to the agency: its owners only.
    if (a.role !== 'owner')
      throw new HttpError(403, "Only the agency's owners see its statement", { code: 'not-owner' });
    const asked = new URL(req.url ?? '/', 'http://x').searchParams.get('month');
    const month =
      asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked)
        ? asked
        : new Date((now + 19_800) * 1000).toISOString().slice(0, 7);
    const s = await partnerStatement(pool, a.brandId, 'agency', month);
    // Our staff's names stay ours: payments show the date, amount and bank reference.
    send(res, 200, {
      account: a,
      ...s,
      payments: s.payments.map((p) => ({
        at: p.at,
        amountPaise: p.amountPaise,
        reference: p.reference,
      })),
    });
    return true;
  }
  if (path === '/portal/team' && method === 'GET') {
    const a = await account();
    const ag = await pool.query<{ name: string | null }>(
      `SELECT (SELECT name FROM brand_versions g WHERE g.brand_id = v.agency_id
                ORDER BY version DESC LIMIT 1) AS name
         FROM brand_versions v WHERE v.brand_id = $1 ORDER BY version DESC LIMIT 1`,
      [a.brandId],
    );
    send(res, 200, {
      account: a,
      me: me.address,
      team: (await brandTeam(pool, a.brandId)).map((m) => ({
        address: m.address,
        shown: shown(m.address),
        role: m.role,
        since: m.setAt,
      })),
      max: rules.teamMax,
      // P5.10: the agency our team linked: its people book for this brand too.
      agency: ag.rows[0]?.name ?? null,
    });
    return true;
  }
  if (path === '/portal/team' && method === 'POST') {
    const a = await account();
    if (a.role !== 'owner')
      throw new HttpError(403, 'Only an owner changes the team', { code: 'not-owner' });
    const b = await jsonBody(req);
    const role = b.role;
    if (!BRAND_MEMBER_ROLES.includes(role as BrandMemberRole))
      throw new HttpError(400, 'role: owner or booker');
    if (typeof b.active !== 'boolean') throw new HttpError(400, 'active: true or false');
    const version = await refused(() =>
      setTeamMember(
        pool,
        {
          brandId: a.brandId,
          owner: me.address,
          address: addressOf(b),
          role: role as BrandMemberRole,
          active: b.active as boolean,
        },
        now,
        rules,
      ),
    );
    send(res, 200, { version });
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
