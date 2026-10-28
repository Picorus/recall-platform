// What the sign-in page needs to decide before asking the API: is it a number or an email, and is
// the code typed whole. The API checks everything again.

export type Way = 'phone' | 'email';

/** A 10-digit India mobile number as typed (spaces, dashes, +91 or 0 in front allowed). */
export function looksLikeMobile(typed: string): boolean {
  return /^(?:\+91|0091|91|0)?[6-9]\d{9}$/.test(typed.replace(/[\s\-().]/g, ''));
}

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

/** An email address as typed (spaces around it, or next to "@" and ".", allowed). */
export function looksLikeEmail(typed: string): boolean {
  return /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/.test(
    typed.trim().replace(/\s*([@.])\s*/g, '$1'),
  );
}

/** A 6-digit code (spaces allowed). */
export function looksLikeCode(typed: string): boolean {
  return /^\d{6}$/.test(typed.replace(/\s/g, ''));
}

/** The code box as it is typed or pasted ("123 456", " 123456 "): its digits, at most 6. */
export const codeAsTyped = (typed: string): string => typed.replace(/\D/g, '').slice(0, 6);

/** "4:05" left of a code's life, from seconds; "0:00" once it has run out. */
export function timeLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where to go after signing in (P5.7: the report link in the "Done" message): a page of this site
 * only, never another site ("//evil", "/\\evil", "https:…"); else the start page. */
export function backTo(next: string | null): string {
  return next && /^\/(?![/\\])[A-Za-z0-9/_?=&%.-]{0,300}$/.test(next) ? next : '/';
}
