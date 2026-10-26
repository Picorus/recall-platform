import { describe, expect, it } from 'vitest';
import { idFromName, matches, phoneText, type AccountRow } from '../../lib/brands';

const row: AccountRow = {
  brandId: 'chai-co',
  kind: 'brand',
  version: 1,
  name: 'Chai Co',
  agencyId: 'adwise',
  referredBy: null,
  active: true,
  agencyName: 'Adwise Media',
  phone: '+919876543210',
  email: 'hello@chai.co',
  gstin: '36AAPFU0939F1ZW',
  bookings: 2,
  lastFirstHour: null,
};

describe('Brands page (P3.8.1)', () => {
  it('search: name, id, email, GSTIN, agency, or 4+ digits of the phone', () => {
    for (const q of ['', 'chai', 'CHAI-CO', 'hello@', '36aapfu', 'adwise', '98765', '987 654'])
      expect(matches(row, q), q).toBe(true);
    for (const q of ['dosa', '123', 'zz@']) expect(matches(row, q), q).toBe(false);
  });

  it('a phone in words; an id suggested from a name', () => {
    expect(phoneText('+919876543210')).toBe('+91 98765 43210');
    expect(phoneText(null)).toBe('—');
    expect(idFromName('Chai Co (Hitech City)')).toBe('chai-co-hitech-city');
    expect(idFromName('  ---  ')).toBe('');
    expect(idFromName('a'.repeat(70))).toHaveLength(64);
  });
});
