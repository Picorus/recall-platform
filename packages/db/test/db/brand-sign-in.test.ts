// P5.1: brand portal sign-in: a code by WhatsApp, SMS or email (few per number or email, per day, per
// connection), kept only as a fingerprint; right once, within its minutes and tries; only the
// newest code counts; a session until signed out or idle; portal access given and removed by staff
// as versions, checked each time; every try kept and in the audit log.
import { fakeMessages } from '@recall/adapters';
import { DEFAULT_BRAND_SIGN_IN as R, type AccountDetails } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askBrandCode,
  brandSession,
  checkBrandCode,
  endBrandSession,
  portalAccounts,
  portalMembers,
  setPortalMember,
} from '../../src/brand-sign-in.js';
import { createAccount, findAccount, reviseAccount } from '../../src/brands.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SECRET = Buffer.alloc(32, 9);
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const ASHA = '+919848011111';
const MEDIA = 'media@adwise.in';

const plain = (name: string): AccountDetails => ({
  name,
  agencyId: null,
  referredBy: null,
  active: true,
});

/** The code in the last message sent to a number or email. */
const lastCode = (m: ReturnType<typeof fakeMessages>, to: string) => {
  const x = [...m.sent].reverse().find((s) => s.to === to);
  if (!x) return '';
  return x.channel === 'whatsapp'
    ? (x.params[0] ?? '')
    : x.channel === 'sms'
      ? x.text.slice(0, 6)
      : x.subject.slice(0, 6);
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await createAccount(
    pool,
    {
      brandId: 'adwise',
      kind: 'agency',
      details: plain('Adwise Media'),
      by: 'Sana',
      reason: 'signed',
    },
    NOW - 86_400,
  );
  await createAccount(
    pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: plain('Chai Co'),
      by: 'Sana',
      reason: 'first call',
    },
    NOW - 86_400,
  );
}, 60_000);
afterAll(async () => db.drop());

