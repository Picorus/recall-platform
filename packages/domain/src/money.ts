// Hard rule 2: money is whole paise (1 rupee = 100 paise). Never floats.

declare const paiseBrand: unique symbol;
export type Paise = number & { readonly [paiseBrand]: true };

/** Wraps a whole number of paise. Throws on fractions, NaN or numbers too big to be exact. */
export function paise(amount: number): Paise {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Paise must be a whole number within safe range, got ${amount}`);
  }
  return amount as Paise;
}

export function addPaise(...amounts: Paise[]): Paise {
  let total = paise(0);
  for (const amount of amounts) {
    total = paise(total + amount); // checked at every step, so nothing rounds mid-sum
  }
  return total;
}

export function subtractPaise(from: Paise, amount: Paise): Paise {
  return paise(from - amount);
}

// Whole rupees: plain digits, Indian grouping (1,23,456) or Western grouping (123,456). No leading zeros.
const WHOLE_RUPEES = String.raw`0|[1-9]\d*|[1-9]\d?(?:,\d{2})*,\d{3}|[1-9]\d{0,2}(?:,\d{3})+`;
const RUPEES_PATTERN = new RegExp(String.raw`^(-)?(?:₹ ?)?(${WHOLE_RUPEES})(?:\.(\d{1,2}))?$`);

/**
 * Reads a rupee amount typed by a person, e.g. "15000", "₹15,000.5", "-₹1,23,456.78".
 * Works on the text itself, so no float rounding ever happens.
 */
export function parseRupees(text: string): Paise {
  const match = RUPEES_PATTERN.exec(text.trim());
  if (!match) {
    throw new RangeError(`Not a rupee amount: "${text}"`);
  }
  const [, minus, whole = '0', fraction = ''] = match;
  const value = BigInt(whole.replaceAll(',', '')) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Rupee amount too large: "${text}"`);
  }
  return paise(minus && value !== 0n ? -Number(value) : Number(value));
}

/** Shows paise as rupees with Indian digit grouping: 12345678 → "₹1,23,456.78". */
export function formatRupees(amount: Paise): string {
  paise(amount); // refuses anything that slipped past the type, e.g. a cast 0.5
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const whole = String(Math.trunc(abs / 100));
  const fraction = String(abs % 100).padStart(2, '0');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}
