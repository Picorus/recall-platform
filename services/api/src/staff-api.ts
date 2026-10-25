// P3.1: staff sign-in and the super admin's staff page, over HTTP.
//
// - Sign in with email, password and the 6-digit two-step code; a session cookie that scripts
//   cannot read (HttpOnly), sent only to this site (SameSite=Strict) and only over HTTPS.
// - Every change (POST) must come from the admin site itself (its Origin), as JSON.
// - A new member (or one reset) gets a one-time invite link to set a password and add RECALL to
//   their authenticator app; the code from the app is checked before the invite is used.
// - `staffFor(req, need)` is how every other admin route asks who is calling and whether they may.
import {
  accessProblem,
  can,
  DEFAULT_SIGN_IN_RULES,
  passwordProblem,
  STAFF_AREAS,
  STAFF_ROLES,
  type Need,
  type SignInRules,
  type StaffAccess,
} from '@recall/domain';
import {
  acceptInvite,
  addStaff,
  changeAccess,
  endSession,
  openInvite,
  resetStaff,
  sessionMember,
  signIn,
  staffList,
  type NewInvite,
  type StaffMember,
} from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { cookies, HttpError, jsonBody, send, str } from './http.js';
import {
  decoyHash,
  hashPassword,
  newToken,
  newTotpSecret,
  otpauthUri,
  passwordMatches,
  seal,
  tokenHash,
  totpStep,
  unseal,
} from './secrets.js';

export interface StaffApiConfig {
  /** 32-byte key that keeps two-step secrets encrypted (from the secret store). */
  readonly secretKey: Buffer;
  /** The admin site's origin(s), e.g. https://admin.recall.in: the only place changes come from. */
  readonly origins: readonly string[];
  /** HTTPS cookies (off only on a laptop over plain http). */
  readonly secureCookies: boolean;
  /** Take the caller's address from X-Forwarded-For (only behind our own proxy). */
  readonly trustProxy: boolean;
  readonly rules?: SignInRules;
}

const cookieName = (cfg: StaffApiConfig) =>
  cfg.secureCookies ? '__Host-recall_staff' : 'recall_staff';

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