describe('brand portal sign-in (P5.1)', () => {
  it('a code on WhatsApp; right once; a session; nothing stored in clear', async () => {
    const m = fakeMessages();
    const ask = { address: ASHA, channel: 'whatsapp' as const, ip: '10.0.0.1' };
    expect(await askBrandCode(pool, m, ask, SECRET, NOW)).toEqual({
      expiresAt: NOW + R.codeSeconds,
    });
    const sent = m.sent[0];
    expect(sent).toMatchObject({
      channel: 'whatsapp',
      to: ASHA,
      template: 'sign_in_code',
      language: 'en',
    });
    const code = lastCode(m, ASHA);
    expect(code).toMatch(/^\d{6}$/);
    const stored = await pool.query<{ code_hash: string }>('SELECT code_hash FROM brand_codes');
    expect(stored.rows[0]?.code_hash).not.toContain(code);

    const s = await checkBrandCode(pool, { address: ASHA, code, ip: '10.0.0.1' }, SECRET, NOW + 30);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tokens = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM brand_sessions',
    );
    expect(tokens.rows[0]?.token_hash).not.toBe(s.token);
    expect(await brandSession(pool, s.token, NOW + 60)).toMatchObject({
      address: ASHA,
      startedAt: NOW + 30,
    });
    // The same code never opens a second session.
    await expect(
      checkBrandCode(pool, { address: ASHA, code, ip: '10.0.0.1' }, SECRET, NOW + 90),
    ).rejects.toThrow('This code no longer works');
    // No access yet: a new person, who sets up their business next (P5.2).
    expect(await portalAccounts(pool, ASHA)).toEqual([]);
  });

  it('an email gets its code by email; a number never by email; wrong tries counted, then dead', async () => {
    const m = fakeMessages();
    await askBrandCode(pool, m, { address: MEDIA, channel: 'email', ip: '10.0.0.2' }, SECRET, NOW);
    const mail = m.sent[0];
    expect(mail).toMatchObject({ channel: 'email', to: MEDIA });
    if (mail?.channel !== 'email') throw new Error('no email');
    expect(mail.text).toContain(`${R.codeSeconds / 60} minutes`);
    await expect(
      askBrandCode(pool, m, { address: ASHA, channel: 'email', ip: '10.0.0.2' }, SECRET, NOW),
    ).rejects.toThrow('An email address gets its code by email');
    const code = lastCode(m, MEDIA);
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(
      checkBrandCode(pool, { address: MEDIA, code: wrong, ip: '10.0.0.2' }, SECRET, NOW + 5),
    ).rejects.toThrow(`Wrong code: ${R.triesPerCode - 1} tries left`);
    for (let i = 1; i < R.triesPerCode; i++)
      await checkBrandCode(
        pool,
        { address: MEDIA, code: wrong, ip: '10.0.0.2' },
        SECRET,
        NOW + 5,
      ).catch(() => undefined);
    // Out of tries: even the right code no longer works.
    await expect(
      checkBrandCode(pool, { address: MEDIA, code, ip: '10.0.0.2' }, SECRET, NOW + 6),
    ).rejects.toThrow('This code no longer works');
    // A new code works.
    await askBrandCode(
      pool,
      m,
      { address: MEDIA, channel: 'email', ip: '10.0.0.2' },
      SECRET,
      NOW + 7,
    );
    const s = await checkBrandCode(
      pool,
      { address: MEDIA, code: lastCode(m, MEDIA), ip: '10.0.0.2' },
      SECRET,
      NOW + 8,
    );
    expect(await brandSession(pool, s.token, NOW + 9)).toMatchObject({ address: MEDIA });
  });

  it('few codes per number from one connection; a code that failed to go is not the live one', async () => {
    const m = fakeMessages();
    const n = '+919848022222';
    for (let i = 0; i < R.codesPer15Min; i++)
      await askBrandCode(pool, m, { address: n, channel: 'sms', ip: '10.0.0.3' }, SECRET, NOW + i);
    expect(m.sent[0]).toMatchObject({ channel: 'sms', to: n });
    await expect(
      askBrandCode(pool, m, { address: n, channel: 'sms', ip: '10.0.0.3' }, SECRET, NOW + 60),
    ).rejects.toThrow('Too many codes for this number: try again in 14 minutes');
    // Another connection still may (a stranger cannot lock someone out from elsewhere).
    const ok = lastCode(m, n);
    const failing = fakeMessages({ failFor: new Map([[n, { reason: 'down', retryable: true }]]) });
    await expect(
      askBrandCode(
        pool,
        failing,
        { address: n, channel: 'whatsapp', ip: '10.0.0.4' },
        SECRET,
        NOW + 61,
      ),
    ).rejects.toThrow('could not be sent on WhatsApp');
    // The last code that went still works.
    await checkBrandCode(pool, { address: n, code: ok, ip: '10.0.0.3' }, SECRET, NOW + 62);
  });

  it('a session ends on sign-out or when unused for the idle days', async () => {
    const m = fakeMessages();
    const n = '+919848033333';
    await askBrandCode(pool, m, { address: n, channel: 'whatsapp', ip: '10.0.0.5' }, SECRET, NOW);
    const s = await checkBrandCode(
      pool,
      { address: n, code: lastCode(m, n), ip: '10.0.0.5' },
      SECRET,
      NOW,
    );
    expect(await brandSession(pool, s.token, NOW + R.idleDays * 86_400 - 10)).toBeDefined();
    // Used just now (noted): the idle days count from then.
    const later = NOW + R.idleDays * 86_400 - 10;
    expect(await brandSession(pool, s.token, later + R.idleDays * 86_400 - 10)).toBeDefined();
    expect(await brandSession(pool, s.token, later + 2 * R.idleDays * 86_400)).toBeUndefined();

    await askBrandCode(
      pool,
      m,
      { address: n, channel: 'whatsapp', ip: '10.0.0.5' },
      SECRET,
      NOW + 100,
    );
    const t = await checkBrandCode(
      pool,
      { address: n, code: lastCode(m, n), ip: '10.0.0.5' },
      SECRET,
      NOW + 100,
    );
    const live = await brandSession(pool, t.token, NOW + 101);
    if (!live) throw new Error('no session');
    await endBrandSession(pool, live, { by: n, why: 'signed out' }, NOW + 102);
    await endBrandSession(pool, live, { by: n, why: 'signed out' }, NOW + 103);
    expect(await brandSession(pool, t.token, NOW + 104)).toBeUndefined();
    expect(await brandSession(pool, 'not a token', NOW)).toBeUndefined();
  });

  it('portal access: given, changed and removed by staff as versions; only active accounts count', async () => {
    await setPortalMember(
      pool,
      {
        brandId: 'chai-co',
        address: ASHA,
        role: 'owner',
        active: true,
        reason: 'owner of Chai Co',
        by: 'Sana',
      },
      NOW,
    );
    await setPortalMember(
      pool,
      {
        brandId: 'adwise',
        address: ASHA,
        role: 'booker',
        active: true,
        reason: 'books for them',
        by: 'Sana',
      },
      NOW,
    );
    expect(await portalAccounts(pool, ASHA)).toEqual([
      { brandId: 'adwise', name: 'Adwise Media', kind: 'agency', role: 'booker' },
      { brandId: 'chai-co', name: 'Chai Co', kind: 'brand', role: 'owner' },
    ]);
    await expect(
      setPortalMember(
        pool,
        {
          brandId: 'chai-co',
          address: ASHA,
          role: 'owner',
          active: true,
          reason: 'again',
          by: 'Sana',
        },
        NOW,
      ),
    ).rejects.toThrow('They already have this access');
    await expect(
      setPortalMember(
        pool,
        { brandId: 'nope', address: ASHA, role: 'owner', active: true, reason: 'typo', by: 'Sana' },
        NOW,
      ),
    ).rejects.toThrow('No such brand or agency');
    await expect(
      setPortalMember(
        pool,
        {
          brandId: 'chai-co',
          address: MEDIA,
          role: 'owner',
          active: false,
          reason: 'never had',
          by: 'Sana',
        },
        NOW,
      ),
    ).rejects.toThrow('no access to remove');

    // Removed: gone at once (checked each time), kept in the list and the audit log.
    expect(
      await setPortalMember(
        pool,
        {
          brandId: 'adwise',
          address: ASHA,
          role: 'booker',
          active: false,
          reason: 'left the agency',
          by: 'Sana',
        },
        NOW + 10,
      ),
    ).toBe(2);
    expect((await portalAccounts(pool, ASHA)).map((a) => a.brandId)).toEqual(['chai-co']);
    expect(await portalMembers(pool, 'adwise')).toMatchObject([
      { address: ASHA, role: 'booker', active: false, setBy: 'Sana', reason: 'left the agency' },
    ]);
    // A closed account no longer opens.
    const was = await findAccount(pool, 'chai-co');
    await reviseAccount(
      pool,
      {
        brandId: 'chai-co',
        baseVersion: was?.version ?? 0,
        details: { ...plain('Chai Co'), active: false },
        by: 'Sana',
        reason: 'closed',
      },
      NOW + 20,
    );
    expect(await portalAccounts(pool, ASHA)).toEqual([]);

    const audit = await pool.query<{ action: string; ref: string; detail: string }>(
      `SELECT action, ref, detail FROM audit_log WHERE area = 'brands' AND action LIKE 'portal%' ORDER BY at, action`,
    );
    expect(audit.rows).toContainEqual({
      action: 'portal access removed',
      ref: 'adwise',
      detail: `${ASHA} as booker: left the agency`,
    });
    const out = await pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'brand portal signed out'`,
    );
    expect(out.rowCount).toBeGreaterThan(0);
  });

  it('nothing is ever changed or removed', async () => {
    await expect(pool.query('DELETE FROM brand_codes')).rejects.toThrow();
    await expect(pool.query('UPDATE brand_members SET active = true')).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO brand_codes (address, channel, code_hash, ip, sent_at, expires_at) VALUES ('Media@X.in', 'email', repeat('a', 64), 'x', now(), now() + interval '1 minute')",
      ),
    ).rejects.toThrow();
  });
});
