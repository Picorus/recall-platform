// The live demo, in one command (pnpm demo): a fresh made-up RECALL in its own database (marked a
// demo copy, so it can never be the real one), the API with a stand-in for every outside service, the
// staff and brand portals, the rider app in the browser, bikes riding, and the demo desk that ties it
// together. Everything is rebuilt each start, dated around today. Ctrl+C stops it all.
//   pnpm demo                 200 bikes
//   pnpm demo -- --bikes 2000
import {
  fakeBankCheck,
  fakeEsign,
  fakeFileStore,
  fakeGst,
  fakeInbound,
  fakeKyc,
  fakeMaps,
  fakeMessages,
  fakePayments,
  fakePayouts,
  fakePush,
} from '@recall/adapters';
import { apiHandler, reportRender, type StaffApiConfig } from '@recall/api';
import {
  accrueRiderPay,
  advanceReadyBookings,
  buildDueReports,
  closeEarnings,
  expireUnpaid,
  isDemoCopy,
  makeRiderAlerts,
  migrate,
  sendDueNotices,
  sendDueReports,
  sendRiderAlerts,
  setting,
  settleDue,
} from '@recall/db';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { startBikes } from './bikes.js';
import { startDesk } from './desk.js';
import { seedDemo } from './seed.js';

const ROOT = join(import.meta.dirname, '../../..');
const PORTS = { api: 8080, staff: 3001, brand: 3000, rider: 8081, desk: 4000 };
const DB_NAME = 'recall_demo';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { bikes: { type: 'string', default: '200' } },
});
const bikes = Math.max(10, Math.min(2000, Number(values.bikes) || 200));
const log = (l: string) => console.log(`demo: ${l}`);

/**
 * The demo's clock. Campaigns run 8 am to 2 am India time; started at night, the demo would show
 * nothing on the road, so outside 8 am–11 pm it runs as if it were 6:30 pm that day (the desk says
 * so). Everything in the demo (data, API, bikes, payments) reads this clock.
 */
const shiftMs = (() => {
  const india = new Date(Date.now() + 19_800_000);
  const h = india.getUTCHours();
  if (h >= 8 && h < 23) return 0;
  const evening = Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate(), 18, 30);
  return evening - 19_800_000 - Date.now();
})();
const clock = () => Date.now() + shiftMs;

/** Where each part is opened from: a Codespace's forwarded address, or this machine. */
const codespace = process.env.CODESPACE_NAME;
const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? 'app.github.dev';
const urlOf = (port: number) =>
  codespace ? `https://${codespace}-${port}.${domain}` : `http://localhost:${port}`;
const urls = {
  staff: urlOf(PORTS.staff),
  brand: urlOf(PORTS.brand),
  rider: urlOf(PORTS.rider),
  desk: urlOf(PORTS.desk),
};
const both = (port: number) => [...new Set([`http://localhost:${port}`, urlOf(port)])];

// 1. A fresh demo database (never touches one that is not a demo copy).
const serverUrl = process.env.DATABASE_URL ?? 'postgres://recall:recall@localhost:5432/recall';
const demoUrl = (() => {
  const u = new URL(serverUrl);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
})();
{
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect().catch(() => {
    console.error('demo: the database is not running. Start it with: pnpm services:up');
    process.exit(1);
  });
  const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]))
    .rowCount;
  if (exists) {
    const old = new pg.Client({ connectionString: demoUrl });
    await old.connect();
    const demo = await isDemoCopy(old).catch(() => false);
    await old.end();
    if (!demo) {
      console.error(`demo: database ${DB_NAME} exists and is not a demo copy: not touching it`);
      process.exit(1);
    }
    await admin.query(`DROP DATABASE ${DB_NAME} WITH (FORCE)`);
  }
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
}
const pool = new pg.Pool({ connectionString: demoUrl, max: 30 });
pool.on('error', (e) => log(`database: ${e.message}`));
await migrate(pool);

