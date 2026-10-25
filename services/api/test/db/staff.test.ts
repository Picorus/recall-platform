// The whole staff journey over HTTP on a real database: first super admin, invite, sign-in with the
// two-step code, adding an admin, access checks, locks, resets, switching off.
import { addStaff } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { DEFAULT_SIGN_IN_RULES as R } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken, newTotpSecret, seal, tokenHash, totpCode } from '../../src/secrets.js';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
let now = 1_800_000_000_000;
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  trustProxy: false,
};
const PW = 'green kettle 42 mango';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  server = createServer(
    apiHandler(
      pool,
      CFG,
      () => {},
      () => now,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookie?: string | undefined;
}

async function call(
  method: string,
  path: string,
  body?: object,
  cookie?: string,
  origin = ORIGIN,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (method === 'POST' && origin) headers.origin = origin;
  const r = await fetch(url + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const set = r.headers.get('set-cookie') ?? undefined;
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
    cookie: set?.split(';')[0],
  };
}

const step = () => Math.floor(now / 30_000);
/** Moves the clock on a step, so each sign-in has a fresh code. */
const tick = () => {
  now += 30_000;
};

async function acceptInvite(token: string): Promise<string> {
  const inv = await call('GET', `/staff/invite?t=${token}`);
  expect(inv.status).toBe(200);
  const secret = inv.body.secret as string;
  const ok = await call('POST', '/staff/invite', {
    token,
    password: PW,
    code: totpCode(secret, step()),
  });
  expect(ok.status).toBe(200);
  return secret;
}

async function signIn(email: string, secret: string, password = PW): Promise<Res> {
  tick();
  return call('POST', '/staff/sign-in', { email, password, code: totpCode(secret, step()) });
}

let superSecret = '';
let superCookie = '';

describe('staff sign-in', () => {
  it('the first super admin: invite, password, two-step code, sign in', async () => {
    const token = newToken();
    await addStaff(pool, {
      email: ' Prateek@Recall.in ',
      name: 'Prateek',
      access: { role: 'super-admin', areas: [] },
      byId: 'setup',
      reason: 'first super admin',
      invite: {
        tokenHash: tokenHash(token),
        totpSealed: seal(CFG.secretKey, newTotpSecret()),
        untilMs: now + R.inviteMs,
      },
      nowMs: now,
    });
    // A second "first" member is refused.
    await expect(
      addStaff(pool, {
        email: 'x@recall.in',
        name: 'X',
        access: { role: 'super-admin', areas: [] },
        byId: 'setup',
        reason: 'again',
        invite: { tokenHash: tokenHash(newToken()), totpSealed: 'x', untilMs: now + 1000 },
        nowMs: now,
      }),
    ).rejects.toThrow('Staff already exist');

    // A weak password or a wrong code is refused, and the invite stays usable.
    const inv = await call('GET', `/staff/invite?t=${token}`);
    expect(inv.body.email).toBe('prateek@recall.in');
    expect(inv.body.otpauth).toMatch(/^otpauth:\/\/totp\/RECALL%3Aprateek%40recall\.in\?secret=/);
    const secret = inv.body.secret as string;
    expect(
      (
        await call('POST', '/staff/invite', {
          token,
          password: 'short',
          code: totpCode(secret, step()),
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', '/staff/invite', { token, password: PW, code: '000000' })).status,
    ).toBe(400);
    superSecret = await acceptInvite(token);
    // Used once only.
    expect((await call('GET', `/staff/invite?t=${token}`)).status).toBe(404);

    const r = await signIn('PRATEEK@recall.in', superSecret);
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({
      email: 'prateek@recall.in',
      role: 'super-admin',
      active: true,
    });
    expect(r.cookie).toMatch(/^__Host-recall_staff=/);
    superCookie = r.cookie ?? '';
    const me = await call('GET', '/staff/me', undefined, superCookie);
    expect(me.body.member).toMatchObject({ name: 'Prateek' });
  });

  it('the cookie cannot be read by scripts, goes only to this site and only over HTTPS', async () => {
    tick();
    const r = await fetch(`${url}/staff/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        email: 'prateek@recall.in',
        password: PW,
        code: totpCode(superSecret, step()),
      }),
    });
    const c = r.headers.get('set-cookie') ?? '';
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('a code is good once, and wrong details all get the same answer', async () => {
    tick();
    const code = totpCode(superSecret, step());
    const first = await call('POST', '/staff/sign-in', {
      email: 'prateek@recall.in',
      password: PW,
      code,
    });
    expect(first.status).toBe(200);
    const again = await call('POST', '/staff/sign-in', {
      email: 'prateek@recall.in',
      password: PW,
      code,
    });
    expect(again.status).toBe(401);
    const unknown = await call('POST', '/staff/sign-in', {
      email: 'nobody@recall.in',
      password: PW,
      code,
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(again.body.error);
  });

  it('changes come only from the admin site, as JSON', async () => {
    const body = { email: 'prateek@recall.in', password: PW, code: '123456' };
    expect(
      (await call('POST', '/staff/sign-in', body, undefined, 'https://evil.test')).status,
    ).toBe(403);
    expect((await call('POST', '/staff/sign-in', body, undefined, '')).status).toBe(403);
    const form = await fetch(`${url}/staff/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: ORIGIN },
      body: JSON.stringify(body),
    });
    expect(form.status).toBe(415);
    expect((await call('DELETE', '/staff/me')).status).toBe(405);
  });

  let adminId = '';
  let adminSecret = '';
  let adminCookie = '';

  it('a super admin adds an admin with ticked areas; the admin cannot manage staff', async () => {
    const add = await call(
      'POST',
      '/staff',
      {
        email: 'meena@recall.in',
        name: 'Meena Iyer',
        role: 'admin',
        areas: ['finance'],
        reason: 'finance lead',
      },
      superCookie,
    );
    expect(add.status).toBe(200);
    adminId = (add.body.member as { id: string }).id;
    expect(adminId).toMatch(/^STF-[0-9a-f]{12}$/);
    adminSecret = await acceptInvite(add.body.inviteToken as string);
    const r = await signIn('meena@recall.in', adminSecret);
    expect(r.status).toBe(200);
    adminCookie = r.cookie ?? '';
    expect((await call('GET', '/staff', undefined, adminCookie)).status).toBe(403);
    const sneaky = await call(
      'POST',
      '/staff',
      {
        email: 'friend@recall.in',
        name: 'Friend',
        role: 'super-admin',
        areas: [],
        reason: 'please',
      },
      adminCookie,
    );
    expect(sneaky.status).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/staff/${adminId}/access`,
          { role: 'super-admin', areas: [], active: true, reason: 'me' },
          adminCookie,
        )
      ).status,
    ).toBe(403);
    // The same email twice is refused; a bad access too.
    expect(
      (
        await call(
          'POST',
          '/staff',
          { email: 'MEENA@recall.in', name: 'M', role: 'admin', areas: ['sales'], reason: 'again' },
          superCookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/staff',
          { email: 'a@recall.in', name: 'A', role: 'admin', areas: [], reason: 'none' },
          superCookie,
        )
      ).status,
    ).toBe(400);
    const list = await call('GET', '/staff', undefined, superCookie);
    expect((list.body.staff as unknown[]).length).toBe(2);
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt|v1\./);
  });

  it('not signed in: 401', async () => {
    expect((await call('GET', '/staff/me')).status).toBe(401);
    expect((await call('GET', '/staff/me', undefined, '__Host-recall_staff=madeup')).status).toBe(
      401,
    );
  });

  it('5 wrong tries lock the account for 15 minutes, even with the right details', async () => {
    for (let i = 0; i < 5; i++)
      expect((await signIn('meena@recall.in', adminSecret, 'wrong password!!')).status).toBe(401);
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(401);
    now += R.lockMs;
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(200);
  });

  it('a session ends after 30 minutes idle, and after 12 hours whatever happens', async () => {
    const r = await signIn('meena@recall.in', adminSecret);
    const cookie = r.cookie ?? '';
    now += R.idleMs - 60_000;
    expect((await call('GET', '/staff/me', undefined, cookie)).status).toBe(200);
    now += R.idleMs - 60_000; // still used within each 30 minutes
    expect((await call('GET', '/staff/me', undefined, cookie)).status).toBe(200);
    now += R.idleMs;
    expect((await call('GET', '/staff/me', undefined, cookie)).status).toBe(401);

    const s = await signIn('meena@recall.in', adminSecret);
    for (let t = 0; t < R.sessionMs; t += 20 * 60_000) {
      now += 20 * 60_000;
      const st = (await call('GET', '/staff/me', undefined, s.cookie)).status;
      if (t + 20 * 60_000 < R.sessionMs - 30_000) expect(st).toBe(200);
      else expect(st).toBe(401);
    }
  });

  it('signing out ends the session', async () => {
    const r = await signIn('meena@recall.in', adminSecret);
    expect((await call('POST', '/staff/sign-out', {}, r.cookie)).status).toBe(200);
    expect((await call('GET', '/staff/me', undefined, r.cookie)).status).toBe(401);
  });

  it('changing access ends their sessions; the last super admin cannot be removed', async () => {
    const r = await signIn('meena@recall.in', adminSecret);
    superCookie = (await signIn('prateek@recall.in', superSecret)).cookie ?? '';
    const ch = await call(
      'POST',
      `/staff/${adminId}/access`,
      { role: 'read-only', areas: ['finance'], active: true, reason: 'moved to audit' },
      superCookie,
    );
    expect(ch.status).toBe(200);
    expect((await call('GET', '/staff/me', undefined, r.cookie)).status).toBe(401);
    const again = await signIn('meena@recall.in', adminSecret);
    expect(again.body.member).toMatchObject({ role: 'read-only', areas: ['finance'] });

    const me = (await call('GET', '/staff/me', undefined, superCookie)).body.member as {
      id: string;
    };
    const off = await call(
      'POST',
      `/staff/${me.id}/access`,
      { role: 'admin', areas: ['sales'], active: true, reason: 'oops' },
      superCookie,
    );
    expect(off.status).toBe(400);
    expect(off.body.error).toBe('There must always be one active super admin');
  });

  it('a reset stops the old password at once; the new invite sets new ones', async () => {
    const r = await call('POST', `/staff/${adminId}/reset`, {}, superCookie);
    expect(r.status).toBe(200);
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(401);
    const secret = await acceptInvite(r.body.inviteToken as string);
    expect(secret).not.toBe(adminSecret);
    expect((await signIn('meena@recall.in', secret)).status).toBe(200);
    adminSecret = secret;
  });

  it('a member switched off cannot sign in and their sessions end', async () => {
    const r = await signIn('meena@recall.in', adminSecret);
    const off = await call(
      'POST',
      `/staff/${adminId}/access`,
      { role: 'read-only', areas: ['finance'], active: false, reason: 'left RECALL' },
      superCookie,
    );
    expect(off.status).toBe(200);
    expect((await call('GET', '/staff/me', undefined, r.cookie)).status).toBe(401);
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(401);
  });

  it('nothing is edited or deleted: every try, change and session is kept', async () => {
    await expect(pool.query('DELETE FROM staff_sign_ins')).rejects.toThrow();
    await expect(pool.query("UPDATE staff_access SET role = 'super-admin'")).rejects.toThrow();
    const tries = await pool.query<{ ok: boolean; why: string }>(
      'SELECT ok, why FROM staff_sign_ins',
    );
    expect(tries.rows.filter((x) => x.why === 'locked').length).toBeGreaterThan(0);
    const changes = await pool.query('SELECT * FROM staff_access');
    expect(changes.rows.length).toBe(4); // 2 added, 1 changed, 1 switched off (the refused change is not kept)
    const secrets = await pool.query<{ totp_secret: string; password_hash: string }>(
      'SELECT totp_secret, password_hash FROM staff_credentials',
    );
    for (const s of secrets.rows) {
      expect(s.totp_secret).toMatch(/^v1\./);
      expect(s.password_hash).toMatch(/^scrypt\$/);
    }
  });
});
