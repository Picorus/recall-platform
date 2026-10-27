// Money and dates as the portal shows them (India: ₹ with lakh grouping; dates in India time).

/** "₹1,23,456" from paise (whole rupees; paise shown only when there are any). */
export function rupees(paise: number): string {
  const neg = paise < 0;
  const p = Math.abs(Math.round(paise));
  const r = Math.floor(p / 100);
  const ps = p % 100;
  const s = String(r);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const whole = rest ? `${rest},${last3}` : last3;
  return `${neg ? '−' : ''}₹${whole}${ps ? `.${String(ps).padStart(2, '0')}` : ''}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 10 Sep 2027" from "2027-09-10". */
export function dayText(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "10–16 Sep 2027", "28 Sep – 4 Oct 2027" or one day. */
export function daysText(first: string, last: string): string {
  if (first === last) return dayText(first);
  const a = new Date(`${first}T00:00:00Z`);
  const b = new Date(`${last}T00:00:00Z`);
  const sameMonth =
    a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const end = `${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  if (sameMonth) return `${a.getUTCDate()}–${end}`;
  return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}${sameYear ? '' : ` ${a.getUTCFullYear()}`} – ${end}`;
}
