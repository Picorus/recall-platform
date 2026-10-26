// P3.12: the weekly payout run in admin. Finance (and a super admin) look; finance admins and a
// super admin act. The run is prepared by itself on Monday from 10:00 India time (or by hand), then
// approved by someone else than who prepared it, then sent through the payout provider; a line can
// be held, released or dropped (its money goes in the next run) and failures are sent again.
//   GET  /payouts                          the latest runs, and the Monday due now
//   GET  /payouts/run/<YYYY-MM-DD>         one run: each line, its tries, what preparing it found
//   POST /payouts/prepare                  { monday }
//   POST /payouts/run/<date>/approve
//   POST /payouts/run/<date>/send          sends what is not paid, held or given up (again: retries)
//   POST /payouts/run/<date>/hold          { riderId, held: true | false, reason }
//   POST /payouts/run/<date>/drop          { riderId, reason }
//   POST /payouts/run/<date>/cancel        { reason }
import {
  approvePayoutRun,
  cancelPayoutRun,
  dropPayoutLine,
  holdPayoutLine,
  openOlderLines,
  payoutRunDue,
  payoutRunExists,
  payoutRunPage,
  payoutRuns,
  preparePayoutRun,
  Refusal,
  sendPayoutRun,
} from '@recall/db';
import { can, moneyRole, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) => can(a, { area: 'finance', change: false });
const mayAct = (a: StaffAccess) => ['finance', 'super-admin'].includes(moneyRole(a));
const RIDER = /^RD-\d{6}$/;
/** A UPI id (often his phone number) inside any text, with its bank kept. */
const maskUpi = (t: string) =>
  t.replace(/[A-Za-z0-9._-]{2,256}@([A-Za-z][A-Za-z0-9.]{1,63})/g, '••••@$1');
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A real Monday "YYYY-MM-DD" (2000–2099). */
const isMonday = (x: string) =>
  /^20\d{2}-\d{2}-\d{2}$/.test(x) &&
  new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x &&
  new Date(`${x}T00:00:00Z`).getUTCDay() === 1;

/** The latest Monday on or before `now`, India date. */
function lastMonday(now: number): string {
  const d = new Date((now + 330 * 60) * 1000);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The database's refusals in words: 404 for no run, 409 for a state that moved on, else 400. */
async function refused<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof Refusal) && !(e instanceof RangeError)) throw e;
    if (e.message.startsWith('Only')) throw new HttpError(403, e.message);
    if (/^No (payout run|line for)/.test(e.message)) throw new HttpError(404, e.message);
    if (/already|being sent|cannot be/.test(e.message)) throw new HttpError(409, e.message);
    throw new HttpError(400, e.message);
  }
}

export async function handlePayouts(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/'] = (req.url ?? '/').split('?');
  if (path !== '/payouts' && !path.startsWith('/payouts/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/payouts') {
      const open = await openOlderLines(pool);
      send(res, 200, {
        at: now,
        runs: await payoutRuns(pool),
        // Money still waiting in older runs (held, not sent, failed): kept out of new runs.
        openOlder: open,
        lastMonday: lastMonday(now),
        dueNow: payoutRunDue(now),
        canAct: mayAct(me.access),
        canSend: cfg.payouts !== undefined,
      });
      return true;
    }
    const m = /^\/payouts\/run\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (!m) throw new HttpError(404, 'Not found');
    const page = await payoutRunPage(pool, m[1] ?? '');
    if (!page) throw new HttpError(404, `No payout run ${m[1] ?? ''}`);
    // Read-only members see a UPI id's bank only (it is often his phone number), wherever it is.
    const act = mayAct(me.access);
    const rows = act
      ? page.rows
      : page.rows.map((r) => ({
          ...r,
          to: maskUpi(r.to),
          reason: r.reason === null ? null : maskUpi(r.reason),
          history: r.history.map((h) => ({ ...h, text: maskUpi(h.text) })),
        }));
    const { preparedById, ...shown } = page;
    send(res, 200, {
      at: now,
      ...shown,
      rows,
      canAct: act,
      // Whoever prepared a run by hand does not approve it.
      canApprove: act && page.approvedBy === null && preparedById !== me.id,
    });
    return true;
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayAct(me.access))
    throw new HttpError(403, 'Only finance or a super admin works the payout run');
  const by = { id: me.id, role: moneyRole(me.access) };
  const b = await jsonBody(req);
  if (path === '/payouts/prepare') {
    const monday = str(b, 'monday', 10);
    if (!isMonday(monday)) throw new HttpError(400, 'Which Monday? (YYYY-MM-DD)');
    // This week's run, or last week's if it was missed: never an old week by mistake.
    const latest = lastMonday(now);
    if (monday !== latest && monday !== addDays(latest, -7))
      throw new HttpError(400, `Only this Monday's run (${latest}) or last week's can be prepared`);
    const run = await refused(() => preparePayoutRun(pool, monday, now, me.id));
    send(res, 200, { runId: run.runId, lines: run.lines.length });
    return true;
  }
  const m = /^\/payouts\/run\/(\d{4}-\d{2}-\d{2})\/(approve|send|hold|drop|cancel)$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const runId = m[1] ?? '';
  const action = m[2];
  // A run that does not exist is a 404 whatever is asked of it.
  if (!(await payoutRunExists(pool, runId))) throw new HttpError(404, `No payout run ${runId}`);
  const rider = () => {
    const id = str(b, 'riderId', 9);
    if (!RIDER.test(id)) throw new HttpError(400, 'Which rider?');
    return id;
  };
  if (action === 'approve') {
    await refused(() => approvePayoutRun(pool, runId, by, now));
    send(res, 200, { approved: runId });
  } else if (action === 'send') {
    const provider = cfg.payouts;
    if (!provider)
      throw new HttpError(
        503,
        'Payouts are not set up yet: the payout provider comes with its contract',
      );
    send(res, 200, await refused(() => sendPayoutRun(pool, runId, provider, now)));
  } else if (action === 'hold') {
    const riderId = rider();
    if (typeof b.held !== 'boolean') throw new HttpError(400, 'held must be true or false');
    const held = b.held;
    const reason = str(b, 'reason', 300);
    await refused(() => holdPayoutLine(pool, runId, riderId, held, by, reason, now));
    send(res, 200, { riderId, held });
  } else if (action === 'drop') {
    const riderId = rider();
    const reason = str(b, 'reason', 300);
    await refused(() => dropPayoutLine(pool, runId, riderId, by, reason, now));
    send(res, 200, { dropped: riderId });
  } else {
    const reason = str(b, 'reason', 300);
    send(res, 200, {
      cancelled: await refused(() => cancelPayoutRun(pool, runId, by, reason, now)),
    });
  }
  return true;
}
