import { fakeDeviceCa } from '@recall/adapters';
import { certFingerprint } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { helloText, uploadText } from '@recall/domain';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hookHandler, type HookConfig } from '../../src/hooks.js';
import { handleUp } from '../../src/line.js';
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
  return { status: r.status, ...((await r.json()) as { result: string }) };
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
    expect(await hook('/emqx/authn', screen)).toMatchObject({ status: 200, result: 'allow' });
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
    expect(await hook('/emqx/authn', gw)).toMatchObject({ result: 'allow' });
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
});
