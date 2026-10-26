// How the admin site writes numbers, money and times: India time, rupees with Indian grouping.

const IST = 'Asia/Kolkata';

/** "₹1,35,000" or "₹225.50" from whole paise (never a float on the way). */
export function rupees(paise: number): string {
  const neg = paise < 0;
  const p = Math.abs(Math.trunc(paise));
  const whole = Math.floor(p / 100);
  const rest = p % 100;
  const s = String(whole);
  const last3 = s.slice(-3);
  const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${head},${last3}` : last3;
  return `${neg ? '−' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** "18:30" in India time, from UTC seconds. */
export function clock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Mon 23 Aug" from a business day "2027-08-23" (built by hand: browsers differ on commas). */
export function dayName(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][at.getUTCDay()] ?? '';
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${week} ${at.getUTCDate()} ${month[at.getUTCMonth()] ?? ''}`;
}

/** "4 min", "2 h 5 min", "3 days" between two times in seconds. */
export function since(fromSeconds: number, nowSeconds: number): string {
  const min = Math.max(0, Math.floor((nowSeconds - fromSeconds) / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** Whole numbers with Indian grouping: "15,500", "1,00,000". */
export function count(n: number): string {
  return rupees(n * 100).slice(1);
}

export const ALERT_NAMES: Record<string, string> = {
  overheating: 'Overheating',
  'low-battery': 'Low battery',
  tamper: 'Tamper',
  'led-fault': 'LED fault',
  'low-storage': 'Low storage',
  'no-contact': 'No contact',
};

/** "Tue 24 Aug": the India-time date of a moment (UTC seconds). */
export function dayOfIndia(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', {
    timeZone: IST,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
