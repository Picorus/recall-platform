// P4.1: rider sign-in. A rider signs in with his mobile number and a 6-digit code we send on
// WhatsApp (or by SMS); a new number starts his sign-up. Codes are short-lived and few, wrong tries
// are counted, and a signed-in phone stays signed in until he signs out or staff end it.

export interface RiderSignInRules {
  /** How long a code works (seconds). */
  readonly codeSeconds: number;
  /** Wrong tries before a code stops working (a new one must be asked for). */
  readonly triesPerCode: number;
  /**
   * Codes one connection may ask for one number in 15 minutes (counted per connection, so a
   * stranger asking for a rider's codes elsewhere does not stop his own).
   */
  readonly codesPer15Min: number;
  /** Codes one number may get in a day (India day), from anywhere. */
  readonly codesPerDay: number;
  /** Wrong codes typed for one number in a day, from anywhere, against a live code (slow guessing across connections). */
  readonly wrongPerNumberDay: number;
  /** Codes one connection may ask for in an hour, for any numbers. */
  readonly codesPerAddressHour: number;
  /** Wrong codes one connection may try in an hour, for any numbers. */
  readonly wrongPerAddressHour: number;
  /** Codes sent in an hour for everyone together (a brake on message costs). */
  readonly codesPerHourAll: number;
  /** A session ends by itself after this many days without use. */
  readonly idleDays: number;
  /** P4.2: ID, agreement or bank checks one rider may start in a day from the app (each costs). */
  readonly checksPerRiderDay: number;
  /** P4.2: checks started from the app in a day, everyone together (a brake on costs). */
  readonly checksPerDayAll: number;
  /** P4.2: pictures one rider may send in a day from the app. */
  readonly uploadsPerRiderDay: number;
  /** P4.3: a screen can be fitted from the app from this many minutes before his slot starts… */
  readonly fitEarlyMinutes: number;
  /** P4.3: …until this many minutes after it ends (only then, so a QR seen elsewhere is no use). */
  readonly fitLateMinutes: number;
  /** P4.3: fitting checks one rider may start in a day (each lights the screen and waits on it). */
  readonly fittingChecksPerDay: number;
  /** P4.10: a fitted screen not heard from this long in business hours: the rider is told. */
  readonly alertOfflineMinutes: number;
  /** P4.10: a screen battery at or below this (and not charging): the rider is told, once a day. */
  readonly alertBatteryPct: number;
}

export const DEFAULT_RIDER_SIGN_IN: RiderSignInRules = {
  codeSeconds: 600,
  triesPerCode: 5,
  codesPer15Min: 3,
  codesPerDay: 20,
  wrongPerNumberDay: 15,
  codesPerAddressHour: 30,
  wrongPerAddressHour: 50,
  codesPerHourAll: 2000,
  idleDays: 90,
  checksPerRiderDay: 3,
  checksPerDayAll: 500,
  uploadsPerRiderDay: 20,
  fitEarlyMinutes: 30,
  fitLateMinutes: 120,
  fittingChecksPerDay: 10,
  alertOfflineMinutes: 30,
  alertBatteryPct: 20,
};

/** Each rule's sensible range (checked when a super admin changes them in Settings). */
export const RIDER_SIGN_IN_RANGES: Readonly<
  Record<keyof RiderSignInRules, readonly [number, number]>
> = {
  codeSeconds: [120, 1800],
  triesPerCode: [1, 10],
  codesPer15Min: [1, 10],
  codesPerDay: [3, 100],
  wrongPerNumberDay: [5, 100],
  codesPerAddressHour: [5, 1000],
  wrongPerAddressHour: [5, 1000],
  codesPerHourAll: [10, 100_000],
  idleDays: [1, 365],
  checksPerRiderDay: [1, 20],
  checksPerDayAll: [10, 100_000],
  uploadsPerRiderDay: [3, 200],
  fitEarlyMinutes: [0, 240],
  fitLateMinutes: [0, 720],
  fittingChecksPerDay: [1, 50],
  alertOfflineMinutes: [10, 240],
  alertBatteryPct: [5, 50],
};

export const RIDER_LANGUAGES = ['te', 'hi', 'en'] as const;
export type RiderLanguage = (typeof RIDER_LANGUAGES)[number];

export type CodeChannel = 'whatsapp' | 'sms';

/**
 * An India mobile number as typed ("98480 12345", "+91-98480-12345", "098480 12345") as
 * "+919848012345", or null if it is not one.
 */
export function indiaMobile(typed: string): string | null {
  const digits = typed.replace(/[\s\-().]/g, '');
  const m = /^(?:\+91|0091|91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

/** A code as typed: exactly 6 digits (spaces allowed), or null. */
export function typedCode(typed: string): string | null {
  const c = typed.replace(/\s/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

/** The number shown back to the rider: "+91 98480 12345". */
export function showMobile(phone: string): string {
  return /^\+91\d{10}$/.test(phone) ? `+91 ${phone.slice(3, 8)} ${phone.slice(8)}` : phone;
}

/** The SMS that carries a sign-in code, in the rider's language. */
export function riderCodeSms(language: RiderLanguage, code: string, minutes = 10): string {
  switch (language) {
    case 'te':
      return `${code} మీ RECALL కోడ్. ఇది ${minutes} నిమిషాలు పనిచేస్తుంది. దీన్ని ఎవరికీ చెప్పకండి.`;
    case 'hi':
      return `${code} आपका RECALL कोड है। यह ${minutes} मिनट तक काम करेगा। इसे किसी को न बताएं।`;
    default:
      return `${code} is your RECALL code. It works for ${minutes} minutes. Do not share it with anyone.`;
  }
}
