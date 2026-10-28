// P3.15: support: messages coming in join the person's conversation (kept once), matched to the rider
// or brand they came from; staff start one for a call, reply (sent once each), add notes, pick it up
// and close it; a closed conversation opens again when they write; the inbox puts the longest
// waiting first.
import { fakeMessages } from '@recall/adapters';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBrandContact } from '../../src/report-sends.js';
import { createRider } from '../../src/riders.js';
import {
  noteThread,
  openThread,
  receiveMessage,
  replyThread,
  stepThread,
  supportInbox,
  supportThread,
} from '../../src/support.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const SUNITA = { id: 'STF-00000000000a', name: 'Sunita' };
let rider = '';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  rider = await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone: '+919848012345', bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Sunita',
      reason: 'walk-in',
    },
    NOW,
  );
  await setBrandContact(pool, 'chai-co', { email: 'ops@chai.example.in' }, 'Sana');
}, 60_000);
afterAll(async () => db.drop());

describe('support (P3.15)', () => {
  it('a message coming in is matched to the rider, kept once, and waits for us', async () => {
    const m = {
      channel: 'whatsapp' as const,
      providerId: 'wamid.1',
      from: '+919848012345',
      text: 'My screen is off since morning',
      at: NOW,
    };
    const a = await receiveMessage(pool, m, NOW);
    expect(a.isNew).toBe(true);
    expect(await receiveMessage(pool, m, NOW + 5)).toEqual({ threadId: a.threadId, isNew: false });
    await receiveMessage(pool, { ...m, providerId: 'wamid.2', text: 'Please call' }, NOW + 60);
    const [row] = await supportInbox(pool);
    expect(row).toMatchObject({
      threadId: a.threadId,
      channel: 'whatsapp',
      party: { kind: 'rider', id: rider, name: 'Ravi Kumar' },
      subject: 'My screen is off since morning',
      state: 'open',
      owner: null,
      lastText: 'Please call',
      waitingSince: NOW,
    });
  });

  it('an email from a brand contact; a staff reply goes once and stops the wait', async () => {
    const b = await receiveMessage(
      pool,
      {
        channel: 'email',
        providerId: 'mail-1',
        from: 'OPS@chai.example.in',
        subject: 'Invoice for August',
        text: 'Can you resend our invoice?',
        at: NOW + 120,
      },
      NOW + 120,
    );
    const messages = fakeMessages();
    expect(
      await replyThread(pool, messages, b.threadId, 'Sent again just now.', SUNITA, NOW + 300),
    ).toBe('sent');
    expect(messages.sent).toMatchObject([
      { channel: 'email', to: 'ops@chai.example.in', subject: 'Re: Invoice for August' },
    ]);
    const page = await supportThread(pool, b.threadId);
    expect(page).toMatchObject({
      party: { kind: 'brand', id: 'chai-co' },
      waitingSince: null,
    });
    expect(page?.timeline.map((e) => [e.kind, e.by])).toEqual([
      ['step', 'inbound'],
      ['in', 'ops@chai.example.in'],
      ['out', 'STF-00000000000a'],
    ]);
    // Two replies at the same moment: each its own message (its own key), both sent.
    const both = await Promise.all([
      replyThread(pool, messages, b.threadId, 'First', SUNITA, NOW + 310),
      replyThread(pool, messages, b.threadId, 'Second', SUNITA, NOW + 310),
    ]);
    expect(both).toEqual(['sent', 'sent']);
    expect(new Set(messages.sent.map((m) => m.key)).size).toBe(3);
    // A reply whose answer never came stays "not confirmed", never shown as sent.
    const silent = { send: () => new Promise<never>(() => undefined) };
    void replyThread(pool, silent, b.threadId, 'Lost', SUNITA, NOW + 320);
    await new Promise((ok) => setTimeout(ok, 200));
    const lost = (await supportThread(pool, b.threadId))?.timeline.at(-1);
    expect(lost).toMatchObject({ kind: 'out', status: 'sending' });
    expect(lost?.text).toMatch(/not confirmed/);
    // The rider's conversation still waits: it comes first.
    expect((await supportInbox(pool)).map((r) => r.party?.kind)).toEqual(['rider', 'brand']);
  });

  it('picked up, a note, done; writing again opens it again', async () => {
    const [row] = await supportInbox(pool, { party: { kind: 'rider', id: rider } });
    const id = row?.threadId ?? '';
    await stepThread(
      pool,
      id,
      { state: 'open', owner: SUNITA.id, reason: 'I will call him' },
      SUNITA,
      NOW + 400,
    );
    await expect(
      stepThread(pool, id, { state: 'open', owner: SUNITA.id, reason: 'again' }, SUNITA, NOW + 401),
    ).rejects.toThrow('Nothing changes');
    await noteThread(pool, id, 'Called: loose cable, fixed at the warehouse.', SUNITA, NOW + 500);
    await stepThread(
      pool,
      id,
      { state: 'done', owner: SUNITA.id, reason: 'fixed' },
      SUNITA,
      NOW + 600,
    );
    expect(await supportInbox(pool, { party: { kind: 'rider', id: rider } })).toEqual([]);
    expect(await supportInbox(pool, { state: 'done' })).toHaveLength(1);
    await receiveMessage(
      pool,
      {
        channel: 'whatsapp',
        providerId: 'wamid.3',
        from: '+919848012345',
        text: 'Off again',
        at: NOW + 900,
      },
      NOW + 900,
    );
    const again = await supportThread(pool, id);
    expect(again).toMatchObject({ state: 'open', owner: SUNITA.id, waitingSince: NOW });
    expect(again?.timeline.at(-2)).toMatchObject({
      kind: 'step',
      text: 'open · with STF-00000000000a: they wrote again',
    });
  });

  it('staff start one for a call; no reply on a call; nothing is edited', async () => {
    const id = await openThread(
      pool,
      {
        channel: 'phone',
        // Typed with stray spaces and no +91: kept as +91 and 10 digits.
        contact: ' 90000 11111 ',
        subject: 'Wants to join as a rider',
        note: 'Asked about pay; told him ₹2,000 a month in the POC.',
      },
      SUNITA,
      NOW + 1000,
    );
    expect((await supportThread(pool, id))?.party).toBeNull();
    expect(
      (await pool.query('SELECT contact FROM support_threads WHERE thread_id = $1', [id])).rows,
    ).toEqual([{ contact: '+919000011111' }]);
    const mail = await openThread(
      pool,
      {
        channel: 'email',
        contact: ' Ops@Chai.in ',
        subject: 'Invoice copy',
        note: 'Wants a copy',
      },
      SUNITA,
      NOW + 1000,
    );
    expect(
      (await pool.query('SELECT contact FROM support_threads WHERE thread_id = $1', [mail])).rows,
    ).toEqual([{ contact: 'ops@chai.in' }]);
    await expect(replyThread(pool, fakeMessages(), id, 'Hi', SUNITA, NOW + 1001)).rejects.toThrow(
      'call or a visit',
    );
    await expect(
      openThread(
        pool,
        { channel: 'whatsapp', contact: 'x@y.in', subject: 'Hello', note: 'Hello' },
        SUNITA,
        NOW,
      ),
    ).rejects.toThrow('mobile number');
    await expect(pool.query('UPDATE support_messages SET body = $1', ['x'])).rejects.toThrow();
  });
});
