// P3.17: what the Settings page reads (GET /settings).

export interface City {
  readonly name: string;
}
export interface FittingCentre {
  readonly name: string;
  readonly address: string;
  readonly on: boolean;
}
export interface SupportPhone {
  readonly label: string;
  readonly phone: string;
  readonly whatsapp: boolean;
}
export interface SupportSettings {
  readonly phones: readonly SupportPhone[];
  readonly days: readonly number[];
  readonly opens: string;
  readonly closes: string;
}
export interface Wording {
  readonly whatsappTemplate: string;
  readonly emailSubject: string;
  readonly emailText: string;
}
export interface MessageWordings {
  readonly supportReply: Wording;
  readonly reportReady: Wording;
}
export type PayZone =
  | {
      readonly kind: 'circle';
      readonly centre: { readonly lat: number; readonly lng: number };
      readonly radiusM: number;
    }
  | { readonly kind: 'areas'; readonly areaIds: readonly string[]; readonly withEdge: boolean };
export interface LoanBank {
  readonly name: string;
}

export interface RiderSignInRules {
  readonly codeSeconds: number;
  readonly triesPerCode: number;
  readonly codesPer15Min: number;
  readonly codesPerDay: number;
  readonly wrongPerNumberDay: number;
  readonly codesPerAddressHour: number;
  readonly wrongPerAddressHour: number;
  readonly codesPerHourAll: number;
  readonly idleDays: number;
  readonly checksPerRiderDay: number;
  readonly checksPerDayAll: number;
  readonly uploadsPerRiderDay: number;
  readonly fitEarlyMinutes: number;
  readonly fitLateMinutes: number;
  readonly fittingChecksPerDay: number;
  readonly alertOfflineMinutes: number;
  readonly alertBatteryPct: number;
}

export interface BrandSignInRules {
  readonly codeSeconds: number;
  readonly triesPerCode: number;
  readonly codesPer15Min: number;
  readonly codesPerDay: number;
  readonly wrongPerNumberDay: number;
  readonly codesPerAddressHour: number;
  readonly wrongPerAddressHour: number;
  readonly codesPerHourAll: number;
  readonly idleDays: number;
  readonly gstLookupsPerDay: number;
  readonly businessesPerDay: number;
}

/** What each brand sign-in rule means, in the order shown (P5.1). */
export const BRAND_SIGN_IN_LABELS: readonly (readonly [keyof BrandSignInRules, string])[] = [
  ['codeSeconds', 'A code works for (seconds)'],
  ['triesPerCode', 'Wrong tries for one code'],
  ['codesPer15Min', 'Codes for one number or email from one connection in 15 minutes'],
  ['codesPerDay', 'Codes for one number or email in a day'],
  ['wrongPerNumberDay', 'Wrong codes for one number or email in a day'],
  ['codesPerAddressHour', 'Codes from one connection in an hour'],
  ['wrongPerAddressHour', 'Wrong codes from one connection in an hour'],
  ['codesPerHourAll', 'Codes for everyone together in an hour'],
  ['idleDays', 'Signed out after this many days unused (at most 90)'],
  ['gstLookupsPerDay', 'GST numbers one person may look up in a day'],
  ['businessesPerDay', 'Businesses one person may set up in a day'],
];

/** What each rider sign-in rule means, in the order shown. */
export const RIDER_SIGN_IN_LABELS: readonly (readonly [keyof RiderSignInRules, string])[] = [
  ['codeSeconds', 'A code works for (seconds)'],
  ['triesPerCode', 'Wrong tries for one code'],
  ['codesPer15Min', 'Codes for one number from one connection in 15 minutes'],
  ['codesPerDay', 'Codes for one number in a day'],
  ['wrongPerNumberDay', 'Wrong codes for one number in a day'],
  ['codesPerAddressHour', 'Codes from one connection in an hour'],
  ['wrongPerAddressHour', 'Wrong codes from one connection in an hour'],
  ['codesPerHourAll', 'Codes for everyone together in an hour'],
  ['idleDays', 'Signed out after this many days unused'],
  ['checksPerRiderDay', 'ID, agreement or bank checks one rider may start in a day'],
  ['checksPerDayAll', 'Checks started from the app in a day, everyone together'],
  ['uploadsPerRiderDay', 'Pictures one rider may send in a day'],
  ['fitEarlyMinutes', 'Minutes before his fitting slot the app can fit his screen'],
  ['fitLateMinutes', 'Minutes after his fitting slot ends the app can still fit it'],
  ['fittingChecksPerDay', 'Fitting checks one rider may start in a day'],
  ['alertOfflineMinutes', 'Minutes a fitted screen may be silent before its rider is told'],
  ['alertBatteryPct', 'Screen battery (%) at which its rider is told to charge'],
];

export interface Settings {
  readonly cities: readonly City[];
  readonly fittingCentres: readonly FittingCentre[];
  readonly support: SupportSettings;
  readonly messages: MessageWordings;
  readonly payZone: PayZone;
  readonly loanBank: LoanBank;
  readonly riderSignIn: RiderSignInRules;
  readonly brandSignIn: BrandSignInRules;
  readonly freeWeek: { readonly on: boolean };
}
export type SettingKey = keyof Settings;

export interface SettingRecord<K extends SettingKey> {
  readonly value: Settings[K];
  /** 0: the default, never saved. */
  readonly version: number;
  readonly savedBy: string | null;
  readonly savedAt: number | null;
  readonly reason: string | null;
}

export interface Connection {
  readonly service: string;
  readonly state: 'on' | 'stand-in' | 'off';
  readonly provider: string;
}

export interface SettingsPage {
  readonly at: number;
  readonly settings: { readonly [K in SettingKey]: SettingRecord<K> };
  readonly canChange: boolean;
  readonly supportOpen: boolean;
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  readonly roles: readonly string[];
  readonly staffAreas: readonly string[];
  readonly connections: readonly Connection[];
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
