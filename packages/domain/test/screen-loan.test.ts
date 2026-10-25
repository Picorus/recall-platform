import { describe, expect, it } from 'vitest';
import { canMoveLoan, emiDates, loanView } from '../src/screen-loan.js';

describe('screen loan record (P1.7.8)', () => {
  it('36 EMIs, the same day each month; the 31st falls on the last day of shorter months', () => {
    const d = emiDates('2028-02-05', 36);
    expect([d.length, d[0], d[1], d[35]]).toEqual([36, '2028-02-05', '2028-03-05', '2031-01-05']);
    expect(emiDates('2028-01-31', 3)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(() => emiDates('2028-13-01', 3)).toThrow();
    expect(() => emiDates('2028-01-01', 0)).toThrow();
  });

  it('statuses only move forward: applied → approved → disbursed → closed (or rejected / defaulted)', () => {
    expect(canMoveLoan('applied', 'approved')).toBe(true);
    expect(canMoveLoan('disbursed', 'defaulted')).toBe(true);
    expect(canMoveLoan('defaulted', 'closed')).toBe(true);
    expect(canMoveLoan('closed', 'disbursed')).toBe(false);
    expect(canMoveLoan('applied', 'disbursed')).toBe(false);
    expect(canMoveLoan('rejected', 'approved')).toBe(false);
  });

  it('the rider app shows the next EMI and how many are left, only while the loan runs', () => {
    expect(loanView('disbursed', '2028-02-05', 36, '2028-02-06')).toEqual({
      status: 'disbursed',
      nextEmi: '2028-03-05',
      emisLeft: 35,
    });
    expect(loanView('approved', '2028-02-05', 36, '2028-01-01').nextEmi).toBeUndefined();
    expect(loanView('disbursed', '2028-02-05', 36, '2031-02-01')).toMatchObject({
      nextEmi: undefined,
      emisLeft: 0,
    });
  });
});
