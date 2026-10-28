import { describe, expect, it } from 'vitest';
import {
  modeAt,
  pocAlerts,
  pocDaysEarly,
  pocEndedAt,
  pocPhase,
  pocPlannedEnd,
  pocFirstMonth,
  pocStartsFrom,
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

  it('the POC is switched on from the 1st of a month, so month 1 is a full month', () => {
    expect(pocStartsFrom(ist('2026-10-25T15:00:00'))).toBe(ist('2026-11-01T08:00:00'));
    expect(pocStartsFrom(ist('2026-11-01T10:00:00'))).toBe(ist('2026-11-01T08:00:00'));
    // 00:30 on the 1st is the tail of the 31st: still the 1st at 08:00.
    expect(pocStartsFrom(ist('2026-11-01T00:30:00'))).toBe(ist('2026-11-01T08:00:00'));
    expect(pocStartsFrom(ist('2026-12-20T09:00:00'))).toBe(ist('2027-01-01T08:00:00'));
  });
});

describe('P7.8: the POC is scheduled, runs, and is switched back by hand', () => {
  const on = ist('2027-07-15T11:00:00');
  const start = pocStartsFrom(on);
  const changes: ModeChange[] = [{ mode: 'poc', from: start }];

  it('switched on mid-month: scheduled, it starts on the next 1st; planned end after 3 months', () => {
    expect(start).toBe(ist('2027-08-01T08:00:00'));
    expect(pocPlannedEnd(start, 3)).toBe(ist('2027-11-01T08:00:00'));
    expect(pocPlannedEnd(ist('2027-11-01T08:00:00'), 3)).toBe(ist('2028-02-01T08:00:00'));
    expect(pocPhase(changes, 3, on)).toMatchObject({ phase: 'scheduled', endedAt: null });
    expect(pocPhase(changes, 3, start)).toMatchObject({ phase: 'running' });
    expect(pocPhase([], 3, on)).toEqual({ phase: 'none' });
    // It does not end by itself: still on after its months, until a super admin switches back.
    expect(modeAt(changes, ist('2027-11-03T10:00:00'))).toBe('poc');
    expect(pocPhase(changes, 3, ist('2027-11-03T10:00:00')).phase).toBe('running');
    expect(() => pocPlannedEnd(start, 0)).toThrow();
  });

  it('a switch back is early when it counts from before the planned end', () => {
    const p = (now: number) => pocPhase(changes, 3, now);
    const back = (now: number) => pocDaysEarly(p(now), switchCountsFrom(now));
    // 09:00 on 1 November: counts from 08:00 that day, the planned end. Not early.
    expect(back(ist('2027-11-01T09:00:00'))).toBe(0);
    // 03:00 on 1 November counts from that day's 08:00: not early either.
    expect(back(ist('2027-11-01T03:00:00'))).toBe(0);
    // 00:30 on 1 November counts from 31 October (the business day before): one day early.
    expect(back(ist('2027-11-01T00:30:00'))).toBe(1);
    // Mid-September: 47 days early.
    expect(back(ist('2027-09-15T12:00:00'))).toBe(47);
    // Late (3 November): the extra days were POC; not early.
    expect(back(ist('2027-11-03T10:00:00'))).toBe(0);
    // Ended: nothing early about it any more.
    const ended = pocPhase(
      [...changes, { mode: 'regular', from: ist('2027-11-01T08:00:00') }],
      3,
      ist('2027-11-02T10:00:00'),
    );
    expect(ended).toMatchObject({ phase: 'ended', endedAt: ist('2027-11-01T08:00:00') });
    expect(pocDaysEarly(ended, ist('2027-11-02T08:00:00'))).toBe(0);
  });

  it('alerts for super admins: scheduled, starts today, 7 days before, months over', () => {
    const kinds = (now: number) => pocAlerts(pocPhase(changes, 3, now), 3, now).map((a) => a.kind);
    const sched = pocAlerts(pocPhase(changes, 3, on), 3, on);
    expect(sched.map((a) => a.kind)).toEqual(['scheduled']);
    expect(sched[0]?.text).toMatch(/starts Sun 1 Aug 2027.*31 Oct 2027.*Mon 1 Nov 2027/);
    expect(kinds(ist('2027-08-01T07:00:00'))).toEqual(['scheduled', 'starts-today']);
    expect(kinds(ist('2027-08-01T09:00:00'))).toEqual(['starts-today']);
    expect(kinds(ist('2027-08-20T09:00:00'))).toEqual([]);
    expect(kinds(ist('2027-10-25T09:00:00'))).toEqual(['ends-soon']);
    expect(kinds(ist('2027-11-01T00:30:00'))).toEqual(['ends-soon', 'months-over']);
    expect(kinds(ist('2027-11-03T09:00:00'))).toEqual(['months-over']);
    const done = [...changes, { mode: 'regular' as const, from: ist('2027-11-01T08:00:00') }];
    expect(
      pocAlerts(pocPhase(done, 3, ist('2027-11-01T09:00:00')), 3, ist('2027-11-01T09:00:00')),
    ).toEqual([]);
  });
});
