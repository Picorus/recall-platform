// P2.3.2 end to end: a real EMQX broker (Docker) with the production settings, the gateway, and
// boxes connecting over TLS with the certificates the warehouse gave them. Needs Docker and the
// laptop database: pnpm --filter @recall/gateway test:emqx
import { fakeDeviceCa } from '@recall/adapters';
import { revokeCertificate } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { helloText, uploadText } from '@recall/domain';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mqtt from 'mqtt';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderEmqxConfig } from '../../src/emqx-config.js';
import { startGateway, type RunningGateway } from '../../src/gateway.js';
import { enrolBox, live, type TestBox } from '../box.js';
import { brokerCertificate } from './pki.js';

const SSL_PORT = Number(process.env.EMQX_TEST_SSL_PORT ?? 28883);
const TCP_PORT = Number(process.env.EMQX_TEST_TCP_PORT ?? 21883);
const NAME = `recall-emqx-test-${randomBytes(4).toString('hex')}`;
const NOW = Math.floor(Date.now() / 1000);
const GW = { gatewayUser: 'recall-gateway', gatewayPassword: randomBytes(16).toString('hex') };
const TOKEN = randomBytes(16).toString('hex');

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let gateway: RunningGateway;
let brokerCa = '';
let a: TestBox;
let b: TestBox;
let c: TestBox;
const clients: mqtt.MqttClient[] = [];

const portOpen = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = createConnection({ port, host: '127.0.0.1' }, () => {
      s.end();
      ok(true);
    });
    s.on('error', () => ok(false));
  });

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  const ca = fakeDeviceCa();
  [a, b, c] = [
    await enrolBox(pool, ca, 'E2E-BOX-000A', NOW),
    await enrolBox(pool, ca, 'E2E-BOX-000B', NOW),
    await enrolBox(pool, ca, 'E2E-BOX-000C', NOW),
  ];
  gateway = await startGateway(
    pool,
    {
      ...GW,
      token: TOKEN,
      mqttUrl: `mqtt://127.0.0.1:${TCP_PORT}`,
      hookHost: '127.0.0.1',
      hookPort: 0,
    },
    (l) => {
      if (process.env.EMQX_TEST_LOG) console.log(l);
    },
  );
  // The broker's files: who it trusts for screens (our screen authority), its own certificate.
  const dir = mkdtempSync(join(tmpdir(), 'recall-emqx-'));
  const broker = await brokerCertificate();
  brokerCa = broker.caPem;
  writeFileSync(join(dir, 'screens-ca.pem'), a.caCertPem);
  writeFileSync(join(dir, 'server.pem'), broker.certPem);
  writeFileSync(join(dir, 'server.key'), broker.keyPem);
  writeFileSync(
    join(dir, 'emqx.conf'),
    renderEmqxConfig({
      SSL_PORT: String(SSL_PORT),
      TCP_BIND: `127.0.0.1:${TCP_PORT}`,
      CERT_DIR: '/certs',
      HOOK_URL: `http://127.0.0.1:${gateway.hookPort}`,
      HOOK_TOKEN: TOKEN,
      NODE_COOKIE: randomBytes(12).toString('hex'),
    }),
  );
  for (const f of ['screens-ca.pem', 'server.pem', 'server.key', 'emqx.conf'])
    chmodSync(join(dir, f), 0o644); // the broker runs as its own user inside the container
  chmodSync(dir, 0o755);
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    NAME,
    '--network',
    'host',
    '-v',
    `${dir}:/certs:ro`,
    '-v',
    `${join(dir, 'emqx.conf')}:/opt/emqx/etc/emqx.conf:ro`,
    'emqx/emqx:5.8.6',
  ]);
  const until = Date.now() + 120_000;
  while (!((await portOpen(SSL_PORT)) && (await portOpen(TCP_PORT)))) {
    if (Date.now() > until) throw new Error(execFileSync('docker', ['logs', NAME]).toString());
    await new Promise((ok) => setTimeout(ok, 1_000));
  }
  await gateway.connect();
}, 240_000);

afterAll(async () => {
  for (const cl of clients) cl.end(true);
  await gateway?.stop();
  try {
    execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  } catch {
    // already gone
  }
  await db?.drop();
});

/** A box opening its line, as the player will (P2.3.3). */
async function connect(box: TestBox, opts: Partial<mqtt.IClientOptions> = {}) {
  const cl = await mqtt.connectAsync(`mqtts://127.0.0.1:${SSL_PORT}`, {
    clientId: box.screenId,
    key: box.keyPem,
    cert: box.certPem,
    ca: brokerCa,
    servername: 'localhost',
    reconnectPeriod: 0,
    connectTimeout: 10_000,
    ...opts,
  });
  clients.push(cl);
  return cl;
}

