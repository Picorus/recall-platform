// What the sign-in page needs to decide before asking the API: is it a number or an email, and is
// the code typed whole. The API checks everything again.

export type Way = 'phone' | 'email';

/** A 10-digit India mobile number as typed (spaces, dashes, +91 or 0 in front allowed). */
export function looksLikeMobile(typed: string): boolean {
  return /^(?:\+91|0091|91|0)?[6-9]\d{9}$/.test(typed.replace(/[\s\-().]/g, ''));
}

/** An email address as typed. */
export function looksLikeEmail(typed: string): boolean {
  return /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/.test(typed.trim());
}

/** A 6-digit code (spaces allowed). */
export function looksLikeCode(typed: string): boolean {
  return /^\d{6}$/.test(typed.replace(/\s/g, ''));
}

/** "4:05" left of a code's life, from seconds; "0:00" once it has run out. */
export function timeLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
