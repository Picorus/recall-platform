// Parts the brand and staff portals share (P7.7.6): the React parts run in the browser; the theme
// helpers also on the server. P7.7.7: small charts (server- and browser-safe) and their sums.
export { Fold, Info, Pointer, ThemeSwitch } from './client';
export { THEME_COOKIE, themeAttr, type ThemeChoice } from './theme';
export { BarChart, LineChart, Meter, Sparkline, type ChartPoint } from './charts';
export {
  businessDay,
  compactIndian,
  daysOfMonth,
  dayLabel,
  foldHint,
  hourLabel,
  indiaDate,
  indiaMonthOf,
  labelEvery,
  latestOf,
  monthLabel,
  monthsBetween,
  niceTicks,
  peak,
  position,
  rupeesShort,
  sumByIndiaDay,
  sumByIndiaMonth,
  type Ticks,
} from './chart-math';
