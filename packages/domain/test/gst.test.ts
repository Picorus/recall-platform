import { describe, expect, it } from 'vitest';
import { docNumber, financialYearOf, gstinProblems, rupees, splitGst, toCsv } from '../src/gst.js';

describe('GST documents (P1.7.9)', () => {
  it('financial years run April to March', () => {
    expect(financialYearOf('2027-03-31')).toBe('2026-27');
    expect(financialYearOf('2027-04-01')).toBe('2027-28');
    expect(financialYearOf('2099-12-31')).toBe('2099-00');
  });

  it('numbers are one series per year, at most 16 characters', () => {
    expect(docNumber('invoice', '2027-28', 123)).toBe('RC/27-28/000123');
    expect(docNumber('credit-note', '2027-28', 4)).toBe('CN/27-28/000004');
    expect(docNumber('invoice', '2027-28', 999_999).length).toBeLessThanOrEqual(16);
    expect(() => docNumber('invoice', '2027-28', 0)).toThrow();
  });

  it('GSTIN shape and check digit', () => {
    expect(gstinProblems('27AAPFU0939F1ZV')).toEqual([]);
    expect(gstinProblems('27AAPFU0939F1ZX')).toEqual(['GSTIN check digit is wrong']);
    expect(gstinProblems('XYZ')).toEqual(['GSTIN must look like 36ABCDE1234F1Z5']);
  });

  it('same state: CGST + SGST (odd paisa to SGST); another state: IGST', () => {
    expect(splitGst(27_001, '36', '36')).toEqual({ cgst: 13_500, sgst: 13_501, igst: 0 });
    expect(splitGst(27_001, '36', '27')).toEqual({ cgst: 0, sgst: 0, igst: 27_001 });
  });

  it('CSV for the accountant: quoted where needed, no spreadsheet formulas, rupees with paise', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', '=SUM(A1)'],
          ['say "hi"', -5],
        ],
      ),
    ).toBe('a,b\r\n"x,y",\'=SUM(A1)\r\n"say ""hi""",-5\r\n');
    expect([rupees(123_450), rupees(5), rupees(-1_005)]).toEqual(['1234.50', '0.05', '-10.05']);
  });
});
