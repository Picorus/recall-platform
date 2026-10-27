// P3.17: the settings a super admin changes in the admin portal (each saved as a new version, with
// who and why; nothing overwritten). Prices, offers and rider pay rates are the price book's; staff
// and roles are the Staff page's; keys to outside services live in the secret store, never here.
import { INDIA_OFFSET_MINUTES } from './time.js';
import { POC_PAY_ZONE, type PayZone } from './pay-zone.js';
import {
  DEFAULT_RIDER_SIGN_IN,
  RIDER_SIGN_IN_RANGES,
  type RiderSignInRules,
} from './rider-sign-in.js';

/** A city RECALL works in (an area belongs to one). */
export interface City {
  readonly name: string;
}

/** Where screens are fitted and taken off. Never removed once added: switched off instead. */
export interface FittingCentre {
  readonly name: string;
  readonly address: string;
  readonly on: boolean;
}

export interface SupportPhone {
  /** What it is for, e.g. "Riders" or "Brands". */
  readonly label: string;
  /** +91 and 10 digits. */
  readonly phone: string;
  readonly whatsapp: boolean;
}

export interface SupportSettings {
  readonly phones: readonly SupportPhone[];
  /** Days support is open: 1 Monday … 7 Sunday. */
  readonly days: readonly number[];
  /** India time "HH:MM". */
  readonly opens: string;
  readonly closes: string;
}

/**
 * The wording of a message we send. WhatsApp only sends templates the provider has approved, so for
 * WhatsApp it is the approved template's name (its words are set with the provider, taking the
 * same values in the same order); email wording is ours, with {placeholders}.
 */
export interface Wording {
  readonly whatsappTemplate: string;
  readonly emailSubject: string;
  readonly emailText: string;
}

export interface MessageWordings {
  /** A support reply. Placeholders: {reply} (needed in the text), {subject}. */
  readonly supportReply: Wording;
  /** A campaign report is ready. Placeholders: {booking}, {period}, {summary}, {link} (needed). */
  readonly reportReady: Wording;
}

/** The bank that lends riders the money for a screen (the loan is between the rider and the bank). */
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
  /** P4.1: how rider sign-in codes are limited. */
  readonly riderSignIn: RiderSignInRules;
}

export type SettingKey = keyof Settings;

export const SETTING_KEYS = [
  'cities',
  'fittingCentres',
  'support',
  'messages',
  'payZone',
  'loanBank',
  'riderSignIn',
] as const satisfies readonly SettingKey[];

/** Placeholders each wording may use, and the ones its email text must have. */
export const WORDING_PLACEHOLDERS = {
  supportReply: { may: ['reply', 'subject'], must: ['reply'] },
  reportReady: { may: ['booking', 'period', 'summary', 'link'], must: ['link'] },
} as const satisfies Record<
  keyof MessageWordings,
  { may: readonly string[]; must: readonly string[] }
>;

/** Until a super admin saves one: Prateek's answers of 22 Oct 2026 and today's wording. */
export const DEFAULT_SETTINGS: Settings = {
  cities: [{ name: 'Hyderabad' }],
  // Their addresses are still to come (Prateek, 22 Oct 2026): added here when known.
  fittingCentres: [],
  // 10 am to 7 pm (Prateek, 22 Oct 2026); numbers added when the lines are set up.
  support: { phones: [], days: [1, 2, 3, 4, 5, 6, 7], opens: '10:00', closes: '19:00' },
  messages: {
    supportReply: {
      whatsappTemplate: 'support_reply',
      emailSubject: 'Re: {subject}',
      emailText: '{reply}\n\nRECALL support',
    },
    reportReady: {
      whatsappTemplate: 'campaign_report_ready',
      emailSubject: 'Your RECALL campaign report: {booking} ({period})',
      emailText: '{summary}\n\nSee the full report: {link}',
    },
  },
  payZone: POC_PAY_ZONE,
  loanBank: { name: 'Dhanlaxmi Bank' },
  riderSignIn: DEFAULT_RIDER_SIGN_IN,
};

/** Fills {placeholders} (unknown ones are left as written; checkSetting refuses them on save). */
export function fillWording(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-z]+)\}/g, (all, k: string) => values[k] ?? all);
}

