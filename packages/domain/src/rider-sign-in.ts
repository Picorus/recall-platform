// P4.1: rider sign-in. A rider signs in with his mobile number and a 6-digit code we send on
// WhatsApp (or by SMS); a new number starts his sign-up. Codes are short-lived and few, wrong tries
// are counted, and a signed-in phone stays signed in until he signs out or staff end it.

export interface RiderSignInRules {
  /** How long a code works (seconds). */
  readonly codeSeconds: number;
  /** Wrong tries before a code stops working (a new one must be asked for). */
  readonly triesPerCode: number;
  /** Codes one number may ask for in 15 minutes, and in a day (India day). */
  readonly codesPer15Min: number;
  readonly codesPerDay: number;
  /** Codes one address (a phone's connection) may ask for in an hour, for any numbers. */
  readonly codesPerAddressHour: number;
  /** Wrong codes one address may try in an hour, for any numbers. */
  readonly wrongPerAddressHour: number;
  /** A session ends by itself after this many days without use. */
  readonly idleDays: number;
}

export const DEFAULT_RIDER_SIGN_IN: RiderSignInRules = {
  codeSeconds: 600,
  triesPerCode: 5,
  codesPer15Min: 3,
  codesPerDay: 10,
  codesPerAddressHour: 30,
  wrongPerAddressHour: 50,
  idleDays: 90,
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
