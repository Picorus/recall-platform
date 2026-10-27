// P7.2: the payout run at full fleet. 15,500 riders in the POC, each with a screen for the month and
// a checked UPI account; the Monday run is prepared (pay brought up to date, a line each), approved
// and sent through the fake payouts provider, each step timed. On a fresh database, dropped after.
//   DATABASE_URL=… npx tsx packages/db/test/load/payout-run.ts --riders 15500
import { fakePayouts } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { parseArgs } from 'node:util';
import { saveAreaVersion } from '../../src/areas.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { approvePayoutRun, preparePayoutRun, sendPayoutRun } from '../../src/payouts.js';
import { assignScreen, monthBounds } from '../../src/rider-pay.js';
import { checkedPayoutAccount, freshDatabase } from '../db/fresh-db.js';

const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;

export async function runPayoutLoad(riders: number, log: (l: string) => void = () => {}) {
  const db = await freshDatabase();
  const pool = db.pool;
  try {
    for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
      await saveAreaVersion(pool, { ...a, draft: false }, 'system');
    await savePriceBook(pool, PRICE_BOOK_V1, 'load');
    await setBusinessMode(
      pool,
      'poc',
      { id: 'prateek', role: 'super-admin' },
      'POC starts',
      ist('2027-07-20T12:00:00'),
    );
    const ids = Array.from(
      { length: riders },
      (_, i) => `RD-${String(100_000 + i).padStart(6, '0')}`,
    );
    log(`setting up ${riders} riders…`);
    const start = monthBounds('2027-08').start;
    for (let i = 0; i < ids.length; i += 8) {
      await Promise.all(
        ids.slice(i, i + 8).map(async (r) => {
          await checkedPayoutAccount(pool, r, {
            kind: 'upi',
            vpa: `${r.toLowerCase()}@okbank`,
            name: r,
          });
          await assignScreen(pool, `scr-${r}`, r, start, 'fitter');
        }),
      );
      if (i % 2000 === 0) log(`  ${i}`);
    }
    const at = ist('2027-08-09T10:00:00');
    const time = async <T>(f: () => Promise<T>) => {
      const t0 = performance.now();
      const out = await f();
      return { out, seconds: Math.round((performance.now() - t0) / 100) / 10 };
    };
    log('preparing the run…');
    const prepared = await time(() => preparePayoutRun(pool, '2027-08-09', at));
    await approvePayoutRun(pool, '2027-08-09', { id: 'meena', role: 'finance' }, at + 60);
    log('sending it…');
    const sent = await time(() => sendPayoutRun(pool, '2027-08-09', fakePayouts(), at + 120));
    return {
      riders,
      lines: prepared.out.lines.length,
      prepareSeconds: prepared.seconds,
      paid: sent.out.paid.length,
      sendSeconds: sent.seconds,
      problems: prepared.out.payProblems.length + sent.out.failed.length + sent.out.givenUp.length,
    };
  } finally {
    await db.drop();
  }
}

if (process.argv[1]?.endsWith('payout-run.ts')) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { riders: { type: 'string', default: '15500' } },
  });
  runPayoutLoad(Number(values.riders), (l) => console.log(l))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