// 2. The stand-ins, shared by the data and the API (ad files live in memory).
const secretKey = randomBytes(32);
const files = fakeFileStore({
  baseUrl: `${urls.staff}/api/files`,
  secret: randomBytes(16).toString('hex'),
});
const messages = fakeMessages();
const payments = fakePayments({
  baseUrl: `${urls.desk}/pay`,
  secret: randomBytes(32).toString('hex'),
  clock: () => Math.floor(clock() / 1000),
});
const push = fakePush();
const maps = fakeMaps();

// 3. The made-up business.
const now = Math.floor(clock() / 1000);
const t0 = Date.now();
log(
  `building a fresh demo with ${bikes} bikes (${bikes > 500 ? 'several minutes' : 'about a minute'})…`,
);
const seeded = await seedDemo(pool, files, secretKey, now, {
  riders: bikes,
  log: (l) => log(`  ${l}`),
});
log(`demo data ready in ${Math.round((Date.now() - t0) / 1000)} s`);

// 4. The API, as on a laptop, every outside service a stand-in.
const cfg: StaffApiConfig = {
  secretKey,
  origins: both(PORTS.staff),
  brandOrigins: both(PORTS.brand),
  riderOrigins: both(PORTS.rider),
  secureCookies: Boolean(codespace),
  proxyHops: 0,
  payments,
  files,
  riderChecks: {
    kyc: fakeKyc({ auto: true }),
    esign: fakeEsign({ auto: true }),
    bank: fakeBankCheck(),
  },
  payouts: fakePayouts(),
  inbound: fakeInbound(),
  reports: { maps, messages, portalUrl: urls.brand },
  messages,
  push,
  gst: fakeGst(),
  connections: [
    'Brand payments',
    'Rider checks (KYC, e-sign, bank)',
    'Rider payouts',
    'Maps, WhatsApp and email out',
    'Messages coming in',
    'Rider phone notifications',
    'GST number lookup',
    'Ad file store',
  ].map((service) => ({ service, state: 'stand-in' as const, provider: 'fake' })),
};
const api = createServer(apiHandler(pool, cfg, (l) => log(`api: ${l}`), clock));
await new Promise<void>((ok) => api.listen(PORTS.api, '127.0.0.1', ok));

// 5. What the system does by itself as time passes (as the API and the ledger do in production).
const render = reportRender(urls.brand);
const every = (seconds: number, name: string, f: () => Promise<unknown>) => {
  const run = () =>
    f()
      .catch((e: unknown) => log(`${name}: ${(e as Error).message}`))
      .finally(() => setTimeout(run, seconds * 1000).unref());
  setTimeout(run, 20_000).unref();
};
const secs = () => Math.floor(clock() / 1000);
every(60, 'money', async () => {
  await advanceReadyBookings(pool, secs());
  await expireUnpaid(pool, payments, secs());
  await settleDue(pool, secs());
  await closeEarnings(pool, secs());
});
every(120, 'reports', async () => {
  await buildDueReports(pool, maps, secs());
  await sendDueReports(pool, messages, render, secs());
  await sendDueNotices(pool, messages, urls.brand, secs());
});
every(120, 'riders', async () => {
  const rules = await setting(pool, 'riderSignIn');
  await makeRiderAlerts(pool, secs(), rules);
  await sendRiderAlerts(pool, push, secs(), rules);
  await accrueRiderPay(pool, new Date((secs() + 19_800) * 1000).toISOString().slice(0, 7), secs());
});

// 6. The websites: the staff and brand portals (built once), the rider app's web build.
const children: ChildProcess[] = [];
// The websites stop with the demo, however it ends (a crash included).
process.on('exit', () => {
  for (const c of children)
    if (c.pid)
      try {
        process.kill(-c.pid, 'SIGTERM');
      } catch {
        // already gone
      }
});
/** A port another program holds: said plainly instead of a server failing quietly. */
const taken = (port: number) =>
  fetch(`http://127.0.0.1:${port}`).then(
    () => true,
    () => false,
  );
