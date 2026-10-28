// How the admin site writes numbers, money and times: India time, rupees with Indian grouping.

const IST = 'Asia/Kolkata';

/** A code, number or id as typed or pasted, without spaces ("SBIN 0001234 " → "SBIN0001234"). */
export const noSpaces = (text: string): string => text.replace(/\s/g, '');

/**
 * The same as groupMobile in @recall/domain (a test checks they agree). A mobile number as it is
 * typed, grouped so it reads easily: "9848000001" → "98480 00001",
 * "+919848000001" → "+91 98480 00001". Only for showing in the box: what is sent is read again
 * (spaces dropped), so the grouping never changes the number.
 */
export function groupMobile(typed: string): string {
  let digits = typed.replace(/\D/g, '');
  let lead: string;
  if (/^\s*\+/.test(typed)) {
    lead = `+${digits.slice(0, 2)}`;
    digits = digits.slice(2);
  } else {
    lead = /^(0091|91|0)(?=\d{10}$)/.exec(digits)?.[1] ?? '';
    digits = digits.slice(lead.length);
  }
  const num = digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  return [lead, num].filter((x) => x !== '').join(' ');
}

/** The same as regroupMobile in @recall/domain (a test checks they agree). */
export function regroupMobile(typed: string, before = ''): string {
  const digits = (t: string) => t.replace(/\D/g, '');
  if (typed.length < before.length && digits(typed) === digits(before)) {
    let i = 0;
    while (i < typed.length && typed[i] === before[i]) i++;
    const k = digits(before.slice(0, i)).length;
    if (k > 0) {
      const d = digits(before);
      typed = `${/^\s*\+/.test(before) ? '+' : ''}${d.slice(0, k - 1)}${d.slice(k)}`;
    }
  }
  return groupMobile(typed);
}

/** The same as codeFromTyped in @recall/domain (a test checks they agree): "482 915" or a pasted
 * message ("Valid 10 min: 482915") → "482915"; while typing, its digits, at most 6. */
export function sixDigits(typed: string): string {
  const whole = /(?<!\d)\d(?:[ -]?\d){5}(?![ -]?\d)/.exec(typed);
  return (whole?.[0] ?? typed).replace(/\D/g, '').slice(0, 6);
}

/** For a box not tied to state that takes a code or id: `tidy` runs as it is typed or pasted. */
export const tidyBox =
  (tidy: (text: string, before: string) => string) =>
  (e: {
    readonly currentTarget: {
      value: string;
      readonly defaultValue: string;
      readonly dataset: Record<string, string | undefined>;
    };
  }): void => {
    const box = e.currentTarget;
    // What the box held before this edit (for regroupMobile's backspace).
    const v = tidy(box.value, box.dataset.was ?? box.defaultValue);
    if (v !== box.value) box.value = v;
    box.dataset.was = v;
  };

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
