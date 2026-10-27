// P4.3: fitting on the rider app. He books a slot at a centre that is on; at his slot (only then)
// the technician scans the screen's QR on his phone and the screen goes on his bike; the fitting
// check runs and the technician says whether the panel lit up; ready only when all of it passed.
import { fakeDeviceCa } from '@recall/adapters';
import { DEFAULT_RIDER_SIGN_IN as R, type FittingReport, type Numbered } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerPanel,
  appFittingPage,
  bookFromApp,
  cancelFromApp,
  fitFromApp,
  startFittingFromApp,
} from '../../src/rider-app-fitting.js';
import { openFittingSlot } from '../../src/rider-fitting.js';
import { createRider } from '../../src/riders.js';
import { storeUpload } from '../../src/screen-reports.js';
import { enrolScreen } from '../../src/screens.js';
import { setting } from '../../src/settings.js';
import { boxRequest as signedBox, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const HOUR = 3600;
const boxRequest = (serial: string) => signedBox(serial, NOW - HOUR);

/** An approved rider with his own plate. */
async function approved(name: string, phone: string, plate: string) {
  const id = await createRider(
    pool,
    {
      details: { name, phone, bikePlate: plate, rides: 'Madhapur', apps: [] },
      channel: 'app',
      by: 'rider app',
      reason: 'signed up on the rider app',
    },
    NOW - 2 * HOUR,
  );
  await pool.query(
    `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
     VALUES ($1, 2, 'approved', 'all checked', 'Omar', to_timestamp($2))`,
    [id, NOW - HOUR],
  );
  return id;
}

const report = (id: string, at: number, o: Partial<FittingReport> = {}): FittingReport => ({
  kind: 'fitting',
  id,
  at,
  gpsAccuracyM: 6,
  lineUp: true,
  camera: 'ok',
  batteryPct: 80,
  charging: false,
  panel: 'unknown',
  ...o,
});

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await pool.query(
    `INSERT INTO settings (key, version, value, saved_by, reason)
     VALUES ('fittingCentres', 1, $1, 'Prateek', 'the first two centres')`,
    [
      JSON.stringify([
        { name: 'Madhapur hub', address: 'Plot 5, Madhapur', on: true },
        { name: 'Uppal yard', address: 'Uppal X roads', on: false },
      ]),
    ],
  );
}, 60_000);
afterAll(async () => db.drop());

