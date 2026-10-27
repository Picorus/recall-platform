// P5.1: sign-in on the brand portal. A person signs in with a mobile number (a 6-digit code on
// WhatsApp, or by SMS) or an email address (the code by email; agencies mostly use email). The code
// is short-lived, few are sent and wrong tries are counted, as for riders (P4.1). A signed-in person
// sees the brands and agencies they belong to; a new person sets up their business next (P5.2).

export interface BrandSignInRules {
  /** How long a code works (seconds). */
  readonly codeSeconds: number;
  /** Wrong tries before a code stops working (a new one must be asked for). */
  readonly triesPerCode: number;
  /** Codes one connection may ask for one number or email in 15 minutes. */
  readonly codesPer15Min: number;
  /** Codes one number or email may get in a day (India day), from anywhere. */
  readonly codesPerDay: number;
  /** Wrong codes typed for one number or email in a day, from anywhere, against a live code. */
  readonly wrongPerNumberDay: number;
  /** Codes one connection may ask for in an hour, for any numbers or emails. */
  readonly codesPerAddressHour: number;
  /** Wrong codes one connection may try in an hour. */
  readonly wrongPerAddressHour: number;
  /** Codes sent in an hour for everyone together (a brake on message costs). */
  readonly codesPerHourAll: number;
  /** A session ends by itself after this many days without use. */
  readonly idleDays: number;
  /** P5.2: GST numbers one person may look up in a day (each lookup costs). */
  readonly gstLookupsPerDay: number;
  /** P5.2: businesses one person may set up in a day. */
  readonly businessesPerDay: number;
}

export const DEFAULT_BRAND_SIGN_IN: BrandSignInRules = {
  codeSeconds: 600,
  triesPerCode: 5,
  codesPer15Min: 3,
  codesPerDay: 20,
  wrongPerNumberDay: 15,
  codesPerAddressHour: 30,
  wrongPerAddressHour: 50,
  codesPerHourAll: 1000,
  idleDays: 30,
  gstLookupsPerDay: 20,
  businessesPerDay: 3,
};

/** Each rule's sensible range (checked when a super admin changes them in Settings). */
export const BRAND_SIGN_IN_RANGES: Readonly<
  Record<keyof BrandSignInRules, readonly [number, number]>
> = {
  codeSeconds: [120, 1800],
  triesPerCode: [1, 10],
  codesPer15Min: [1, 10],
  codesPerDay: [3, 100],
  wrongPerNumberDay: [5, 100],
  codesPerAddressHour: [5, 1000],
  wrongPerAddressHour: [5, 1000],
  codesPerHourAll: [10, 100_000],
  idleDays: [1, 90],
  gstLookupsPerDay: [3, 200],
  businessesPerDay: [1, 20],
};

export type BrandCodeChannel = 'whatsapp' | 'sms' | 'email';

/**
 * An email address as typed, trimmed and in small letters ("Media@Agency.in " → "media@agency.in"),
 * or null when it is not one. The same shape brand contacts are kept in.
 */
export function emailAddress(typed: string): string | null {
  const e = typed.trim().toLowerCase();
  return e.length <= 254 && /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$/.test(e) ? e : null;
}

/** The email that carries a sign-in code. */
export function brandCodeEmail(
  code: string,
  minutes = 10,
): { subject: string; text: string; html: string } {
  const text = `Your RECALL sign-in code is ${code}. It works for ${minutes} minutes. Do not share it with anyone: RECALL will never ask you for it.\n\nIf you did not ask for this code, you can ignore this email.`;
  return {
    subject: `${code} is your RECALL sign-in code`,
    text,
    html: `<p>Your RECALL sign-in code is <b style="font-size:20px;letter-spacing:2px">${code}</b>.</p><p>It works for ${minutes} minutes. Do not share it with anyone: RECALL will never ask you for it.</p><p>If you did not ask for this code, you can ignore this email.</p>`,
  };
}

/** The SMS that carries a sign-in code (English: the brand portal is in English). */
export function brandCodeSms(code: string, minutes = 10): string {
  return `${code} is your RECALL sign-in code. It works for ${minutes} minutes. Do not share it.`;
}

/** What a person may do for an account on the portal (P5.9 sets who is who). */
export const BRAND_MEMBER_ROLES = ['owner', 'booker'] as const;
export type BrandMemberRole = (typeof BRAND_MEMBER_ROLES)[number];
