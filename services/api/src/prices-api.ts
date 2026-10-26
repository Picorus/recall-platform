// P3.6: the "Prices and rules" page's API. Sales, Finance and super admins look; only a super admin
// changes prices and rules (DECISIONS, 22 Oct 2026), with a reason. A change is the next price
// book version, starting now; bookings keep the version they were sold on.
//   GET  /prices          every version (newest first) with who, when, why and what changed
//   POST /prices/check    { baseVersion, change } → the problems and the changes in words; nothing saved
//   POST /prices          { baseVersion, change, reason }
// `baseVersion` is the version the page showed (null before any): if someone saved since, the
// page is told to reload rather than overwrite their change unseen.
import {
  applyPriceChange,
  BAND_NAMES,
  can,
  checkPriceChange,
  describePriceChange,
  firstVersionFrom,
  pageBook,
  PLAIN_SETTINGS,
  PRICE_BOOK_V1,
  priceBookAt,
  START_HOURS,
  type BandName,
  type PriceChange,
  type StaffAccess,
} from '@recall/domain';
import { openQuotes, PriceBookError, priceBookRecords, savePriceBook } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { superAdmin: true }) ||
  can(a, { area: 'sales', change: false }) ||
  can(a, { area: 'finance', change: false });

const RELOAD = 'Someone changed prices just now: reload the page and try again';

function num(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x))
    throw new HttpError(400, `${what} must be a number`);
  return x;
}

function obj(x: unknown, what: string): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x))
    throw new HttpError(400, `${what} must be a list of values`);
  return x as Record<string, unknown>;
}

/** The change the page sent, read strictly: an unknown setting is refused, never ignored. */
export function readChange(x: unknown): PriceChange {
  const c = obj(x ?? {}, 'change');
  const known = new Set<string>(['prices', 'hourBands', 'offersBp', ...PLAIN_SETTINGS]);
  for (const k of Object.keys(c))
    if (!known.has(k)) throw new HttpError(400, `Unknown setting: ${k}`);
  const out: Record<string, unknown> = {};
  if (c.prices !== undefined) {
    const p = obj(c.prices, 'prices');
    const prices: Partial<Record<BandName, number>> = {};
    for (const [k, v] of Object.entries(p)) {
      if (!BAND_NAMES.includes(k as BandName)) throw new HttpError(400, `No band called ${k}`);
      prices[k as BandName] = num(v, `${k} price`);
    }
    out.prices = prices;
  }
  if (c.hourBands !== undefined) {
    const h = obj(c.hourBands, 'hourBands');
    const hourBands: Record<number, BandName> = {};
    for (const [k, v] of Object.entries(h)) {
      if (!START_HOURS.includes(Number(k)) || String(Number(k)) !== k)
        throw new HttpError(400, `${k} is not a start hour (8 to 25)`);
      if (!BAND_NAMES.includes(v as BandName))
        throw new HttpError(400, `No band called ${String(v)}`);
      hourBands[Number(k)] = v as BandName;
    }
    out.hourBands = hourBands;
  }
  if (c.offersBp !== undefined) {
    const o = obj(c.offersBp, 'offersBp');
    if (Object.keys(o).length > 10) throw new HttpError(400, 'At most 10 offers');
    const offers: Record<number, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!/^[1-9]\d?$/.test(k)) throw new HttpError(400, `${k} is not a number of months`);
      offers[Number(k)] = num(v, `the ${k}-month offer`);
    }
    out.offersBp = offers;
  }
  for (const k of PLAIN_SETTINGS) if (c[k] !== undefined) out[k] = num(c[k], k);
  return out as PriceChange;
}

/** Now, rounded up to the next whole second (never in the past; not scheduled ahead). */
const startNow = (nowMs: number) => new Date(Math.ceil(nowMs / 1000) * 1000).toISOString();

export async function handlePrices(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/prices' && !path.startsWith('/prices/')) return false;
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');

  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
  const records = await priceBookRecords(pool);
  const books = records.map((r) => r.book);
  const newest = books[books.length - 1];
  const start = startNow(nowMs);

  if (method === 'GET' && path === '/prices') {
    // In force this second (a change saved now starts at the next whole second).
    const inForce = priceBookAt(books, start);
    const versions = records
      .map((r, i) => ({
        version: r.book.version,
        validFrom: r.book.validFrom,
        savedBy: r.savedBy,
        savedAt: r.savedAt,
        reason: r.reason,
        changes: describePriceChange(books[i - 1], r.book),
        book: pageBook(r.book),
      }))
      .reverse();
    send(res, 200, {
      at: Math.floor(nowMs / 1000),
      versions,
      inForce: inForce?.version ?? null,
      // Before any version is saved, the page offers the plan's book as the first one.
      plan: newest ? null : pageBook(PRICE_BOOK_V1),
    });
    return true;
  }
  if (method !== 'POST' || (path !== '/prices' && path !== '/prices/check'))
    throw new HttpError(404, 'Not found');

  const b = await jsonBody(req);
  const saving = path === '/prices';
  if (saving && !can(me.access, { superAdmin: true }))
    throw new HttpError(403, 'Only a super admin changes prices and rules');
  const base = b.baseVersion === null ? null : num(b.baseVersion, 'baseVersion');
  if (base !== (newest?.version ?? null)) throw new HttpError(409, RELOAD);
  const change = readChange(b.change);
  const reason = saving ? str(b, 'reason', 200).trim() : '';
  if (saving && reason.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
  // The first version starts with the month, so monthly rules (rider pay) find it (review P3.6).
  let from = newest ? start : firstVersionFrom(nowMs);
  if (newest) {
    const at = Date.parse(newest.validFrom);
    // Saved within the same second as the last version: start one second after it (a version must
    // start after the one before). Two saves at once are told apart by `baseVersion` and the database.
    if (at === Date.parse(start)) from = new Date(at + 1000).toISOString();
    else if (at > Date.parse(start))
      throw new HttpError(
        409,
        `Version ${newest.version} already starts at ${newest.validFrom}: a new one must start after it`,
      );
  }
  const next = applyPriceChange(newest, change, from);
  const problems = checkPriceChange(next);
  const changes = describePriceChange(newest, next);

  if (!saving) {
    // Open quotes are made again at the new prices (Prateek, 22 Oct 2026): say how many first.
    send(res, 200, { problems, changes, openQuotes: newest ? await openQuotes(pool) : 0 });
    return true;
  }
  if (problems.length > 0) throw new HttpError(400, problems.join('; '));
  if (changes.length === 0 && newest) throw new HttpError(400, 'Nothing changed');
  const who = `${me.name} (${me.id})`.slice(0, 120);
  try {
    await savePriceBook(pool, next, who, reason);
  } catch (e) {
    if (e instanceof PriceBookError) throw new HttpError(400, e.problems.join('; '));
    const msg = (e as { message?: string }).message ?? '';
    if (
      (e as { code?: string }).code === '23505' ||
      /next version must be|must start after/.test(msg)
    )
      throw new HttpError(409, RELOAD);
    throw e;
  }
  send(res, 200, {
    version: next.version,
    validFrom: next.validFrom,
    changes,
    openQuotes: newest ? await openQuotes(pool) : 0,
  });
  return true;
}
