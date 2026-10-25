import { describe, expect, it } from 'vitest';
import {
  modeAt,
  pocEndedAt,
  pocFirstMonth,
  switchCountsFrom,
  type ModeChange,
} from '../src/business-mode.js';

/** India time, as UTC seconds. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;

describe('the business switch: POC or regular business', () => {
  const changes: ModeChange[] = [
    { mode: 'poc', from: ist('2027-08-01T08:00:00') },
    { mode: 'regular', from: ist('2027-11-01T08:00:00') },
  ];

  it('regular business before any switch; then the latest switch', () => {
    expect(modeAt([], ist('2027-08-05T10:00:00'))).toBe('regular');
    expect(modeAt(changes, ist('2027-07-31T23:00:00'))).toBe('regular');
    expect(modeAt(changes, ist('2027-08-01T08:00:00'))).toBe('poc');
    expect(modeAt(changes, ist('2027-10-31T23:59:00'))).toBe('poc');
    expect(modeAt(changes, ist('2027-11-01T09:00:00'))).toBe('regular');
  });

  it('a switch counts from the start of the business day it is made in', () => {
    expect(switchCountsFrom(ist('2027-08-01T15:00:00'))).toBe(ist('2027-08-01T08:00:00'));
    // 01:00 belongs to the business day that started the day before.
    expect(switchCountsFrom(ist('2027-08-02T01:00:00'))).toBe(ist('2027-08-01T08:00:00'));
    // Between 02:00 and 08:00: the day about to start.
    expect(switchCountsFrom(ist('2027-08-02T05:00:00'))).toBe(ist('2027-08-02T08:00:00'));
  });

  it('the POC starts in the month first switched on and ends with the switch back', () => {
    expect(pocFirstMonth(changes)).toBe('2027-08');
    expect(pocEndedAt(changes)).toBe(ist('2027-11-01T08:00:00'));
    expect(pocEndedAt(changes.slice(0, 1))).toBeUndefined();
    expect(pocFirstMonth([])).toBeUndefined();
  });
});
