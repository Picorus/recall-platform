import { describe, expect, it } from 'vitest';
import {
  addDays,
  cellLines,
  cellTone,
  holdLive,
  indiaToUtc,
  tenths,
  type Cell,
} from '../../lib/calendar';

const cell = (x: Partial<Cell>): Cell => ({
  date: '2027-08-27',
  startHour: 19,
  booked: 0,
  held: 0,
  manualLimit: null,
  limit: null,
  free: null,
  usual: null,
  deliveredTenths: null,
  ...x,
});

describe('inventory calendar page (P3.7)', () => {
  it('India time to UTC; anything unreadable is refused', () => {
    expect(indiaToUtc('2027-08-27', '18:00')).toBe(Date.UTC(2027, 7, 27, 12, 30) / 1000);
    expect(indiaToUtc('2027-08-27', '00:15')).toBe(Date.UTC(2027, 7, 26, 18, 45) / 1000);
    expect(indiaToUtc('2027-02-30', '10:00')).toBeNull();
    expect(indiaToUtc('2027-08-27', '24:00')).toBeNull();
    expect(indiaToUtc('tomorrow', '10:00')).toBeNull();
    expect([addDays('2027-08-30', 7), addDays('2027-08-30', -7)]).toEqual([
      '2027-09-06',
      '2027-08-23',
    ]);
  });

  it('a cell in words and how full it is', () => {
    expect(cellLines(cell({ booked: 30, held: 15, limit: 50, free: 5 }))).toEqual([
      '30 booked · 15 held',
      '5 free of 50',
    ]);
    expect(cellLines(cell({ booked: 30 }))).toEqual(['30 booked', 'no limit']);
    expect(cellTone(cell({}))).toBe('none');
    expect(cellTone(cell({ limit: 50, free: 0 }))).toBe('full');
    expect(cellTone(cell({ limit: 50, free: 5 }))).toBe('tight');
    expect(cellTone(cell({ limit: 50, free: 6 }))).toBe('room');
    expect([tenths(75), tenths(0), tenths(120)]).toEqual(['7.5', '0', '12']);
  });

  it('a hold is live until it ends or becomes a booking', () => {
    const h = {
      holdId: 'HLD-1',
      brandId: 'chai-co',
      heldBy: 'Sana',
      reason: null,
      createdAt: 0,
      until: 100,
      endedEarly: null,
      bookingId: null,
      lines: [],
    };
    expect(holdLive(h, 99)).toBe(true);
    expect(holdLive(h, 100)).toBe(false);
    expect(holdLive({ ...h, bookingId: 'BK-1' }, 50)).toBe(false);
  });
});
