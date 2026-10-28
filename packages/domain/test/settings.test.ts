// P3.17: settings are checked before they are saved; cities and centres are never lost; message
// wording fills in; support hours in India time.
import { describe, expect, it } from 'vitest';
import {
  checkSetting,
  companySet,
  checkSettingChange,
  DEFAULT_SETTINGS as D,
  fillWording,
  SETTING_KEYS,
  supportOpenAt,
} from '../src/index.js';

describe('settings (P3.17)', () => {
  it('the defaults pass their own checks', () => {
    for (const k of SETTING_KEYS)
      if (k !== 'fittingCentres' || D[k].length > 0) expect(checkSetting(k, D[k])).toEqual(D[k]);
    expect(checkSetting('fittingCentres', [])).toEqual([]);
  });

  it('cities: named, at least one, none twice', () => {
    expect(checkSetting('cities', [{ name: ' Hyderabad ' }, { name: 'Bengaluru' }])).toEqual([
      { name: 'Hyderabad' },
      { name: 'Bengaluru' },
    ]);
    expect(() => checkSetting('cities', [])).toThrow('at least one');
    expect(() => checkSetting('cities', [{ name: 'Hyderabad' }, { name: 'hyderabad' }])).toThrow(
      'twice',
    );
    expect(() => checkSetting('cities', [{ name: 'H\nyd' }])).toThrow('one line');
    // Invisible characters that make a name look like another, or hide a line break.
    for (const hidden of ['\u200b', '\u202e', '\u2028', '\ufeff'])
      expect(() => checkSetting('cities', [{ name: `Hyd${hidden}erabad` }])).toThrow('hidden');
  });

  it('fitting centres: name, address, on or off; never removed, only switched off', () => {
    const a = { name: 'Kukatpally warehouse', address: 'Plot 4, KPHB Phase 1', on: true };
    expect(checkSetting('fittingCentres', [a])).toEqual([a]);
    expect(() => checkSetting('fittingCentres', [{ ...a, on: 'yes' }])).toThrow('on or off');
    expect(() => checkSetting('fittingCentres', [{ ...a, address: 'x' }])).toThrow('address');
    expect(() => checkSettingChange('fittingCentres', [a], [])).toThrow('switch it off');
    expect(() => checkSettingChange('fittingCentres', [a], [{ ...a, on: false }])).not.toThrow();
    expect(() => checkSettingChange('cities', D.cities, [{ name: 'Pune' }])).toThrow(
      'cannot be removed',
    );
  });

  it('support: +91 numbers, days 1 to 7, closing after opening', () => {
    const s = {
      phones: [
        { label: 'Riders', phone: '+91 98480 12345', whatsapp: true },
        // No +91, stray spaces: kept as +91 and 10 digits.
        { label: 'Brands', phone: ' 90000 11111 ', whatsapp: false },
      ],
      days: [6, 1, 2],
      opens: '10:00',
      closes: '19:00',
    };
    expect(checkSetting('support', s)).toEqual({
      ...s,
      phones: [
        { label: 'Riders', phone: '+919848012345', whatsapp: true },
        { label: 'Brands', phone: '+919000011111', whatsapp: false },
      ],
      days: [1, 2, 6],
    });
    expect(() =>
      checkSetting('support', { ...s, phones: [{ ...s.phones[0], phone: '12345' }] }),
    ).toThrow('+91');
    expect(() => checkSetting('support', { ...s, days: [0] })).toThrow('1 Monday');
    expect(() => checkSetting('support', { ...s, days: [1, 1] })).toThrow('twice');
    expect(() => checkSetting('support', { ...s, opens: '19:00', closes: '10:00' })).toThrow(
      'closes after',
    );
    expect(() => checkSetting('support', { ...s, opens: '25:00' })).toThrow('time like');
  });

  it('support hours are India time', () => {
    const mon = Date.UTC(2027, 7, 23) / 1000; // Monday 23 Aug 2027, 05:30 India time
    const s = { ...D.support, days: [1, 2, 3, 4, 5] };
    expect(supportOpenAt(s, mon + 4.5 * 3600)).toBe(true); // 10:00 India
    expect(supportOpenAt(s, mon + 4.5 * 3600 - 1)).toBe(false); // 09:59:59
    expect(supportOpenAt(s, mon + 13.5 * 3600)).toBe(false); // 19:00, closed
    expect(supportOpenAt(s, mon + 5 * 86400 + 6 * 3600)).toBe(false); // Saturday
    // 22:30 UTC on Sunday is already 04:00 on Monday in India.
    expect(supportOpenAt({ ...s, opens: '04:00' }, mon - 1800)).toBe(true);
  });

  it('message wording: known placeholders only, the needed one present', () => {
    const w = D.messages;
    expect(fillWording(w.reportReady.emailSubject, { booking: 'BK-1', period: '1–31 Aug' })).toBe(
      'Your RECALL campaign report: BK-1 (1–31 Aug)',
    );
    expect(fillWording('{reply} {nope}', { reply: 'Hi' })).toBe('Hi {nope}');
    const bad = (part: object) =>
      checkSetting('messages', { ...w, reportReady: { ...w.reportReady, ...part } });
    expect(() => bad({ emailText: '{summary}' })).toThrow('must have {link}');
    expect(() => bad({ emailText: '{link} {price}' })).toThrow('"{price}" is not one of');
    expect(() => bad({ emailText: '{link} {' })).toThrow('"{" is not one of');
    expect(() => bad({ emailSubject: 'Report\nready' })).toThrow('one line');
    expect(() => bad({ whatsappTemplate: 'Report Ready' })).toThrow('approved name');
    expect(() =>
      checkSetting('messages', {
        ...w,
        supportReply: { ...w.supportReply, emailText: '{link}' },
      }),
    ).toThrow('"{link}" is not one of');
  });

  it('pay zones: POC a circle in India of 1 to 100 km; regular all areas, or some (P1.7.5)', () => {
    expect(checkSetting('pocZone', D.pocZone)).toEqual(D.pocZone);
    expect(D.pocZone.kind).toBe('circle');
    expect(checkSetting('regularZone', D.regularZone)).toEqual({
      kind: 'allAreas',
      withEdge: false,
    });
    const circle = (lat: number, radiusM: number) => ({
      kind: 'circle',
      centre: { lat, lng: 78.38 },
      radiusM,
    });
    expect(() => checkSetting('pocZone', circle(51.5, 15_000))).toThrow('India');
    expect(() => checkSetting('pocZone', circle(17.45, 500))).toThrow('1 to 100 km');
    expect(
      checkSetting('regularZone', { kind: 'areas', areaIds: ['hyd-madhapur'], withEdge: true }),
    ).toEqual({ kind: 'areas', areaIds: ['hyd-madhapur'], withEdge: true });
    expect(() =>
      checkSetting('regularZone', { kind: 'areas', areaIds: [], withEdge: true }),
    ).toThrow('at least one');
    expect(() => checkSetting('regularZone', { kind: 'allAreas', withEdge: 'no' })).toThrow();
    expect(() => checkSetting('regularZone', { kind: 'square' })).toThrow('circle');
  });

  it('rider sign-in limits: whole numbers in their ranges (P4.1)', () => {
    expect(checkSetting('riderSignIn', D.riderSignIn)).toEqual(D.riderSignIn);
    expect(() => checkSetting('riderSignIn', { ...D.riderSignIn, triesPerCode: 0 })).toThrow(
      'triesPerCode: a whole number 1 to 10',
    );
    expect(() => checkSetting('riderSignIn', { ...D.riderSignIn, codeSeconds: 60.5 })).toThrow(
      'codeSeconds',
    );
  });

  it('brand sign-in limits: whole numbers in their ranges (P5.1)', () => {
    expect(checkSetting('brandSignIn', D.brandSignIn)).toEqual(D.brandSignIn);
    expect(() => checkSetting('brandSignIn', { ...D.brandSignIn, idleDays: 365 })).toThrow(
      'Brand sign-in, idleDays: a whole number 1 to 90',
    );
    expect(() =>
      checkSetting('brandSignIn', { ...D.brandSignIn, triesPerCode: undefined }),
    ).toThrow('triesPerCode');
  });

  it('free week: off until a super admin turns it on (P5.2)', () => {
    expect(D.freeWeek).toEqual({ on: false });
    expect(checkSetting('freeWeek', { on: true })).toEqual({ on: true });
    expect(() => checkSetting('freeWeek', { on: 'yes' })).toThrow('Free week: on or off');
    // P5.8: the company's details on invoices: empty until saved; saved only whole and valid.
    expect(D.company).toEqual({ legalName: '', gstin: '', address: '' });
    expect(companySet(D.company)).toBe(false);
    const co = checkSetting('company', {
      legalName: 'Recall Media Private Limited',
      gstin: '36aabcu9603r1zo',
      address: 'Plot 1, Madhapur, Hyderabad 500081, Telangana',
    });
    expect(co.gstin).toBe('36AABCU9603R1ZO');
    expect(checkSetting('company', { ...co, gstin: ' 36 aabcu 9603 r1zo ' }).gstin).toBe(
      '36AABCU9603R1ZO',
    );
    expect(companySet(co)).toBe(true);
    expect(() => checkSetting('company', { ...co, gstin: '36AABCU9603R1ZX' })).toThrow(
      'Company GSTIN',
    );
    expect(() => checkSetting('company', { ...co, legalName: 'X' })).toThrow('legal name');
    expect(() => checkSetting('company', { ...co, address: '' })).toThrow('address');
    expect(checkSetting('company', { legalName: ' ', gstin: '', address: '' })).toEqual(D.company);
  });

  it('screen-loan bank: a name', () => {
    expect(checkSetting('loanBank', { name: 'Dhanlaxmi Bank' })).toEqual({
      name: 'Dhanlaxmi Bank',
    });
    expect(() => checkSetting('loanBank', { name: '' })).toThrow('Bank name');
    expect(() => checkSetting('nope' as 'loanBank', {})).toThrow('Which setting');
  });
});
