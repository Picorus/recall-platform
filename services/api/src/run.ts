// Starts the API from the environment.
import { createServer } from 'node:http';
import { advanceReadyBookings, expireUnpaid, settleDue } from '@recall/db';
import pg from 'pg';
import { readConfig } from './config.js';
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