function callerIp(req: IncomingMessage, cfg: StaffApiConfig): string {
  if (cfg.trustProxy) {
    // Our proxy adds the address it saw last; anything before it the caller could have written.
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',');
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** What a page may show of a member (never secrets). */
const shown = (m: StaffMember) => ({
  id: m.id,
  email: m.email,
  name: m.name,
  role: m.access.role,
  areas: m.access.areas,
  active: m.active,
});

/**
 * The signed-in member, checked against `need`: 401 when not signed in, 403 when not allowed.
 * Every admin route calls this first.
 */
export async function staffFor(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  nowMs: number,
  need?: Need,
): Promise<StaffMember> {
  const token = cookies(req).get(cookieName(cfg));
  const m = token
    ? await sessionMember(pool, tokenHash(token), nowMs, cfg.rules ?? DEFAULT_SIGN_IN_RULES)
    : undefined;
  if (!m) throw new HttpError(401, 'Please sign in');
  if (need && !can(m.access, need)) throw new HttpError(403, 'Your access does not cover this');
  return m;
}

function readAccess(x: Record<string, unknown>): StaffAccess {
  const access = { role: x.role, areas: x.areas };
  const problem = accessProblem(access);
  if (problem) throw new HttpError(400, `Access: ${problem}`);
  return access as StaffAccess;
}

/** A new invite: the link's token (shown once to the super admin) and what is stored. */
function makeInvite(cfg: StaffApiConfig, nowMs: number): { token: string; invite: NewInvite } {
  const token = newToken();
  const rules = cfg.rules ?? DEFAULT_SIGN_IN_RULES;
  return {
    token,
    invite: {
      tokenHash: tokenHash(token),
      totpSealed: seal(cfg.secretKey, newTotpSecret()),
      untilMs: nowMs + rules.inviteMs,
    },
  };
}

const SIGN_IN_FAILED =
  'Sign-in failed. Check your email, password and code. After 5 wrong tries, wait 15 minutes.';

/** Handles /staff/... requests; returns false for other paths. */
export async function handleStaff(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://api');
  const path = url.pathname;
  if (path !== '/staff' && !path.startsWith('/staff/')) return false;
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    // Changes only from the admin site itself (with SameSite cookies: no cross-site forgery).
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') {
    throw new HttpError(405, 'Not allowed');
  }
  const rules = cfg.rules ?? DEFAULT_SIGN_IN_RULES;

  if (method === 'POST' && path === '/staff/sign-in') {
    const b = await jsonBody(req);
    const email = str(b, 'email', 254);
    const password = str(b, 'password', 200);
    const code = str(b, 'code', 10).replace(/\s/g, '');
    const token = newToken();
    const r = await signIn(pool, {
      email,
      ip: callerIp(req, cfg),
      agent: String(req.headers['user-agent'] ?? ''),
      sessionHash: tokenHash(token),
      nowMs,
      rules,
      check: async (cred) => {
        // An unknown member is checked against a decoy, so the answer takes as long.
        const pwOk = await passwordMatches(password, cred?.passwordHash ?? (await decoyHash()));
        if (!cred || !pwOk) return undefined;
        return totpStep(unseal(cfg.secretKey, cred.totpSealed), code, nowMs, cred.usedUpTo);
      },
    });
    if (!r.ok) {
      send(res, r.why === 'too-many-here' ? 429 : 401, { error: SIGN_IN_FAILED });
      return true;
    }
    send(
      res,
      200,
      { member: shown(r.member) },
      {
        'set-cookie': sessionCookie(cfg, token, Math.floor(rules.sessionMs / 1000)),
      },
    );
    return true;
  }

  if (method === 'POST' && path === '/staff/sign-out') {
    const token = cookies(req).get(cookieName(cfg));
    if (token) await endSession(pool, tokenHash(token), 'signed-out', nowMs);
    send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(cfg, '', 0) });
    return true;
  }

  if (method === 'GET' && path === '/staff/me') {
    send(res, 200, { member: shown(await staffFor(pool, cfg, req, nowMs)) });
    return true;
  }

  // The invite page: shows the secret for the authenticator app (the link itself is the secret).
  if (method === 'GET' && path === '/staff/invite') {
    const inv = await openInvite(pool, tokenHash(url.searchParams.get('t') ?? ''), nowMs);
    if (!inv)
      throw new HttpError(
        404,
        'This link has expired or was used. Ask a super admin for a new one.',
      );
    const secret = unseal(cfg.secretKey, inv.totpSealed);
    send(res, 200, {
      email: inv.email,
      name: inv.name,
      secret,
      otpauth: otpauthUri(secret, inv.email),
    });
    return true;
  }

  if (method === 'POST' && path === '/staff/invite') {
    const b = await jsonBody(req);
    const hash = tokenHash(str(b, 'token', 100));
    const password = str(b, 'password', 200);
    const code = str(b, 'code', 10).replace(/\s/g, '');
    const inv = await openInvite(pool, hash, nowMs);
    if (!inv)
      throw new HttpError(
        404,
        'This link has expired or was used. Ask a super admin for a new one.',
      );
    const problem = passwordProblem(password, inv.email);
    if (problem) throw new HttpError(400, `Password: ${problem}`);
    if (totpStep(unseal(cfg.secretKey, inv.totpSealed), code, nowMs) === undefined)
      throw new HttpError(400, 'The code does not match. Check the app and try the newest code.');
    if (!(await acceptInvite(pool, hash, await hashPassword(password), nowMs)))
      throw new HttpError(
        404,
        'This link has expired or was used. Ask a super admin for a new one.',
      );
    send(res, 200, { ok: true });
    return true;
  }

  // ---- the super admin's staff page
  const superNeed: Need = { superAdmin: true };

  if (method === 'GET' && path === '/staff') {
    await staffFor(pool, cfg, req, nowMs, superNeed);
    send(res, 200, {
      staff: (await staffList(pool)).map(shown),
      roles: STAFF_ROLES,
      areas: STAFF_AREAS,
    });
    return true;
  }

  if (method === 'POST' && path === '/staff') {
    const by = await staffFor(pool, cfg, req, nowMs, superNeed);
    const b = await jsonBody(req);
    const { token, invite } = makeInvite(cfg, nowMs);
    const m = await asBadRequest(() =>
      addStaff(pool, {
        email: str(b, 'email', 254),
        name: str(b, 'name', 80),
        access: readAccess(b),
        byId: by.id,
        reason: str(b, 'reason', 200),
        invite,
        nowMs,
      }),
    );
    send(res, 200, { member: shown(m), inviteToken: token, inviteUntil: invite.untilMs });
    return true;
  }

  const one = /^\/staff\/(STF-[0-9a-f]{12})\/(access|reset)$/.exec(path);
  if (method === 'POST' && one) {
    const by = await staffFor(pool, cfg, req, nowMs, superNeed);
    const b = await jsonBody(req);
    const staffId = one[1] ?? '';
    if (one[2] === 'access') {
      if (typeof b.active !== 'boolean') throw new HttpError(400, 'active is missing');
      const active = b.active;
      const m = await asBadRequest(() =>
        changeAccess(pool, {
          staffId,
          access: readAccess(b),
          active,
          byId: by.id,
          reason: str(b, 'reason', 200),
          nowMs,
        }),
      );
      send(res, 200, { member: shown(m) });
    } else {
      const { token, invite } = makeInvite(cfg, nowMs);
      await asBadRequest(() => resetStaff(pool, { staffId, byId: by.id, invite, nowMs }));
      send(res, 200, { inviteToken: token, inviteUntil: invite.untilMs });
    }
    return true;
  }

  throw new HttpError(404, 'Not found');
}

/** The database's refusals (rules, not faults) become 400 with their message. */
async function asBadRequest<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as Error).message;
    if (
      e instanceof RangeError ||
      /^(Only|There must|That email|No such|Staff already|The first)/.test(msg)
    )
      throw new HttpError(e instanceof Error && msg.startsWith('Only') ? 403 : 400, msg);
    throw e;
  }
}

/** The API's request handler (P3.1: staff; more routes join in later steps). */
export function apiHandler(
  pool: Pool,
  cfg: StaffApiConfig,
  log: (line: string) => void = (l) => console.error(l),
  clock: () => number = Date.now,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const nowMs = clock();
    (async () => {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
      if (await handleStaff(pool, cfg, req, res, nowMs)) return;
      throw new HttpError(404, 'Not found');
    })().catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log(
        `api: ${req.method} ${new URL(req.url ?? '/', 'http://api').pathname}: ${(e as Error).stack ?? String(e)}`,
      );
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Try again.' });
    });
  };
}