/** The next message on a topic, or a timeout. */
const next = (cl: mqtt.MqttClient, topic: string, ms = 10_000) =>
  new Promise<string>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`nothing on ${topic}`)), ms);
    const on = (got: string, payload: Buffer) => {
      if (got !== topic) return;
      clearTimeout(t);
      cl.off('message', on);
      ok(payload.toString());
    };
    cl.on('message', on);
  });

const refused = async (attempt: () => Promise<unknown>) => {
  try {
    await attempt();
  } catch {
    return true;
  }
  return false;
};

describe('the screen line end to end (P2.3.2: EMQX over TLS + gateway + database)', () => {
  it('a box opens its line, gets the time, uploads, and every report is stored once', async () => {
    const cl = await connect(a);
    const down = `recall/v1/s/${a.screenId}/down`;
    await cl.subscribeAsync(`${down}/#`, { qos: 1 });
    const time = next(cl, `${down}/time`);
    const before = Date.now();
    await cl.publishAsync(`recall/v1/s/${a.screenId}/up/hello`, helloText('0.1.0', 777), {
      qos: 1,
    });
    const t = JSON.parse(await time) as { utcMs: number; echo: number };
    expect(t.echo).toBe(777);
    expect(t.utcMs).toBeGreaterThanOrEqual(before - 1_000);
    const batch = [1, 2, 3].map((seq) => ({ seq, at: NOW, report: live(NOW + seq) }));
    for (let i = 0; i < 2; i++) {
      // Sent twice (a lost ack): stored once, acked both times.
      const ack = next(cl, `${down}/ack`);
      await cl.publishAsync(`recall/v1/s/${a.screenId}/up/upload`, uploadText(batch, 1), {
        qos: 1,
      });
      expect(await ack).toBe('{"ack":3}');
    }
    const n = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM screen_reports WHERE screen_id = $1',
      [a.screenId],
    );
    expect(n.rows[0]?.n).toBe(3);
    cl.end();
  }, 60_000);

  it('no certificate, a stranger authority, or a borrowed name: no line', async () => {
    const stranger = await fakeDeviceCa('stranger').issue({
      screenId: a.screenId,
      publicKey: (await import('node:crypto'))
        .createPublicKey(a.keyPem)
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
      notBefore: NOW - 60,
      notAfter: NOW + 86_400,
    });
    expect(
      await refused(() =>
        mqtt.connectAsync(`mqtts://127.0.0.1:${SSL_PORT}`, {
          clientId: a.screenId,
          ca: brokerCa,
          servername: 'localhost',
          reconnectPeriod: 0,
        }),
      ),
    ).toBe(true);
    expect(await refused(() => connect(a, { cert: stranger.certPem }))).toBe(true);
    // A's own certificate and key, calling itself B.
    expect(await refused(() => connect(a, { clientId: b.screenId }))).toBe(true);
    // The internal port with A's id and certificate fingerprint as user name (certificates are
    // not secret): no TLS, so no line.
    const { certFingerprint } = await import('@recall/db');
    expect(
      await refused(() =>
        mqtt.connectAsync(`mqtt://127.0.0.1:${TCP_PORT}`, {
          clientId: a.screenId,
          username: certFingerprint(a.certPem),
          password: 'x',
          reconnectPeriod: 0,
        }),
      ),
    ).toBe(true);
    // The gateway's name with a guessed password.
    expect(
      await refused(() =>
        mqtt.connectAsync(`mqtt://127.0.0.1:${TCP_PORT}`, {
          clientId: 'recall-gateway-x',
          username: 'recall-gateway',
          password: 'guess',
          reconnectPeriod: 0,
        }),
      ),
    ).toBe(true);
  }, 60_000);

  it('a box cannot listen to or send as another box', async () => {
    const cl = await connect(b);
    // Listening to A: refused, and the broker drops B's line for asking.
    const asked = await cl
      .subscribeAsync(`recall/v1/s/${a.screenId}/down/#`, { qos: 1 })
      .then((g) => g[0]?.qos)
      .catch(() => 'line dropped');
    expect([128, 'line dropped']).toContain(asked);
    const again = await connect(b);
    // Sending as A: the broker drops the line, and nothing is stored for A from B.
    const closed = new Promise<void>((ok) => again.once('close', () => ok()));
    again.publish(
      `recall/v1/s/${a.screenId}/up/upload`,
      uploadText([{ seq: 4, at: NOW, report: live(NOW + 4) }], 4),
      { qos: 1 },
    );
    await closed;
    await new Promise((ok) => setTimeout(ok, 1_000));
    const n = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM screen_reports WHERE screen_id = $1',
      [a.screenId],
    );
    expect(n.rows[0]?.n).toBe(3);
  }, 60_000);

  it('a revoked certificate is refused from the next connection', async () => {
    const first = await connect(c);
    first.end();
    await revokeCertificate(pool, c.certSerial, 'box reported stolen', 'ops-1', NOW);
    expect(await refused(() => connect(c))).toBe(true);
  }, 60_000);
});
