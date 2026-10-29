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
  readonly bookedPaid: Wording;
  readonly adsMissing: Wording;
}
export type PayZone =
  | {
      readonly kind: 'circle';
      readonly centre: { readonly lat: number; readonly lng: number };
      readonly radiusM: number;
    }
  | { readonly kind: 'areas'; readonly areaIds: readonly string[]; readonly withEdge: boolean }
  /** Any area that is on (regular business, P1.7.5). */
  | { readonly kind: 'allAreas'; readonly withEdge: boolean };
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
  readonly maxBikesPerHour: number;
  readonly maxWeeks: number;
  readonly bookingsPerDay: number;
  readonly adUploadsPerDay: number;
  readonly questionsPerDay: number;
  readonly teamMax: number;
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
  ['maxBikesPerHour', 'Most bikes a brand may book each hour on the portal'],
  ['maxWeeks', 'Most weeks one portal booking may run'],
  ['bookingsPerDay', 'Bookings one person may make on the portal in a day'],
  ['adUploadsPerDay', 'Ad files one person may upload on the portal in a day'],
  ['questionsPerDay', 'Questions one person may send from the portal Help in a day'],
  ['teamMax', 'Most team members on one business'],
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
  /** P1.7.5: the rider pay zone while the POC runs, and in regular business. */
  readonly pocZone: PayZone;
  readonly regularZone: PayZone;
  readonly loanBank: LoanBank;
  readonly riderSignIn: RiderSignInRules;
  readonly brandSignIn: BrandSignInRules;
  readonly freeWeek: { readonly on: boolean };
  readonly company: {
    readonly legalName: string;
    readonly gstin: string;
    readonly address: string;
  };
  /** P7.8: the POC package. */
  readonly poc: PocRules;
}
export type SettingKey = keyof Settings;

/** P7.8: the POC package's numbers (a setting). */
export interface PocRules {
  readonly maxBrands: number;
  /** Paise, before GST. */
  readonly feePaise: number;
  readonly maxBikes: number;
  /** How long the POC is planned to run (alerts and the early-end guard), and the longest commitment. */
  readonly pocMonths: number;
}

/** Where the POC stands (P7.8): scheduled before its 1st, running, or ended by a super admin. */
export type PocPhase =
  | { readonly phase: 'none' }
  | {
      readonly phase: 'scheduled' | 'running' | 'ended';
      readonly startsAt: number;
      /** Planned: 08:00 India time on the 1st after its months. */
      readonly plannedEnd: number;
      readonly endedAt: number | null;
    };

export interface PocAlert {
  readonly kind: 'scheduled' | 'starts-today' | 'ends-soon' | 'months-over';
  readonly text: string;
}

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
  /** The business switch (P7.7.7): POC or regular business. */
  readonly business: BusinessSwitch;
}

export type BusinessMode = 'poc' | 'regular';

export interface BusinessSwitch {
  readonly mode: BusinessMode;
  /** A switch made that starts on a later day, or null. */
  readonly next: { readonly mode: BusinessMode; readonly from: number } | null;
  /** This person may switch now (a super admin, and the POC has not ended). */
  readonly canSwitch: boolean;
  readonly pocEnded: boolean;
  /** P7.8: where the POC stands, its planned months, and what super admins are told. */
  readonly poc: PocPhase;
  readonly pocMonths: number;
  readonly alerts: readonly PocAlert[];
  /** From when a switch made now would count: the POC from a 1st, regular from today 8 am. */
  readonly pocFrom: number;
  readonly regularFrom: number;
  readonly history: readonly {
    readonly mode: BusinessMode;
    readonly from: number;
    readonly setBy: string;
    readonly reason: string;
    readonly setAt: number;
    /** P7.8: a scheduled POC cancelled before it started (it counts for nothing). */
    readonly cancelled: {
      readonly by: string;
      readonly reason: string;
      readonly at: number;
    } | null;
  }[];
}

export const MODE_NAMES: Record<BusinessMode, string> = {
  poc: 'POC',
  regular: 'Regular business',
};

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