describe('fitting on the rider app (P4.3)', () => {
  it('books at a centre that is on; fits only at his slot; the check and the panel make it ready', async () => {
    const ravi = await approved('Ravi Kumar', '+919811100001', 'TS09EA1234');
    const sita = await approved('Sita Devi', '+919811100002', 'TS09EB5678');
    const start = NOW + 2 * HOUR;
    const slot = await openFittingSlot(
      pool,
      { centre: 'Madhapur hub', startsAt: start, minutes: 60, bikes: 1, by: 'Omar' },
      NOW,
    );
    const off = await openFittingSlot(
      pool,
      { centre: 'Uppal yard', startsAt: start, minutes: 60, bikes: 5, by: 'Omar' },
      NOW,
    );
    let page = await appFittingPage(pool, ravi, NOW, R);
    expect(page.booking).toBeNull();
    expect(page.slots).toEqual([
      {
        slotId: slot,
        centre: 'Madhapur hub',
        address: 'Plot 5, Madhapur',
        startsAt: start,
        minutes: 60,
        left: 1,
      },
    ]);
    // A centre that is off takes no bookings from the app.
    await expect(bookFromApp(pool, ravi, off, NOW)).rejects.toThrow('not open');
    await bookFromApp(pool, ravi, slot, NOW);
    // The last place is his: not shown to others, and refused to them.
    expect((await appFittingPage(pool, sita, NOW, R)).slots).toEqual([]);
    await expect(bookFromApp(pool, sita, slot, NOW)).rejects.toMatchObject({
      why: { code: 'slot-full' },
    });
    page = await appFittingPage(pool, ravi, NOW, R);
    expect(page.booking).toMatchObject({ slotId: slot, canFitNow: false });

    const box = await enrolScreen(pool, fakeDeviceCa(), boxRequest('RK-FIT-1'), 'w', NOW - HOUR);
    // Before his slot: a QR seen anywhere is no use.
    await expect(fitFromApp(pool, ravi, box.qr, NOW, R)).rejects.toMatchObject({
      why: { code: 'not-your-slot' },
    });
    await expect(fitFromApp(pool, ravi, 'hello', start, R)).rejects.toMatchObject({
      why: { code: 'not-a-screen' },
    });
    const at = start - 10 * 60;
    expect((await appFittingPage(pool, ravi, at, R)).booking?.canFitNow).toBe(true);
    // The id printed under the QR, typed in small letters, works too.
    expect(await fitFromApp(pool, ravi, box.screenId.toLowerCase(), at, R)).toBe(box.screenId);
    page = await appFittingPage(pool, ravi, at + 1, R);
    expect(page).toMatchObject({ screenId: box.screenId, check: null, slots: [] });
    expect(page.booking?.canFitNow).toBe(false);
    // One screen per bike: a second one is refused, with why.
    const other = await enrolScreen(pool, fakeDeviceCa(), boxRequest('RK-FIT-2'), 'w', NOW - HOUR);
    await expect(fitFromApp(pool, ravi, other.qr, at + 5, R)).rejects.toMatchObject({
      why: { code: 'cannot-fit' },
      message: `TS09EA1234 already carries ${box.screenId}`,
    });
    await expect(bookFromApp(pool, ravi, slot, at + 5)).rejects.toThrow('fitted already');

    // The check: started once (a second tap gets the same one), each part waiting on the box.
    const { commandId } = await startFittingFromApp(pool, ravi, at + 60, R);
    expect((await startFittingFromApp(pool, ravi, at + 70, R)).commandId).toBe(commandId);
    page = await appFittingPage(pool, ravi, at + 80, R);
    expect(page.check).toMatchObject({
      commandId,
      gps: 'waiting',
      line: 'waiting',
      camera: 'waiting',
      battery: 'waiting',
      panel: 'waiting',
      ready: false,
    });
    await storeUpload(
      pool,
      box.screenId,
      [{ seq: 1, at: at + 200, report: report(commandId, at + 200) } as Numbered],
      1,
      at + 210,
    );
    page = await appFittingPage(pool, ravi, at + 220, R);
    expect(page.check).toMatchObject({ gps: 'ok', battery: 'ok', panel: 'waiting', ready: false });
    // Only his own screen's check.
    await expect(answerPanel(pool, sita, commandId, true, at + 230)).rejects.toThrow(
      'Fit your screen first',
    );
    await answerPanel(pool, ravi, commandId, true, at + 230);
    expect((await appFittingPage(pool, ravi, at + 240, R)).check?.ready).toBe(true);
    await expect(answerPanel(pool, ravi, commandId, false, at + 250)).rejects.toThrow(
      'Answered already',
    );
    const audit = await pool.query(
      `SELECT who, action, ref, detail FROM audit_log WHERE action LIKE 'fitting:%'`,
    );
    expect(audit.rows).toEqual([
      { who: 'rider app', action: 'fitting: panel seen', ref: box.screenId, detail: ravi },
    ]);

    // A new check: the latest counts. No answer from the box in time: unknown, not ready.
    const again = await startFittingFromApp(pool, ravi, at + 300, R);
    expect(again.commandId).not.toBe(commandId);
    page = await appFittingPage(pool, ravi, at + 300 + 11 * 60, R);
    expect(page.check).toMatchObject({ gps: 'unknown', camera: 'unknown', ready: false });
    // A few a day.
    await expect(
      startFittingFromApp(pool, ravi, at + 1_000, { ...R, fittingChecksPerDay: 2 }),
    ).rejects.toMatchObject({ why: { code: 'too-many-checks' } });
  });

  it('cancel and book again; no booking, no fitting; a failed part is never ready', async () => {
    const amit = await approved('Amit Shah', '+919811100003', 'TS10AA0001');
    const start = NOW + 30 * HOUR;
    const slot = await openFittingSlot(
      pool,
      { centre: 'Madhapur hub', startsAt: start, minutes: 30, bikes: 3, by: 'Omar' },
      NOW,
    );
    const box = await enrolScreen(pool, fakeDeviceCa(), boxRequest('RK-FIT-3'), 'w', NOW - HOUR);
    await expect(fitFromApp(pool, amit, box.qr, start, R)).rejects.toMatchObject({
      why: { code: 'no-booking' },
    });
    await bookFromApp(pool, amit, slot, NOW);
    await cancelFromApp(pool, amit, NOW + 10);
    expect((await appFittingPage(pool, amit, NOW + 20, R)).booking).toBeNull();
    await bookFromApp(pool, amit, slot, NOW + 30);
    // Late, but inside the time after his slot.
    const at = start + 30 * 60 + (R.fitLateMinutes - 1) * 60;
    await fitFromApp(pool, amit, box.qr, at, R);
    const { commandId } = await startFittingFromApp(pool, amit, at + 10, R);
    await storeUpload(
      pool,
      box.screenId,
      [
        {
          seq: 1,
          at: at + 100,
          report: report(commandId, at + 100, { gpsAccuracyM: 400 }),
        } as Numbered,
      ],
      1,
      at + 110,
    );
    await answerPanel(pool, amit, commandId, true, at + 120);
    expect((await appFittingPage(pool, amit, at + 130, R)).check).toMatchObject({
      gps: 'fail',
      panel: 'ok',
      ready: false,
    });
  });

  it('a limit saved before the fitting rules existed gets them at their defaults', async () => {
    const { fitEarlyMinutes, fitLateMinutes, fittingChecksPerDay, ...older } = R;
    await pool.query(
      `INSERT INTO settings (key, version, value, saved_by, reason)
       VALUES ('riderSignIn', 1, $1, 'Prateek', 'saved before P4.3')`,
      [JSON.stringify({ ...older, codesPerDay: 9 })],
    );
    expect(await setting(pool, 'riderSignIn')).toEqual({
      ...R,
      codesPerDay: 9,
      fitEarlyMinutes,
      fitLateMinutes,
      fittingChecksPerDay,
    });
  });
});
