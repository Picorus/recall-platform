// The whole staff journey over HTTP on a real database: first super admin, invite, sign-in with the
// two-step code, adding an admin, access checks, locks, resets, switching off.
import { addStaff, resetStaff, sessionMember, signIn as dbSignIn } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { DEFAULT_SIGN_IN_RULES as R } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newToken,
  newTotpSecret,
  seal,
  tokenHash,
  totpCode,
  totpStep,
  unseal,
} from '../../src/secrets.js';
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
  proxyHops: 1,
};
const PW = 'green kettle 42 mango';
const HOME_IP = '203.0.113.7';

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
  ip = HOME_IP,
): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': ip };
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

const openInvite = (token: string) => call('POST', '/staff/invite/open', { token });

async function acceptInvite(token: string): Promise<string> {
  const inv = await openInvite(token);
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

async function signIn(email: string, secret: string, password = PW, ip = HOME_IP): Promise<Res> {
  tick();
  return call(
    'POST',
    '/staff/sign-in',
    { email, password, code: totpCode(secret, step()) },
    undefined,
    ORIGIN,
    ip,
  );
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
    const inv = await openInvite(token);
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
    expect((await openInvite(token)).status).toBe(404);

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

  it('5 wrong tries lock the account from that address for 15 minutes, even with the right details', async () => {
    const away = '198.51.100.20';
    for (let i = 0; i < 5; i++)
      expect((await signIn('meena@recall.in', adminSecret, 'wrong password!!', away)).status).toBe(
        401,
      );
    expect((await signIn('meena@recall.in', adminSecret, PW, away)).status).toBe(401);
    // Nobody can keep a member out from elsewhere: from her own address she still signs in.
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(200);
    for (let i = 0; i < 5; i++)
      expect((await signIn('meena@recall.in', adminSecret, 'wrong password!!', away)).status).toBe(
        401,
      );
    now += R.lockMs;
    expect((await signIn('meena@recall.in', adminSecret, PW, away)).status).toBe(200);
  });

  it('an unknown email locks the same way (its answers give nothing away)', async () => {
    const ip = '198.51.100.21';
    for (let i = 0; i < 5; i++)
      await signIn('ghost@recall.in', adminSecret, 'wrong password!!', ip);
    const tries = await pool.query<{ why: string }>(
      "SELECT why FROM staff_sign_ins WHERE email = 'ghost@recall.in' ORDER BY id",
    );
    expect(tries.rows.map((x) => x.why)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'wrong']);
    await signIn('ghost@recall.in', adminSecret, 'wrong password!!', ip);
    const last = await pool.query<{ why: string }>(
      "SELECT why FROM staff_sign_ins WHERE email = 'ghost@recall.in' ORDER BY id DESC LIMIT 1",
    );
    expect(last.rows[0]?.why).toBe('locked');
  });

  it('30 wrong tries from one address, across emails, make it wait (429)', async () => {
    const ip = '2001:db8:1:2:aaaa::1';
    tick();
    for (let i = 0; i < 30; i++)
      await call(
        'POST',
        '/staff/sign-in',
        { email: `guess${i}@recall.in`, password: 'wrong password!!', code: '123456' },
        undefined,
        ORIGIN,
        ip,
      );
    // The same /64 network counts as one address.
    const r = await signIn('meena@recall.in', adminSecret, PW, '2001:db8:1:2:bbbb::9');
    expect(r.status).toBe(429);
    expect((await signIn('meena@recall.in', adminSecret)).status).toBe(200);
    now += R.lockMs;
  });

  it('the same code at once from two tries: one session only', async () => {
    tick();
    const body = { email: 'meena@recall.in', password: PW, code: totpCode(adminSecret, step()) };
    const both = await Promise.all([
      call('POST', '/staff/sign-in', body),
      call('POST', '/staff/sign-in', body),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('a read-only member cannot change staff', async () => {
    superCookie = (await signIn('prateek@recall.in', superSecret)).cookie ?? '';
    const add = await call(
      'POST',
      '/staff',
      {
        email: 'audit@recall.in',
        name: 'Auditor',
        role: 'read-only',
        areas: ['finance'],
        reason: 'yearly audit',
      },
      superCookie,
    );
    const secret = await acceptInvite(add.body.inviteToken as string);
    const r = await signIn('audit@recall.in', secret);
    expect(r.status).toBe(200);
    expect(
      (
        await call(
          'POST',
          '/staff',
          { email: 'x2@recall.in', name: 'X', role: 'admin', areas: ['sales'], reason: 'try' },
          r.cookie,
        )
      ).status,
    ).toBe(403);
    expect((await call('GET', '/staff', undefined, r.cookie)).status).toBe(403);
  });

  it('the code that confirmed an invite cannot then sign in', async () => {
    superCookie = (await signIn('prateek@recall.in', superSecret)).cookie ?? '';
    const add = await call(
      'POST',
      '/staff',
      {
        email: 'ravi@recall.in',
        name: 'Ravi',
        role: 'admin',
        areas: ['support'],
        reason: 'support desk',
      },
      superCookie,
    );
    const token = add.body.inviteToken as string;
    const secret = (await openInvite(token)).body.secret as string;
    const code = totpCode(secret, step());
    expect((await call('POST', '/staff/invite', { token, password: PW, code })).status).toBe(200);
    expect(
      (await call('POST', '/staff/sign-in', { email: 'ravi@recall.in', password: PW, code }))
        .status,
    ).toBe(401);
  });

  it('invites: expire after 48 hours; an older one stops after a reset; switching off ends them', async () => {
    superCookie = (await signIn('prateek@recall.in', superSecret)).cookie ?? '';
    const add = await call(
      'POST',
      '/staff',
      {
        email: 'kiran@recall.in',
        name: 'Kiran',
        role: 'admin',
        areas: ['operations'],
        reason: 'ops',
      },
      superCookie,
    );
    const id = (add.body.member as { id: string }).id;
    const first = add.body.inviteToken as string;
    expect((await openInvite(first)).status).toBe(200);
    tick();
    const second = (await call('POST', `/staff/${id}/reset`, {}, superCookie)).body
      .inviteToken as string;
    expect((await openInvite(first)).status).toBe(404);
    expect((await openInvite(second)).status).toBe(200);
    tick();
    const access = { role: 'admin', areas: ['operations'], reason: 'on leave' };
    expect(
      (await call('POST', `/staff/${id}/access`, { ...access, active: false }, superCookie)).status,
    ).toBe(200);
    expect((await openInvite(second)).status).toBe(404);
    tick();
    expect(
      (await call('POST', `/staff/${id}/access`, { ...access, active: true }, superCookie)).status,
    ).toBe(200);
    expect((await openInvite(second)).status).toBe(404);
    tick();
    const third = (await call('POST', `/staff/${id}/reset`, {}, superCookie)).body
      .inviteToken as string;
    expect((await openInvite(third)).status).toBe(200);
    now += R.inviteMs;
    expect((await openInvite(third)).status).toBe(404);
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
    const changes = await pool.query(
      "SELECT a.active, a.role FROM staff_access a JOIN staff s ON s.id = a.staff_id WHERE s.email = 'meena@recall.in' ORDER BY a.id",
    );
    // Added, made read-only, switched off: every change kept, in order.
    expect(changes.rows).toEqual([
      { active: true, role: 'admin' },
      { active: true, role: 'read-only' },
      { active: false, role: 'read-only' },
    ]);
    const secrets = await pool.query<{ totp_secret: string; password_hash: string }>(
      'SELECT totp_secret, password_hash FROM staff_credentials',
    );
    for (const s of secrets.rows) {
      expect(s.totp_secret).toMatch(/^v1\./);
      expect(s.password_hash).toMatch(/^scrypt\$/);
    }
  });
});

describe('robustness', () => {
  it('a malformed request line does not stop the API', async () => {
    const { port } = server.address() as AddressInfo;
    const answer = await new Promise<string>((ok, fail) => {
      const sock = connect(port, '127.0.0.1', () =>
        sock.write('GET http://% HTTP/1.1\r\nHost: x\r\n\r\n'),
      );
      let got = '';
      sock.on('data', (d) => {
        got += d.toString();
        sock.end();
      });
      sock.on('end', () => ok(got));
      sock.on('error', fail);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 (400|404)/);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('control characters are refused, not a server error', async () => {
    const r = await call('POST', '/staff/sign-in', {
      email: 'a\u0000@recall.in',
      password: PW,
      code: '123456',
    });
    expect(r.status).toBe(400);
  });

  it('a reset landing during a sign-in check wins: no session survives it', async () => {
    tick();
    const prateek = (await call('GET', '/staff/me', undefined, superCookie)).body.member as
      { id: string } | undefined;
    const sup =
      prateek ?? ((await signIn('prateek@recall.in', superSecret)).body.member as { id: string });
    const token = newToken();
    const add = await addStaff(pool, {
      email: 'race@recall.in',
      name: 'Race',
      access: { role: 'admin', areas: ['sales'] },
      byId: sup.id,
      reason: 'race test',
      invite: {
        tokenHash: tokenHash(token),
        totpSealed: seal(CFG.secretKey, newTotpSecret()),
        untilMs: now + R.inviteMs,
      },
      nowMs: now,
    });
    const secret = await acceptInvite(token);
    tick();
    const sessionHash = tokenHash(newToken());
    const r = await dbSignIn(pool, {
      email: 'race@recall.in',
      ip: '192.0.2.1',
      agent: 'test',
      sessionHash,
      nowMs: now,
      check: async (cred) => {
        // The super admin presses reset while the password is being checked.
        await resetStaff(pool, {
          staffId: add.id,
          byId: sup.id,
          invite: {
            tokenHash: tokenHash(newToken()),
            totpSealed: seal(CFG.secretKey, newTotpSecret()),
            untilMs: now + R.inviteMs,
          },
          nowMs: now,
        });
        return cred
          ? totpStep(
              unseal(CFG.secretKey, cred.totpSealed),
              totpCode(secret, step()),
              now,
              cred.usedUpTo,
            )
          : undefined;
      },
    });
    expect(r.ok).toBe(false);
    expect(await sessionMember(pool, sessionHash, now)).toBeUndefined();
  });
});
