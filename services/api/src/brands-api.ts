// P3.8.1: the Brands page's API. Sales, Finance and Support look (read-only members too); a Sales
// admin opens and changes accounts, their contact and notes; a Sales or Finance admin sets tax
// details. Every change is logged with who (and why, for account details).
//   GET  /brands                    every account with its contact, GSTIN and bookings
//   GET  /brands/<id>               one account's page
//   POST /brands                    { brandId, kind, name, agencyId?, referredBy?, reason }
//   POST /brands/<id>               { baseVersion, name, agencyId, referredBy, active, reason }
//   POST /brands/<id>/contact       { phone?, email? }
//   POST /brands/<id>/tax           { legalName, gstin?, stateCode, address? }
//   POST /brands/<id>/notes         { note }
import { ACCOUNT_ID, can, type AccountKind, type StaffAccess } from '@recall/domain';
import {
  accountList,
  accountPage,
  addAccountNote,
  createAccount,
  findAccount,
  Refusal,
  reviseAccount,
  setBrandContact,
  setBrandTaxProfile,
} from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) ||
  can(a, { area: 'finance', change: false }) ||
  can(a, { area: 'support', change: false });
const sales = { area: 'sales', change: true } as const;
const mayTax = (a: StaffAccess) =>
  can(a, { area: 'sales', change: true }) || can(a, { area: 'finance', change: true });

function reasonOf(b: Record<string, unknown>): string {
  const r = str(b, 'reason', 200).trim();
  if (r.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
  return r;
}

/** An optional account id from the body: null when absent or empty. */
function idOrNull(b: Record<string, unknown>, key: string): string | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !ACCOUNT_ID.test(v))
    throw new HttpError(400, `${key}: lower case letters, digits and dashes`);
  return v;
}

/** The rules' refusals and bad values are 400s with the reason; anything else is a fault. */
async function refusedAs400<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refusal && /reload/.test(e.message)) throw new HttpError(409, e.message);
    if (e instanceof Refusal || e instanceof RangeError) throw new HttpError(400, e.message);
    // setBrandContact names a bad phone or email with a plain Error.
    const msg = (e as Error).message ?? '';
    if (/^(phone|email|a phone)/.test(msg)) throw new HttpError(400, msg);
    throw e;
  }
}

export async function handleBrands(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/brands' && !path.startsWith('/brands/')) return false;
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');
  const now = Math.floor(nowMs / 1000);
  const m = /^\/brands(?:\/([a-z0-9][a-z0-9-]{0,63}))?(?:\/(contact|tax|notes))?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const id = m[1];
  const part = m[2];

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (part) throw new HttpError(404, 'Not found');
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (!id) {
      send(res, 200, { at: now, accounts: await accountList(pool) });
      return true;
    }
    const page = await accountPage(pool, id);
    if (!page) throw new HttpError(404, 'No such account');
    send(res, 200, { at: now, ...page });
    return true;
  }

  const b = await jsonBody(req);
  if (part === 'tax') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayTax(me.access))
      throw new HttpError(403, 'Only a Sales or Finance admin sets tax details');
    if (!id || !(await findAccount(pool, id))) throw new HttpError(404, 'No such account');
    const gstin =
      typeof b.gstin === 'string' && b.gstin.trim() !== ''
        ? b.gstin.trim().toUpperCase()
        : undefined;
    const legalName = str(b, 'legalName', 200).trim();
    if (legalName.length < 2) throw new HttpError(400, 'Legal name: 2 to 200 characters');
    await refusedAs400(() =>
      setBrandTaxProfile(
        pool,
        id,
        {
          legalName,
          ...(gstin ? { gstin } : {}),
          stateCode: str(b, 'stateCode', 2),
          address: typeof b.address === 'string' ? b.address.trim().slice(0, 300) : '',
        },
        `${me.name} (${me.id})`.slice(0, 120),
      ),
    );
    send(res, 200, { ok: true });
    return true;
  }

  const me = await staffFor(pool, cfg, req, nowMs, sales);
  const who = `${me.name} (${me.id})`.slice(0, 120);

  if (!id) {
    const kind = b.kind;
    if (kind !== 'brand' && kind !== 'agency')
      throw new HttpError(400, 'kind must be brand or agency');
    const brandId = str(b, 'brandId', 64).trim();
    await refusedAs400(() =>
      createAccount(
        pool,
        {
          brandId,
          kind: kind as AccountKind,
          details: {
            name: str(b, 'name', 120),
            agencyId: idOrNull(b, 'agencyId'),
            referredBy: idOrNull(b, 'referredBy'),
            active: true,
          },
          by: who,
          reason: reasonOf(b),
        },
        now,
      ),
    );
    send(res, 200, { brandId });
    return true;
  }
  if (!(await findAccount(pool, id))) throw new HttpError(404, 'No such account');

  if (part === 'contact') {
    const phone =
      typeof b.phone === 'string' && b.phone.trim() !== '' ? b.phone.replace(/\s/g, '') : undefined;
    const email = typeof b.email === 'string' && b.email.trim() !== '' ? b.email.trim() : undefined;
    await refusedAs400(() =>
      setBrandContact(pool, id, { ...(phone ? { phone } : {}), ...(email ? { email } : {}) }, who),
    );
    send(res, 200, { ok: true });
    return true;
  }
  if (part === 'notes') {
    await refusedAs400(() => addAccountNote(pool, id, str(b, 'note', 2000), who, now));
    send(res, 200, { ok: true });
    return true;
  }
  if (typeof b.baseVersion !== 'number') throw new HttpError(400, 'baseVersion must be a number');
  if (typeof b.active !== 'boolean') throw new HttpError(400, 'active must be true or false');
  const baseVersion = b.baseVersion;
  const active = b.active;
  const version = await refusedAs400(() =>
    reviseAccount(
      pool,
      {
        brandId: id,
        baseVersion,
        details: {
          name: str(b, 'name', 120),
          agencyId: idOrNull(b, 'agencyId'),
          referredBy: idOrNull(b, 'referredBy'),
          active,
        },
        by: who,
        reason: reasonOf(b),
      },
      now,
    ),
  );
  send(res, 200, { version });
  return true;
}
