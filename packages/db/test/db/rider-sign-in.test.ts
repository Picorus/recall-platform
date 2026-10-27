// P4.1: rider sign-in: a code per ask (few per number, per day, per connection), sent on WhatsApp
// or by SMS in his language, kept only as a fingerprint; right once, within its minutes and tries;
// only the newest code counts; a session until signed out or idle; every try kept.
import { fakeMessages } from '@recall/adapters';
import { DEFAULT_RIDER_SIGN_IN as R } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  askRiderCode,
  checkRiderCode,
  endRiderSession,
  riderSession,
} from '../../src/rider-sign-in.js';
import { createRider, reviseRider } from '../../src/riders.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SECRET = Buffer.alloc(32, 7);
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const RAVI = '+919848012345';

/** The code in the last message sent to a number. */
const lastCode = (m: ReturnType<typeof fakeMessages>, to: string) => {
  const x = [...m.sent].reverse().find((s) => s.to === to);
  if (!x) return '';
  return x.channel === 'whatsapp'
    ? (x.params[0] ?? '')
    : x.channel === 'sms'
      ? x.text.slice(0, 6)
      : '';
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone: RAVI, bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    NOW - 86_400,
  );
}, 60_000);
afterAll(async () => db.drop());

describe('rider sign-in (P4.1)', () => {
  it('a code on WhatsApp in his language; right once; his rider record found; nothing stored in clear', async () => {
    const m = fakeMessages();
    const ask = {
      phone: RAVI,
      channel: 'whatsapp' as const,
      ip: '10.0.0.1',
      language: 'te' as const,
    };
    expect(await askRiderCode(pool, m, ask, SECRET, NOW)).toEqual({
      expiresAt: NOW + R.codeSeconds,
    });
    expect(m.sent).toMatchObject([
      { channel: 'whatsapp', to: RAVI, template: 'sign_in_code', language: 'te' },
    ]);
    const code = lastCode(m, RAVI);
    expect(code).toMatch(/^\d{6}$/);
    const stored = await pool.query('SELECT code_hash FROM rider_codes');
    expect(JSON.stringify(stored.rows)).not.toContain(code);
    const s = await checkRiderCode(pool, { phone: RAVI, code, ip: '10.0.0.1' }, SECRET, NOW + 30);
    expect(s.riderId).toMatch(/^RD-/);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      (await pool.query('SELECT token_hash FROM rider_sessions')).rows[0]?.token_hash,
    ).not.toBe(s.token);
    // The same code again: used.
    await expect(
      checkRiderCode(pool, { phone: RAVI, code, ip: '10.0.0.1' }, SECRET, NOW + 40),
    ).rejects.toThrow('no longer works');
    expect(await riderSession(pool, s.token, NOW + 60)).toMatchObject({
      phone: RAVI,
      riderId: s.riderId,
    });
  });

  it('wrong codes count down, then the code is dead; an old code dies when a new one is sent', async () => {
    const m = fakeMessages();
    const phone = '+919000011111';
    const ask = { phone, channel: 'sms' as const, ip: '10.0.0.2', language: 'hi' as const };
    await askRiderCode(pool, m, ask, SECRET, NOW);
    expect(m.sent[0]).toMatchObject({ channel: 'sms', to: phone });
    expect(m.sent[0]?.channel === 'sms' && m.sent[0].text).toContain('मिनट');
    const code = lastCode(m, phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const typed = { phone, code: wrong, ip: '10.0.0.2' };
    await expect(checkRiderCode(pool, typed, SECRET, NOW + 1)).rejects.toThrow('4 tries left');
    for (let i = 0; i < 3; i++) await checkRiderCode(pool, typed, SECRET, NOW + 2).catch(() => {});
    await expect(checkRiderCode(pool, typed, SECRET, NOW + 3)).rejects.toThrow('ask for a new one');
    // Even the right one: the code has had its tries.
    await expect(checkRiderCode(pool, { ...typed, code }, SECRET, NOW + 4)).rejects.toThrow(
      'no longer works',
    );
    // A new code; the one before it no longer counts.
    await askRiderCode(pool, m, ask, SECRET, NOW + 60);
    await askRiderCode(pool, m, ask, SECRET, NOW + 70);
    const newest = lastCode(m, phone);
    const older =
      m.sent.at(-2)?.channel === 'sms' ? (m.sent.at(-2) as { text: string }).text.slice(0, 6) : '';
    if (older !== newest)
      await expect(
        checkRiderCode(pool, { ...typed, code: older }, SECRET, NOW + 80),
      ).rejects.toThrow('Wrong code');
    const s = await checkRiderCode(pool, { ...typed, code: newest }, SECRET, NOW + 90);
    // A number with no rider yet: he signs up next.
    expect(s.riderId).toBeNull();
    // Every try is kept.
    const tries = await pool.query('SELECT ok FROM rider_code_tries WHERE phone = $1', [phone]);
    expect(tries.rows.filter((t) => t.ok)).toHaveLength(1);
    expect(tries.rows.length).toBeGreaterThanOrEqual(6);
  });

  it('a code runs out after its minutes', async () => {
    const m = fakeMessages();
    const phone = '+919000022222';
    await askRiderCode(
      pool,
      m,
      { phone, channel: 'whatsapp', ip: '10.0.0.3', language: 'en' },
      SECRET,
      NOW,
    );
    await expect(
      checkRiderCode(
        pool,
        { phone, code: lastCode(m, phone), ip: '10.0.0.3' },
        SECRET,
        NOW + R.codeSeconds,
      ),
    ).rejects.toThrow('no longer works');
  });

  it('few codes per number from one connection, and per day; few per connection; a brake for all', async () => {
    const m = fakeMessages();
    const phone = '+919000033333';
    const ask = { phone, channel: 'whatsapp' as const, ip: '10.0.0.4', language: 'en' as const };
    for (let i = 0; i < R.codesPer15Min; i++) await askRiderCode(pool, m, ask, SECRET, NOW + i);
    await expect(askRiderCode(pool, m, ask, SECRET, NOW + 10)).rejects.toThrow(
      'try again in 15 minutes',
    );
    // Someone else asking for his codes elsewhere does not stop his own.
    await askRiderCode(pool, m, { ...ask, ip: '10.0.0.44' }, SECRET, NOW + 11);
    // No more than the day's, from anywhere.
    let t = NOW + 900;
    for (let i = R.codesPer15Min + 1; i < R.codesPerDay; i++) {
      await askRiderCode(pool, m, { ...ask, ip: `10.1.0.${i}` }, SECRET, t);
      t += 60;
    }
    await expect(askRiderCode(pool, m, { ...ask, ip: '10.1.1.1' }, SECRET, t + 60)).rejects.toThrow(
      'tomorrow',
    );
    // One connection asking for many numbers.
    const ip = '10.9.9.9';
    for (let i = 0; i < R.codesPerAddressHour; i++)
      await askRiderCode(
        pool,
        m,
        { ...ask, phone: `+91910000${String(i).padStart(4, '0')}`, ip },
        SECRET,
        NOW + i,
      );
    await expect(
      askRiderCode(pool, m, { ...ask, phone: '+919199999999', ip }, SECRET, NOW + 100),
    ).rejects.toThrow('this connection');
    // A brake on everyone's codes together (message costs).
    const all = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM rider_codes WHERE sent_at > to_timestamp($1) - interval '1 hour'`,
      [NOW + 200],
    );
    await expect(
      askRiderCode(pool, m, { ...ask, phone: '+919188888888', ip: '10.8.8.8' }, SECRET, NOW + 200, {
        ...R,
        codesPerHourAll: Number(all.rows[0]?.n),
      }),
    ).rejects.toThrow('busy');
  });

  it('wrong codes for one number are capped for the day, across connections', async () => {
    const m = fakeMessages();
    const phone = '+919000066666';
    const rules = { ...R, wrongPerNumberDay: 6 };
    let ip = 0;
    const wrongTwice = async (t: number) => {
      ip += 1;
      await askRiderCode(
        pool,
        m,
        { phone, channel: 'sms', ip: `10.6.0.${ip}`, language: 'en' },
        SECRET,
        t,
        rules,
      );
      const code = lastCode(m, phone);
      const bad = code === '000000' ? '111111' : '000000';
      for (let k = 0; k < 2; k++)
        await checkRiderCode(
          pool,
          { phone, code: bad, ip: `10.6.0.${ip}` },
          SECRET,
          t + 1,
          rules,
        ).catch(() => {});
      return code;
    };
    await wrongTwice(NOW);
    await wrongTwice(NOW + 60);
    const code = await wrongTwice(NOW + 120);
    await expect(
      checkRiderCode(pool, { phone, code, ip: '10.6.1.1' }, SECRET, NOW + 130, rules),
    ).rejects.toThrow('wrong codes for this number today');
  });

  it('a session belongs to the rider who signed in: a number changed or given to someone else ends it', async () => {
    const m = fakeMessages();
    const phone = '+919000077777';
    const a = await createRider(
      pool,
      {
        details: { name: 'Anil Rao', phone, bikePlate: null, rides: '', apps: [] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      NOW - 3600,
    );
    await askRiderCode(
      pool,
      m,
      { phone, channel: 'whatsapp', ip: '10.7.0.1', language: 'en' },
      SECRET,
      NOW,
    );
    const s = await checkRiderCode(
      pool,
      { phone, code: lastCode(m, phone), ip: '10.7.0.1' },
      SECRET,
      NOW,
    );
    expect(s.riderId).toBe(a);
    // His number changes (a new SIM): the old phone's session no longer opens his account.
    await reviseRider(
      pool,
      a,
      { name: 'Anil Rao', phone: '+919000077778', bikePlate: null, rides: '', apps: [] },
      'Omar',
      'new SIM',
      NOW + 60,
    );
    expect(await riderSession(pool, s.token, NOW + 120)).toBeUndefined();
    // The old number goes to a new rider: he signs in as himself.
    const b = await createRider(
      pool,
      {
        details: { name: 'Bala K', phone, bikePlate: null, rides: '', apps: [] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      NOW + 200,
    );
    await askRiderCode(
      pool,
      m,
      { phone, channel: 'whatsapp', ip: '10.7.0.2', language: 'en' },
      SECRET,
      NOW + 300,
    );
    const t = await checkRiderCode(
      pool,
      { phone, code: lastCode(m, phone), ip: '10.7.0.2' },
      SECRET,
      NOW + 300,
    );
    expect(t.riderId).toBe(b);
    expect((await riderSession(pool, t.token, NOW + 301))?.riderId).toBe(b);
  });

  it('a code that failed to go never replaces one that did; a provider that never answers is a failure', async () => {
    const phone = '+919000088888';
    const ok = fakeMessages();
    await askRiderCode(
      pool,
      ok,
      { phone, channel: 'whatsapp', ip: '10.8.0.1', language: 'en' },
      SECRET,
      NOW,
    );
    const silent = { send: () => new Promise<never>(() => undefined) };
    await expect(
      askRiderCode(
        pool,
        silent,
        { phone, channel: 'sms', ip: '10.8.0.1', language: 'en' },
        SECRET,
        NOW + 20,
      ),
    ).rejects.toThrow('could not be sent by SMS');
    const s = await checkRiderCode(
      pool,
      { phone, code: lastCode(ok, phone), ip: '10.8.0.1' },
      SECRET,
      NOW + 30,
    );
    expect(s.token).toBeTruthy();
  }, 20_000);

  it('a code that could not be sent says so; the next ask works', async () => {
    const phone = '+919000044444';
    const m = fakeMessages({
      failFor: new Map([[phone, { reason: 'not on WhatsApp', retryable: false }]]),
    });
    await expect(
      askRiderCode(
        pool,
        m,
        { phone, channel: 'whatsapp', ip: '10.0.0.5', language: 'en' },
        SECRET,
        NOW,
      ),
    ).rejects.toThrow('try SMS');
    const sends = await pool.query(
      `SELECT s.status FROM rider_code_sends s JOIN rider_codes k USING (code_id) WHERE k.phone = $1`,
      [phone],
    );
    expect(sends.rows).toEqual([{ status: 'failed' }]);
  });

  it('a session ends when he signs out, or after the idle days; nothing is edited', async () => {
    const m = fakeMessages();
    const phone = '+919000055555';
    await askRiderCode(
      pool,
      m,
      { phone, channel: 'whatsapp', ip: '10.0.0.6', language: 'en' },
      SECRET,
      NOW,
    );
    const a = await checkRiderCode(
      pool,
      { phone, code: lastCode(m, phone), ip: '10.0.0.6' },
      SECRET,
      NOW,
    );
    // Used 80 days on: still open, and that use is noted, so 80 more days are fine too.
    expect(await riderSession(pool, a.token, NOW + 80 * 86_400)).toBeDefined();
    expect(await riderSession(pool, a.token, NOW + 160 * 86_400)).toBeDefined();
    expect(await riderSession(pool, a.token, NOW + 251 * 86_400)).toBeUndefined();
    await askRiderCode(
      pool,
      m,
      { phone, channel: 'whatsapp', ip: '10.0.0.6', language: 'en' },
      SECRET,
      NOW + 1000,
    );
    const b = await checkRiderCode(
      pool,
      { phone, code: lastCode(m, phone), ip: '10.0.0.6' },
      SECRET,
      NOW + 1000,
    );
    const s = await riderSession(pool, b.token, NOW + 1001);
    await endRiderSession(
      pool,
      s?.tokenHash ?? '',
      { by: 'rider', why: 'signed out', riderId: null },
      NOW + 1002,
    );
    await endRiderSession(
      pool,
      s?.tokenHash ?? '',
      { by: 'rider', why: 'again', riderId: null },
      NOW + 1003,
    );
    expect(await riderSession(pool, b.token, NOW + 1004)).toBeUndefined();
    expect(await riderSession(pool, 'not-a-token', NOW)).toBeUndefined();
    await expect(pool.query('UPDATE rider_codes SET channel = $1', ['sms'])).rejects.toThrow();
    await expect(pool.query('DELETE FROM rider_session_ends')).rejects.toThrow();
  });
});