const fail = (why: string): never => {
  throw new RangeError(why);
};
const obj = (v: unknown, what: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail(`${what}: not filled in`);
const list = (v: unknown, what: string, max: number): unknown[] => {
  if (!Array.isArray(v)) return fail(`${what}: not a list`);
  if (v.length > max) fail(`${what}: at most ${max}`);
  return v;
};
const text = (v: unknown, what: string, min: number, max: number): string => {
  if (typeof v !== 'string') return fail(`${what}: missing`);
  const t = v.trim();
  if (t.length < min || t.length > max) fail(`${what}: ${min} to ${max} letters`);
  // Control characters, and the invisible ones that make text look like other text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(t))
    fail(`${what}: has a hidden character`);
  return t;
};
const oneLine = (v: unknown, what: string, min: number, max: number): string => {
  const t = text(v, what, min, max);
  if (/[\r\n]/.test(t)) fail(`${what}: one line only`);
  return t;
};
const unique = (names: readonly string[], what: string) => {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n.toLowerCase())) fail(`${what}: "${n}" is there twice`);
    seen.add(n.toLowerCase());
  }
};
const time = (v: unknown, what: string): string => {
  const t = typeof v === 'string' ? v : '';
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? t : fail(`${what}: a time like 10:00`);
};

function wording(v: unknown, key: keyof MessageWordings, what: string): Wording {
  const o = obj(v, what);
  const whatsappTemplate = oneLine(o.whatsappTemplate, `${what}, WhatsApp template`, 1, 60);
  if (!/^[a-z0-9_]+$/.test(whatsappTemplate))
    fail(`${what}, WhatsApp template: the approved name (small letters, digits and _)`);
  const emailSubject = oneLine(o.emailSubject, `${what}, email subject`, 2, 150);
  const emailText = text(o.emailText, `${what}, email text`, 2, 2000);
  const { may, must } = WORDING_PLACEHOLDERS[key];
  for (const [part, t] of [
    ['subject', emailSubject],
    ['text', emailText],
  ] as const) {
    // A brace not part of a known {placeholder} would be sent as written: refused.
    for (const m of t.matchAll(/\{([^{}]*)\}|[{}]/g))
      if (m[1] === undefined || !(may as readonly string[]).includes(m[1]))
        fail(
          `${what}, email ${part}: "${m[0]}" is not one of ${may.map((p) => `{${p}}`).join(', ')}`,
        );
  }
  for (const p of must)
    if (!emailText.includes(`{${p}}`)) fail(`${what}, email text: must have {${p}}`);
  return { whatsappTemplate, emailSubject, emailText };
}

function payZone(v: unknown): PayZone {
  const o = obj(v, 'Pay zone');
  if (o.kind === 'circle') {
    const c = obj(o.centre, 'Pay zone centre');
    const lat = c.lat;
    const lng = c.lng;
    // Inside India.
    if (typeof lat !== 'number' || !(lat >= 6 && lat <= 37))
      fail('Pay zone centre: latitude 6 to 37 (India)');
    if (typeof lng !== 'number' || !(lng >= 68 && lng <= 98))
      fail('Pay zone centre: longitude 68 to 98 (India)');
    const r = o.radiusM;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 1000 || r > 100_000)
      fail('Pay zone: a radius of 1 to 100 km, in whole metres');
    return {
      kind: 'circle',
      centre: { lat: lat as number, lng: lng as number },
      radiusM: r as number,
    };
  }
  if (o.kind === 'areas') {
    const ids = list(o.areaIds, 'Pay zone areas', 200).map((x) =>
      typeof x === 'string' && /^[a-z0-9-]{2,60}$/.test(x) ? x : fail('Pay zone: an area id'),
    );
    if (ids.length === 0) fail('Pay zone: pick at least one area');
    unique(ids, 'Pay zone areas');
    if (typeof o.withEdge !== 'boolean') fail('Pay zone: count the edge zone or not');
    return { kind: 'areas', areaIds: ids, withEdge: o.withEdge as boolean };
  }
  return fail('Pay zone: a circle or a list of areas');
}