for (const [name, port] of Object.entries(PORTS))
  if (name !== 'api' && (await taken(port))) {
    console.error(
      `demo: port ${port} is in use (an earlier demo still running?). Stop it and start again.`,
    );
    process.exit(1);
  }
const built = (app: string) => existsSync(join(ROOT, 'apps', app, '.next', 'BUILD_ID'));
for (const app of ['admin', 'brand']) {
  if (built(app)) continue;
  log(`building the ${app === 'admin' ? 'staff' : 'brand'} portal (once, a few minutes)…`);
  const r = spawnSync('pnpm', ['--filter', `@recall/${app}`, 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`could not build ${app}`);
}
for (const [app, port] of [
  ['admin', PORTS.staff],
  ['brand', PORTS.brand],
] as const) {
  const child = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: join(ROOT, 'apps', app),
    env: {
      ...process.env,
      API_URL: `http://127.0.0.1:${PORTS.api}`,
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  });
  children.push(child);
}
const riderDir = join(ROOT, 'apps', 'rider', 'dist-demo');
if (!existsSync(join(riderDir, 'index.html'))) {
  log('building the rider app for the browser (once, a minute or two)…');
  const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-demo'], {
    cwd: join(ROOT, 'apps', 'rider'),
    env: { ...process.env, EXPO_PUBLIC_API_URL: '/rider-api' },
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('could not build the rider app');
}
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  // The rider app talks to the API through its own site (no second address to open).
  if (path.startsWith('/rider-api/')) {
    const up = request(
      {
        host: '127.0.0.1',
        port: PORTS.api,
        method: req.method,
        path: (req.url ?? '').slice('/rider-api'.length),
        headers: { ...req.headers, host: `127.0.0.1:${PORTS.api}` },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
    return;
  }
  const file = join(riderDir, path);
  const inside = file.startsWith(riderDir) && existsSync(file) && extname(file) !== '';
  const body = readFileSync(inside ? file : join(riderDir, 'index.html'));
  const type = inside ? (TYPES[extname(file)] ?? 'application/octet-stream') : TYPES['.html'];
  res.writeHead(200, { 'content-type': type ?? 'text/html' });
  res.end(body);
}).listen(PORTS.rider, '0.0.0.0');

// 7. The bikes, riding.
const live = await startBikes(pool, seeded.screens, seeded.areas, log, clock);

// 8. The demo desk.
await startDesk(PORTS.desk, {
  urls,
  totpSecret: seeded.totpSecret,
  clock,
  sent: messages.sent,
  links: () => payments.links,
  pay: async (linkId) => {
    const m = payments.pay(linkId);
    await fetch(`http://127.0.0.1:${PORTS.api}/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment-signature': m.signature },
      body: m.body,
    });
    return `${urls.brand}/`;
  },
  stats: () => {
    const s = live.stats();
    return {
      'Bikes riding': s.bikes,
      'Uploads received from screens': s.uploads,
      "Brands' ads played since the start": s.brandPlays,
      'Plays stored in all (with history)': seeded.counts.plays ?? 0,
      Campaigns: seeded.counts.bookings ?? 0,
      'Demo time (India)': new Date(clock()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      'Demo clock': shiftMs === 0 ? 'the real time' : 'set to 6:30 pm (started outside 8 am–11 pm)',
    };
  },
});

console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  RECALL demo is running. Open the demo desk:                  │
  │  ${urls.desk.padEnd(60)}│
  │  Staff ${urls.staff.padEnd(54)}│
  │  Brand ${urls.brand.padEnd(54)}│
  │  Rider ${urls.rider.padEnd(54)}│
  │  Stop: Ctrl+C. Starting again builds a fresh demo.            │
  └──────────────────────────────────────────────────────────────┘
`);

const stop = () => {
  live.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
