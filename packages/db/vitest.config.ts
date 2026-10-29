// Heavier tests here (the final report's PDF, catching up a month of plays) run in a few seconds on
// a laptop but can pass 5 s when the whole suite shares one database; 20 s keeps them reliable
// without hiding a real hang (as in services/workers and packages/domain).
//
// Coverage (P7.3): the code that posts money and counts plays must stay tested. `pnpm coverage`
// (all tests, needs the database; run in CI) fails if any of these files falls below the floor.
import { defineConfig } from 'vitest/config';

/** Where money is posted and plays are counted. */
export const MONEY_AND_PLAYS = [
  'booking-desk',
  'bookings',
  'brand-pay',
  'cuts',
  'delivery',
  'earnings',
  'gst',
  'ledger',
  'makeups',
  'money',
  'money-back',
  'partners',
  'payouts',
  'plays',
  'poc',
  'rider-earnings',
  'rider-pay',
  'rider-payouts',
  'screen-reports',
].map((f) => `src/${f}.ts`);

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: MONEY_AND_PLAYS,
      reporter: ['text', 'text-summary'],
      thresholds: { perFile: true, lines: 88, branches: 65 },
    },
  },
});
