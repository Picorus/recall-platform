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

export interface Settings {
  readonly cities: readonly City[];
  readonly fittingCentres: readonly FittingCentre[];
  readonly support: SupportSettings;
  readonly messages: MessageWordings;
  readonly payZone: PayZone;
  readonly loanBank: LoanBank;
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
