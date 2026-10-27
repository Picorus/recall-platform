// Starts the API from the environment.
import { createServer } from 'node:http';
import {
  advanceReadyBookings,
  buildDueReports,
  expireUnpaid,
  makeRiderAlerts,
  sendRiderAlerts,
  setting,
  prepareDueRun,
  sendDueReports,
  settleDue,
} from '@recall/db';
import pg from 'pg';
import { readConfig } from './config.js';
import { reportRender } from './report-render.js';
import { apiHandler } from './staff-api.js';

// A mistake in one request must never stop the API for everyone.
process.on('unhandledRejection', (e) => console.error('api: unhandled', e));

const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
// A connection the database drops while idle (a restart, a failover) is logged and replaced, never
// allowed to stop the API.
pool.on('error', (e) => console.error(`api: database connection lost: ${e.message}`));
const server = createServer(apiHandler(pool, cfg));
server.listen(cfg.port, cfg.host, () => console.log(`api: listening on ${cfg.host}:${cfg.port}`));

// Every minute: bookings whose payment link ran out unpaid are cancelled, so their bikes go back on
// sale (P3.8.2). Each run finishes before the next starts; a failure is logged and tried next time.
const payments = cfg.payments;
if (payments) {
  const tick = () => {
    expireUnpaid(pool, payments, Math.floor(Date.now() / 1000))
      .then((ids) => {
        if (ids.length > 0) console.log(`api: unpaid bookings cancelled: ${ids.join(', ')}`);
      })
      .catch((e: unknown) => console.error('api: expiring payment links failed', e))
      .finally(() => setTimeout(tick, 60_000).unref());
  };
  setTimeout(tick, 60_000).unref();
}

// Every minute: paid bookings whose ads are all approved move on to ads approved (P3.9.2), in case
// the step was missed when it happened (the database failing just after a payment, say).
const ready = () => {
  advanceReadyBookings(pool, Math.floor(Date.now() / 1000))
    .then((ids) => {
      if (ids.length > 0) console.log(`api: bookings ready to run: ${ids.join(', ')}`);
    })
    .catch((e: unknown) => console.error('api: moving ready bookings on failed', e))
    .finally(() => setTimeout(ready, 60_000).unref());
};
setTimeout(ready, 60_000).unref();

// Every minute, only when SETTLE_MAKE_UPS=on: the make-up and refund decisions that are due (P1.6,
// shown on the Delivery page, P3.10). Off by default until the screens' hour plans include make-ups
// (the scheduler service): a make-up opened that no screen plays would only lead to a refund.
// Safe to run as often as wanted: each decision is made once.
if (process.env.SETTLE_MAKE_UPS === 'on') {
  const settle = () => {
    settleDue(pool, Math.floor(Date.now() / 1000))
      .then((s) => {
        if (s.opened.length > 0)
          console.log(`api: make-ups opened: ${s.opened.map((m) => m.makeUpId).join(', ')}`);
        for (const f of s.failed) console.error(`api: could not settle ${f.lineId}: ${f.error}`);
      })
      .catch((e: unknown) => console.error('api: settling lines failed', e))
      .finally(() => setTimeout(settle, 60_000).unref());
  };
  setTimeout(settle, 60_000).unref();
}

// Every 5 minutes, unless PAYOUT_PREPARE=off: on Monday from 10:00 India time, the week's payout run
// is prepared if nobody has prepared it yet (P3.12). Nothing is paid: finance approves and sends it.
if (process.env.PAYOUT_PREPARE !== 'off') {
  const prepare = () => {
    prepareDueRun(pool, Math.floor(Date.now() / 1000))
      .then((run) => {
        if (run) console.log(`api: payout run ${run.runId} prepared (${run.lines.length} riders)`);
      })
      .catch((e: unknown) => console.error('api: preparing the payout run failed', e))
      .finally(() => setTimeout(prepare, 300_000).unref());
  };
  setTimeout(prepare, 60_000).unref();
}

// Every 5 minutes, when maps and messages are set up (fakes on a laptop; real ones in P6): final
// reports that are due are built (P1.9.1), then sent to brands (P1.9.2). Each is built once and
// sent once per channel; problems are logged and shown on the Reports page.
const reports = cfg.reports;
if (reports) {
  const render = reportRender(reports.portalUrl);
  const tick = () => {
    const now = Math.floor(Date.now() / 1000);
    buildDueReports(pool, reports.maps, now)
      .then(async (b) => {
        if (b.built.length > 0) console.log(`api: reports built: ${b.built.join(', ')}`);
        for (const f of b.failed) console.error(`api: report for ${f.bookingId}: ${f.error}`);
        const s = await sendDueReports(pool, reports.messages, render, now);
        if (s.sent.length > 0) console.log(`api: reports sent: ${s.sent.join(', ')}`);
      })
      .catch((e: unknown) => console.error('api: reports failed', e))
      .finally(() => setTimeout(tick, 300_000).unref());
  };
  setTimeout(tick, 60_000).unref();
}

// Every 2 minutes: riders' alerts that are due are made (each once), then sent to their phones,
// never while the bike is moving (P4.10). Without a push service they are only listed in the app.
const alerts = () => {
  const now = Math.floor(Date.now() / 1000);
  setting(pool, 'riderSignIn')
    .then((rules) => makeRiderAlerts(pool, now, rules))
    .then(async () => {
      if (!cfg.push) return;
      const s = await sendRiderAlerts(pool, cfg.push, now);
      if (s.failed > 0) console.error(`api: ${s.failed} rider notifications failed`);
    })
    .catch((e: unknown) => console.error('api: rider alerts failed', e))
    .finally(() => setTimeout(alerts, 120_000).unref());
};
setTimeout(alerts, 60_000).unref();
