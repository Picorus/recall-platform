// P3.11.1: rider routes: Operations and Support look; an Operations admin adds riders, changes them,
// checks their documents and moves their steps; Support adds notes.
import { fakeBankCheck, fakeEsign, fakeFileStore, fakeKyc } from '@recall/adapters';
import { freshDatabase } from '@recall/db/test-db';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';
import { members } from './members.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const now = Date.UTC(2027, 5, 1, 6, 30);
const ORIGIN = 'https://admin.test';
const files = fakeFileStore({ baseUrl: 'https://admin.test/api/files', secret: 'test' });
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
  files,
  riderChecks: {
    kyc: fakeKyc({ auto: true }),
    esign: fakeEsign({ auto: true, clock: () => Math.floor(now / 1000) }),
    bank: fakeBankCheck(),
  },
};
const member = members(() => pool, now);
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../packages/domain/test/fixtures/ads/${name}`, import.meta.url));

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

describe('rider routes (P3.11.1)', () => {
  it('add, look, documents, approve, notes; who may do what', async () => {
    const omar = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const sara = await member('sara@recall.in', { role: 'admin', areas: ['support'] });
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const post = async (cookie: string, path: string, body: object) => {
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const ravi = {
      name: 'Ravi Kumar',
      phone: '98480 12345',
      bikePlate: 'ts 09 ea 1234',
      rides: 'Madhapur',
      apps: ['swiggy'],
      reason: 'walk-in',
    };
    expect((await post(sara, '/riders', ravi)).status).toBe(403);
    expect(await post(omar, '/riders', ravi)).toEqual({
      status: 200,
      body: { riderId: 'RD-000001' },
    });
    expect((await post(omar, '/riders', ravi)).body.error).toBe(
      'This phone is already rider RD-000001',
    );
    expect((await fetch(`${url}/riders`, { headers: { cookie: sana } })).status).toBe(403);
    const list = (await (
      await fetch(`${url}/riders?q=ravi`, { headers: { cookie: sara } })
    ).json()) as {
      riders: { riderId: string; phone: string; bikePlate: string }[];
    };
    expect(list.riders).toMatchObject([
      { riderId: 'RD-000001', phone: '+919848012345', bikePlate: 'TS09EA1234' },
    ]);

    // Documents: uploaded as the body, previews through signed links, looked at once.
    const upload = async (kind: string, name: string) => {
      const r = await fetch(`${url}/riders/RD-000001/documents?kind=${kind}`, {
        method: 'POST',
        headers: { cookie: omar, origin: ORIGIN, 'content-type': 'application/octet-stream' },
        body: fixture(name),
      });
      return (await r.json()) as { document: { docId: string; preview: string } };
    };
    const docs = [
      await upload('photo', 'ad-1280x640.jpg'),
      await upload('rc', 'ad-1280x640.png'),
      await upload('insurance', 'ad-1280x640.webp'),
    ];
    expect(docs[0]?.document.preview).toContain('https://admin.test/api/files/');
    for (const d of docs)
      expect(
        (
          await post(omar, `/riders/RD-000001/documents/${d.document.docId}/review`, {
            decision: 'accepted',
            reason: 'checked against the original',
            expiresOn: '2028-03-31',
          })
        ).status,
      ).toBe(200);
    // Identity, agreement and bank (the fakes pass at once, as on a laptop).
    expect((await post(sara, '/riders/RD-000001/identity', {})).status).toBe(403);
    expect((await post(omar, '/riders/RD-000001/identity', {})).body.link).toMatch(
      /^https:\/\/kyc\.example\/kyc_/,
    );
    expect((await post(omar, '/riders/RD-000001/agreement', {})).status).toBe(200);
    expect(
      (
        await post(omar, '/riders/RD-000001/bank', {
          kind: 'bank',
          accountNumber: '1234 5678 9012',
          ifsc: 'hdfc0001234',
          name: 'Ravi Kumar',
        })
      ).body,
    ).toEqual({ outcome: 'passed', reason: null, nameAtBank: 'RAVI KUMAR' });
    expect(
      await post(omar, '/riders/RD-000001/step', { to: 'approved', reason: 'all checked' }),
    ).toEqual({ status: 200, body: { status: 'approved' } });
    expect(
      (await post(omar, '/riders/RD-000001/step', { to: 'active', reason: 'riding now' })).body
        .error,
    ).toBe('fit a screen to his bike first (Screens)');
    expect(
      (await post(sara, '/riders/RD-000001/notes', { note: 'Called: fitting on Monday' })).status,
    ).toBe(200);
    const page = (await (
      await fetch(`${url}/riders/RD-000001`, { headers: { cookie: sara } })
    ).json()) as {
      rider: { status: string };
      checklist: { done: boolean }[];
      timeline: { text: string }[];
      documents: { preview: string | null; fileKey?: string }[];
      payoutAccount: string;
    };
    expect(page.rider.status).toBe('approved');
    // Support sees no document previews and no file fingerprints; the account masked.
    expect(page.documents.every((d) => d.preview === null && d.fileKey === undefined)).toBe(true);
    expect(page.payoutAccount).toBe('Bank ••••9012 · HDFC0001234 · Ravi Kumar');
    // A read-only member sees phones masked.
    const ro = await member('rita@recall.in', { role: 'read-only', areas: ['operations'] });
    const seen = (await (await fetch(`${url}/riders`, { headers: { cookie: ro } })).json()) as {
      riders: { phone: string }[];
    };
    expect(seen.riders[0]?.phone).toBe('+91 98480 •••45');
    // An upload for a document kind that does not exist is refused before the file is read.
    const bad = await fetch(`${url}/riders/RD-000001/documents?kind=passport`, {
      method: 'POST',
      headers: { cookie: omar, origin: ORIGIN, 'content-type': 'application/octet-stream' },
      body: fixture('ad-1280x640.jpg'),
    });
    expect(bad.status).toBe(400);
    expect(page.checklist.every((c) => c.done)).toBe(true);
    expect(page.timeline.map((t) => t.text)).toContain('Note: Called: fitting on Monday');
    expect((await fetch(`${url}/riders/RD-999999`, { headers: { cookie: sara } })).status).toBe(
      404,
    );
  });
});
