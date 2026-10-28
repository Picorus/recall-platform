import { fakeDeviceCa } from '@recall/adapters';
import { certFingerprint, commandLog, issueCommand, revokeCertificate } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { helloText, parseCommand, uploadText, type Numbered } from '@recall/domain';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hookHandler, type HookConfig } from '../../src/hooks.js';
import { handleUp, LineMemory } from '../../src/line.js';
import { enrolBox, live, type TestBox } from '../box.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let box: TestBox;
let server: Server;
let url = '';
const NOW = Math.floor(Date.now() / 1000);
const CFG: HookConfig = {
  token: 'hook-token',
  gatewayUser: 'recall-gateway',
  gatewayPassword: 'gw-pass',
};
const bytes = (t: string) => new TextEncoder().encode(t);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  box = await enrolBox(pool, fakeDeviceCa(), 'GW-LINE-0001', NOW);
  server = createServer(hookHandler(pool, CFG));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

const hook = async (path: string, body: object, token = CFG.token) => {
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...((await r.json()) as { result: string; is_superuser?: boolean }) };
};

describe('gateway (P2.3.2): hellos and uploads', () => {
  it('a hello is answered with the time and recorded', async () => {
    const up = `recall/v1/s/${box.screenId}/up/hello`;
    const replies = await handleUp(pool, up, bytes(helloText('0.1.0', 4242)), NOW * 1000 + 5);
    expect(replies).toEqual([
      {
        topic: `recall/v1/s/${box.screenId}/down/time`,
        payload: `{"utcMs":${NOW * 1000 + 5},"echo":4242}`,
      },
    ]);
    const h = await pool.query('SELECT app FROM screen_hellos WHERE screen_id = $1', [
      box.screenId,
    ]);
    expect(h.rows).toEqual([{ app: '0.1.0' }]);
  });

  it('an upload is stored once and acked, however often it comes', async () => {
    const up = `recall/v1/s/${box.screenId}/up/upload`;
    const batch = [1, 2, 3].map((seq) => ({ seq, at: NOW, report: live(NOW + seq) }));
    const ack = { topic: `recall/v1/s/${box.screenId}/down/ack`, payload: '{"ack":3}' };
    expect(await handleUp(pool, up, bytes(uploadText(batch, 1)), NOW * 1000)).toEqual([ack]);
    expect(await handleUp(pool, up, bytes(uploadText(batch, 1)), NOW * 1000 + 1)).toEqual([ack]);
    const n = await pool.query(
      'SELECT count(*)::int AS n FROM screen_reports WHERE screen_id = $1',
      [box.screenId],
    );
    expect(n.rows[0]).toEqual({ n: 3 });
    // The box gave up 4–9 (too old) and sends 10: the cloud stops waiting for them.
    const later = [{ seq: 10, at: NOW, report: live(NOW + 10) }];
    expect(await handleUp(pool, up, bytes(uploadText(later, 10)), NOW * 1000 + 2)).toEqual([
      { ...ack, payload: '{"ack":10}' },
    ]);
  });

  it('an upload refused whole is recorded and not answered (the box keeps it)', async () => {
    const up = `recall/v1/s/${box.screenId}/up/upload`;
    expect(await handleUp(pool, up, bytes('{"v":9}'), NOW * 1000 + 3)).toEqual([]);
    // A screen we never enrolled cannot get here (the broker refuses it); if it did, nothing is kept.
    await expect(
      handleUp(pool, 'recall/v1/s/SCR-00000000/up/upload', bytes('{}'), NOW * 1000),
    ).rejects.toThrow();
    const r = await pool.query('SELECT kind, problem FROM screen_line_refusals');
    expect(r.rows).toEqual([{ kind: 'upload', problem: 'wrong fields' }]);
  });

  it('the hooks: the right token, a screen with its own certificate, the gateway with its password', async () => {
    const screen = {
      clientid: box.screenId,
      username: certFingerprint(box.certPem),
      password: '',
      cert_common_name: box.screenId,
    };
    expect(await hook('/emqx/authn', screen)).toMatchObject({
      status: 200,
      result: 'allow',
      is_superuser: false,
    });
    expect(await hook('/emqx/authn', screen, 'wrong')).toMatchObject({
      status: 403,
      result: 'deny',
    });
    // Same certificate fingerprint without TLS (no name from a certificate): refused.
    expect(await hook('/emqx/authn', { ...screen, cert_common_name: '' })).toMatchObject({
      result: 'deny',
    });
    const gw = {
      clientid: 'recall-gateway-1',
      username: 'recall-gateway',
      password: 'gw-pass',
      cert_common_name: '',
    };
    // Only the gateway, with its password, is the broker's superuser.
    expect(await hook('/emqx/authn', gw)).toMatchObject({ result: 'allow', is_superuser: true });
    expect(await hook('/emqx/authn', { ...gw, password: 'guess' })).toMatchObject({
      result: 'deny',
    });
    // The gateway's name over TLS (a certificate's name is set): not the gateway.
    expect(await hook('/emqx/authn', { ...gw, cert_common_name: box.screenId })).toMatchObject({
      result: 'deny',
    });
    expect(
      await hook('/emqx/authz', {
        clientid: box.screenId,
        username: screen.username,
        topic: `recall/v1/s/${box.screenId}/up/upload`,
        action: 'publish',
      }),
    ).toMatchObject({ result: 'allow' });
    expect(
      await hook('/emqx/authz', {
        clientid: box.screenId,
        username: screen.username,
        topic: 'recall/v1/s/#',
        action: 'subscribe',
      }),
    ).toMatchObject({ result: 'deny' });
    const bad = await fetch(`${url}/emqx/authn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CFG.token}` },
      body: 'not json',
    });
    expect(await bad.json()).toEqual({ result: 'deny' });
  });

  it('a hello or refusal is recorded at most once a minute per box; the time is always sent', async () => {
    const other = await enrolBox(pool, fakeDeviceCa(), 'GW-LINE-0002', NOW);
    const memory = new LineMemory();
    const up = `recall/v1/s/${other.screenId}/up/hello`;
    for (let i = 0; i < 50; i++) {
      const r = await handleUp(pool, up, bytes(helloText('0.1.0', i)), NOW * 1000 + i, memory);
      expect(r).toHaveLength(1);
      await handleUp(
        pool,
        `recall/v1/s/${other.screenId}/up/upload`,
        bytes('{}'),
        NOW * 1000 + i,
        memory,
      );
    }
    await handleUp(pool, up, bytes(helloText('0.1.0', 99)), NOW * 1000 + 60_000, memory);
    const n = await pool.query<{ h: number; r: number }>(
      `SELECT (SELECT count(*)::int FROM screen_hellos WHERE screen_id = $1) AS h,
              (SELECT count(*)::int FROM screen_line_refusals WHERE screen_id = $1) AS r`,
      [other.screenId],
    );
    expect(n.rows[0]).toEqual({ h: 2, r: 1 });
  });

  it('every message is checked again: a box revoked while connected loses its topics', async () => {
    const third = await enrolBox(pool, fakeDeviceCa(), 'GW-LINE-0003', NOW);
    const ask = {
      clientid: third.screenId,
      username: certFingerprint(third.certPem),
      topic: `recall/v1/s/${third.screenId}/up/upload`,
      action: 'publish',
    };
    expect(await hook('/emqx/authz', ask)).toMatchObject({ result: 'allow' });
    await revokeCertificate(pool, third.certSerial, 'box reported stolen', 'ops-1', NOW);
    expect(await hook('/emqx/authz', ask)).toMatchObject({ result: 'deny' });
  });

  it('of blank and unblank only the newest goes: an old blank never undoes a newer unblank', async () => {
    const fifth = await enrolBox(pool, fakeDeviceCa(), 'GW-LINE-0005', NOW);
    const at = NOW * 1000 + 200_000;
    const blank = await issueCommand(pool, {
      screenId: fifth.screenId,
      command: 'blank',
      value: null,
      by: 'ops-1',
      reason: 'cracked panel',
      nowMs: at,
      lifeMs: 3_600_000,
    });
    const unblank = await issueCommand(pool, {
      screenId: fifth.screenId,
      command: 'unblank',
      value: null,
      by: 'ops-1',
      reason: 'panel replaced',
      nowMs: at + 600_000,
    });
    const logs = await issueCommand(pool, {
      screenId: fifth.screenId,
      command: 'send-logs',
      value: null,
      by: 'ops-1',
      reason: 'check crashes',
      nowMs: at + 600_001,
    });
    const hello = `recall/v1/s/${fifth.screenId}/up/hello`;
    const sent = (await handleUp(pool, hello, bytes(helloText('0.9.0', 1)), at + 700_000))
      .filter((r) => r.topic.endsWith('/down/command'))
      .map((r) => r.payload);
    expect(sent).toEqual([unblank.text, logs.text]);
    expect(sent).not.toContain(blank.text);
    expect(JSON.parse(unblank.text)).toMatchObject({ screen: fifth.screenId });
  });

  it('a command goes with every hello until the box answers it, and the answer is logged (P2.12)', async () => {
    const fourth = await enrolBox(pool, fakeDeviceCa(), 'GW-LINE-0004', NOW);
    const at = NOW * 1000 + 100_000;
    const issued = await issueCommand(pool, {
      screenId: fourth.screenId,
      command: 'blank',
      value: null,
      by: 'ops-1',
      reason: 'rider reports a cracked panel',
      nowMs: at,
    });
    const hello = `recall/v1/s/${fourth.screenId}/up/hello`;
    const sentWith = async (ms: number) =>
      (await handleUp(pool, hello, bytes(helloText('0.9.0', 1)), ms))
        .filter((r) => r.topic.endsWith('/down/command'))
        .map((r) => r.payload);
    expect(await sentWith(at + 1_000)).toEqual([issued.text]);
    expect(await sentWith(at + 2_000)).toEqual([issued.text]); // again, until answered
    const c = parseCommand(issued.text);
    expect('problem' in c).toBe(false);
    expect((await commandLog(pool, fourth.screenId, at + 2_000))[0]?.state).toBe('waiting');
    // The box answers through its outbox.
    const answer: Numbered = {
      seq: 1,
      at: NOW + 103,
      report: { kind: 'command', id: issued.id, at: NOW + 103, result: 'done', note: '' },
    };
    await handleUp(
      pool,
      `recall/v1/s/${fourth.screenId}/up/upload`,
      bytes(uploadText([answer], 1)),
      at + 3_000,
    );
    expect(await sentWith(at + 4_000)).toEqual([]);
    const log = await commandLog(pool, fourth.screenId, at + 4_000);
    expect(log).toMatchObject([{ command: 'blank', by: 'ops-1', state: 'done' }]);
    // A command never answered expires: it is not sent again, and the log says so.
    await issueCommand(pool, {
      screenId: fourth.screenId,
      command: 'reboot',
      value: null,
      by: 'ops-1',
      reason: 'frozen screen',
      nowMs: at,
      lifeMs: 60_000,
    });
    expect(await sentWith(at + 61_000)).toEqual([]);
    expect(
      (await commandLog(pool, fourth.screenId, at + 61_000)).map((l) => l.state).sort(),
    ).toEqual(['done', 'expired']);
  });
});

describe('P7.8: the POC months go to every box with its hello', () => {
  it('once the POC is switched on, a hello also brings its plan on down/poc', async () => {
    const { setBusinessMode } = await import('@recall/db');
    const { parsePocPlans } = await import('@recall/domain');
    const at = (NOW + 600) * 1000;
    const hello = () =>
      handleUp(pool, `recall/v1/s/${box.screenId}/up/hello`, bytes(helloText('0.1.0', 1)), at);
    expect((await hello()).some((r) => r.topic.endsWith('/down/poc'))).toBe(false);
    const from = await setBusinessMode(
      pool,
      'poc',
      { id: 'prateek', role: 'super-admin' },
      'POC scheduled',
      NOW,
    );
    // Made at most once a minute: a minute later it is there.
    const replies = await handleUp(
      pool,
      `recall/v1/s/${box.screenId}/up/hello`,
      bytes(helloText('0.1.0', 2)),
      at + 60_000,
    );
    const poc = replies.find((r) => r.topic === `recall/v1/s/${box.screenId}/down/poc`);
    const plans = parsePocPlans(poc?.payload ?? '');
    expect('plans' in plans && plans.plans.map((p) => [p.startsAt, p.brands.length])).toEqual([
      [from, 0],
    ]);
  });
});
