// Heavier tests here (property tests with thousands of cases, PDF rendering) run well under 5 s on a
// laptop but can pass it on a busy CI machine; 20 s keeps them reliable without hiding a real hang.
//
// Coverage (P7.3): the rules that decide money and plays must stay tested. `pnpm test` measures
// them and fails if any of these files falls below the floor (each file on its own).
import { defineConfig } from 'vitest/config';

/** The rules money and plays depend on. */
export const MONEY_AND_PLAYS = [
  'bookings',
  'delivery',
  'gst',
  'ledger',
  'makeups',
  'money',
  'moving-hours',
  'pay-zone',
  'plays',
  'portal-booking',
  'price-book',
  'rider-pay',
  'screen-reports',
].map((f) => `src/${f}.ts`);

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: MONEY_AND_PLAYS,
      reporter: ['text-summary'],
      thresholds: { perFile: true, lines: 85, branches: 80 },
    },
  },
});