/** Checks a setting's new value (as typed or sent) and returns it cleaned; throws why not. */
export function checkSetting<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  const v = ((): Settings[SettingKey] => {
    switch (key) {
      case 'cities': {
        const cities = list(value, 'Cities', 50).map((c) => ({
          name: oneLine(obj(c, 'City').name, 'City name', 2, 80),
        }));
        if (cities.length === 0) fail('Cities: at least one');
        unique(
          cities.map((c) => c.name),
          'Cities',
        );
        return cities;
      }
      case 'fittingCentres': {
        const centres = list(value, 'Fitting centres', 100).map((x) => {
          const c = obj(x, 'Fitting centre');
          if (typeof c.on !== 'boolean') fail('Fitting centre: on or off');
          return {
            name: oneLine(c.name, 'Fitting centre name', 2, 80),
            address: text(c.address, 'Fitting centre address', 5, 300),
            on: c.on as boolean,
          };
        });
        unique(
          centres.map((c) => c.name),
          'Fitting centres',
        );
        return centres;
      }
      case 'support': {
        const s = obj(value, 'Support');
        const phones = list(s.phones, 'Support numbers', 10).map((x) => {
          const p = obj(x, 'Support number');
          const phone = typeof p.phone === 'string' ? p.phone.replace(/[\s-]/g, '') : '';
          if (!/^\+91[6-9]\d{9}$/.test(phone)) fail('Support number: +91 and 10 digits');
          if (typeof p.whatsapp !== 'boolean') fail('Support number: on WhatsApp or not');
          return {
            label: oneLine(p.label, 'Support number, what for', 2, 40),
            phone,
            whatsapp: p.whatsapp as boolean,
          };
        });
        unique(
          phones.map((p) => p.phone),
          'Support numbers',
        );
        const days = list(s.days, 'Support days', 7).map((d) =>
          typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 7
            ? d
            : fail('Support days: 1 Monday to 7 Sunday'),
        );
        if (days.length === 0) fail('Support days: at least one');
        if (new Set(days).size !== days.length) fail('Support days: a day is there twice');
        const opens = time(s.opens, 'Support opens');
        const closes = time(s.closes, 'Support closes');
        if (closes <= opens) fail('Support closes after it opens (the same day)');
        return { phones, days: [...days].sort((a, b) => a - b), opens, closes };
      }
      case 'messages': {
        const m = obj(value, 'Message wording');
        return {
          supportReply: wording(m.supportReply, 'supportReply', 'Support reply'),
          reportReady: wording(m.reportReady, 'reportReady', 'Report ready'),
        };
      }
      case 'payZone':
        return payZone(value);
      case 'loanBank':
        return { name: oneLine(obj(value, 'Screen-loan bank').name, 'Bank name', 2, 80) };
      case 'riderSignIn': {
        const o = obj(value, 'Rider sign-in');
        const out: Record<string, number> = {};
        for (const [k, [lo, hi]] of Object.entries(RIDER_SIGN_IN_RANGES)) {
          const n = o[k];
          if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi)
            fail(`Rider sign-in, ${k}: a whole number ${lo} to ${hi}`);
          out[k] = n as number;
        }
        return out as unknown as RiderSignInRules;
      }
      default:
        return fail('Which setting?');
    }
  })();
  return v as Settings[K];
}

/**
 * A change that would lose something in use: a city or fitting centre once added is never removed
 * (switch a centre off instead), so old areas and slots always find theirs.
 */
export function checkSettingChange<K extends SettingKey>(
  key: K,
  before: Settings[K],
  after: Settings[K],
): void {
  if (key === 'cities' || key === 'fittingCentres') {
    const now = new Set((after as readonly { name: string }[]).map((x) => x.name));
    for (const x of before as readonly { name: string }[])
      if (!now.has(x.name))
        fail(
          key === 'cities'
            ? `${x.name} cannot be removed (areas may use it)`
            : `${x.name} cannot be removed: switch it off instead`,
        );
  }
}

/** Whether support is open at this instant (UTC seconds), by its days and hours in India time. */
export function supportOpenAt(s: SupportSettings, at: number): boolean {
  const india = new Date((at + INDIA_OFFSET_MINUTES * 60) * 1000);
  const day = india.getUTCDay() === 0 ? 7 : india.getUTCDay();
  const hhmm = india.toISOString().slice(11, 16);
  return s.days.includes(day) && hhmm >= s.opens && hhmm < s.closes;
}
