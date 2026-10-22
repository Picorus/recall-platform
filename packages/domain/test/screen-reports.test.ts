import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dailyTotals,
  DEFAULT_MOVING_HOUR_RULES,
  monthlyHours,
  oddMinutes,
  type Totals,
} from '../src/moving-hours.js';
import {
  acknowledge,
  addSecond,
  EMPTY_INBOX,
  EMPTY_MINUTE,
  EMPTY_OUTBOX,
  enqueue,
  flushMinute,
  KEEP_UNSENT_SECONDS,
  nextBatch,
  oldestHeld,
  receive,
  type MinuteBuilder,
  type MinuteSummary,
  type Numbered,
  type Report,
} from '../src/screen-reports.js';
import type { Second } from '../src/screen-tracker.js';

const T = 1_800_000_000 - (1_800_000_000 % 60); // start of a minute
const inside = { kind: 'inside', areaId: 'hyd-madhapur', version: 3 } as const;

function sec(t: number, over: Partial<Second> = {}): Second {
  return {
    t,
    fix: 'used',
    position: { lat: 17.44, lng: 78.39 + (t - T) * 0.00005 },
    place: inside,
    moving: true,
    standby: false,
    clockRuns: true,
    ...over,
  };
}

function feed(seconds: Second[]): Report[] {
  let b: MinuteBuilder = EMPTY_MINUTE;
  const out: Report[] = [];
  for (const s of seconds) {
    const r = addSecond(b, s);
    b = r.builder;
    out.push(...r.reports);
  }
  return [...out, ...flushMinute(b)];
}

const minutesOf = (reports: Report[]) =>
  reports.filter((r): r is MinuteSummary => r.kind === 'minute');

describe('minute summaries and live positions (P1.2.4)', () => {
  const seconds = Array.from({ length: 150 }, (_, i) =>
    sec(T + i, i >= 100 ? { place: { kind: 'outside' }, clockRuns: i < 120, moving: false } : {}),
  );
  const reports = feed(seconds);
  const minutes = minutesOf(reports);

  it('one summary per minute, every second accounted for', () => {
    expect(minutes.map((m) => m.minute)).toEqual([T, T + 60, T + 120]);
    const total = minutes.reduce(
      (n, m) => n + Object.values(m.secondsAt).reduce((a, b) => a + b, 0),
      0,
    );
    expect(total).toBe(150);
    expect(minutes.reduce((n, m) => n + m.clockSeconds, 0)).toBe(120);
    expect(minutes[1]?.secondsAt).toEqual({ 'inside:hyd-madhapur@3': 40, outside: 20 });
    expect(minutes[1]?.clockAt).toEqual({ 'inside:hyd-madhapur@3': 40, outside: 20 });
    expect(minutes[2]?.clockAt).toEqual({});
  });

  it('distance follows the cleaned positions', () => {
    // 0.00005° of longitude a second ≈ 5.3 m at 17.44° N.
    expect(minutes[0]?.distanceM).toBeGreaterThan(59 * 5.2);
    expect(minutes[0]?.distanceM).toBeLessThan(60 * 5.4);
  });

  it('a live position every 30 seconds', () => {
    expect(
      reports.filter((r) => r.kind === 'live').map((r) => (r.kind === 'live' ? r.t - T : 0)),
    ).toEqual([0, 30, 60, 90, 120]);
  });
});

describe('store and forward (P1.2.5)', () => {
  const live = (t: number): Report => ({
    kind: 'live',
    t,
    lat: 17.44,
    lng: 78.39,
    place: 'outside',
    moving: false,
  });

  it('numbers every report and forgets only what the cloud confirmed', () => {
    let box = enqueue(EMPTY_OUTBOX, [live(1), live(2), live(3)], T);
    expect(box.waiting.map((n) => n.seq)).toEqual([1, 2, 3]);
    box = acknowledge(box, 2);
    expect(box.waiting.map((n) => n.seq)).toEqual([3]);
    box = enqueue(box, [live(4)], T + 1);
    expect(box.waiting.map((n) => n.seq)).toEqual([3, 4]);
  });

  it('keeps unsent reports for 7 days, then the cloud stops waiting and counts them lost', () => {
    let box = enqueue(EMPTY_OUTBOX, [live(1), live(2)], T);
    box = enqueue(box, [live(3)], T + KEEP_UNSENT_SECONDS - 1);
    expect(box.waiting).toHaveLength(3);
    box = enqueue(box, [live(4)], T + KEEP_UNSENT_SECONDS);
    expect(box.waiting.map((n) => n.seq)).toEqual([3, 4]);
    expect(box.expired).toBe(2);
    const r = receive(EMPTY_INBOX, nextBatch(box, 10), oldestHeld(box));
    expect(r.accepted.map((n) => n.seq)).toEqual([3, 4]);
    expect(r.inbox.lost).toBe(2);
    expect(r.ack).toBe(4);
  });

  it('with any mix of lost, repeated and out-of-order uploads, each report counts exactly once, in order', () => {
    const plan = fc.array(
      fc.record({
        newReports: fc.integer({ min: 0, max: 5 }),
        batch: fc.integer({ min: 1, max: 6 }),
        delivered: fc.boolean(),
        ackLost: fc.boolean(),
        shuffle: fc.boolean(),
        replayOld: fc.boolean(),
      }),
      { maxLength: 60 },
    );
    fc.assert(
      fc.property(plan, (steps) => {
        let box = EMPTY_OUTBOX;
        let inbox = EMPTY_INBOX;
        const stored: Numbered[] = [];
        const sent: Numbered[] = [];
        let made = 0;
        steps.forEach((st, i) => {
          box = enqueue(
            box,
            Array.from({ length: st.newReports }, (_, k) => live(made + k)),
            T + i,
          );
          made += st.newReports;
          let batch = [...nextBatch(box, st.batch)];
          if (st.replayOld) batch = [...sent.slice(-3), ...batch];
          if (st.shuffle) batch.reverse();
          sent.push(...batch);
          if (!st.delivered) return;
          const r = receive(inbox, batch, oldestHeld(box));
          inbox = r.inbox;
          stored.push(...r.accepted);
          if (!st.ackLost) box = acknowledge(box, r.ack);
        });
        // Drain: the network finally works.
        for (let guard = 0; box.waiting.length > 0 && guard < 1000; guard++) {
          const r = receive(inbox, nextBatch(box, 10), oldestHeld(box));
          inbox = r.inbox;
          stored.push(...r.accepted);
          box = acknowledge(box, r.ack);
        }
        expect(stored.map((n) => n.seq)).toEqual(Array.from({ length: made }, (_, k) => k + 1));
        expect(inbox.lost).toBe(0);
      }),
      { numRuns: 500 },
    );
  });
});

describe('moving hours (P1.2.6)', () => {
  const minute = (m: number, over: Partial<MinuteSummary> = {}): MinuteSummary => ({
    kind: 'minute',
    minute: m,
    secondsAt: { 'inside:hyd-madhapur@3': 60 },
    clockSeconds: 60,
    clockAt: { 'inside:hyd-madhapur@3': 60 },
    movingSeconds: 60,
    distanceM: 400,
    plays: 0,
    people: 0,
    ...over,
  });
  // 2027-08-23 09:00 India time = 03:30 UTC.
  const nine = Date.UTC(2027, 7, 23, 3, 30) / 1000;

  it('counts per business day; 01:30 belongs to the day before; 03:00 counts for nothing', () => {
    const onethirty = Date.UTC(2027, 7, 23, 20, 0) / 1000; // 01:30 on 24 Aug, India
    const three = Date.UTC(2027, 7, 23, 21, 30) / 1000; // 03:00 on 24 Aug, India
    const days = dailyTotals([minute(nine), minute(onethirty), minute(three)]);
    expect(days.get('2027-08-23')?.clockSeconds).toBe(120);
    expect(days.get('2027-08-23')?.outsideHoursSeconds).toBe(60);
    expect(days.has('2027-08-24')).toBe(false);
  });

  it('only the places that count are counted (e.g. inside Hyderabad in the POC)', () => {
    const m = minute(nine, { clockAt: { 'inside:hyd-madhapur@3': 40, outside: 20 } });
    const days = dailyTotals([m], (k) => k !== 'outside');
    expect(days.get('2027-08-23')?.countedSeconds).toBe(40);
    expect(days.get('2027-08-23')?.clockSeconds).toBe(60);
  });

  it('two parts of one minute (a restart) add up, but a minute never holds more than 60 s', () => {
    const half = { clockSeconds: 30, clockAt: { 'inside:hyd-madhapur@3': 30 }, movingSeconds: 30 };
    const days = dailyTotals([minute(nine, half), minute(nine, half)]);
    expect(days.get('2027-08-23')?.clockSeconds).toBe(60);
    const doubled = dailyTotals([minute(nine), minute(nine)]);
    expect(doubled.get('2027-08-23')?.clockSeconds).toBe(60);
    expect(doubled.get('2027-08-23')?.countedSeconds).toBe(60);
  });

  it('paid hours stop at 260 counted (active) hours a month', () => {
    const day = (counted: number): Totals => ({
      clockSeconds: counted,
      countedSeconds: counted,
      movingSeconds: counted,
      distanceM: 0,
      outsideHoursSeconds: 0,
    });
    const days = new Map<string, Totals>();
    for (let d = 1; d <= 30; d++) days.set(`2027-08-${String(d).padStart(2, '0')}`, day(10 * 3600));
    days.set('2027-09-01', day(5 * 3600));
    const months = monthlyHours(days);
    expect(DEFAULT_MOVING_HOUR_RULES.monthlyCapHours).toBe(260);
    expect(months).toEqual([
      { month: '2027-08', countedSeconds: 300 * 3600, paidSeconds: 260 * 3600 },
      { month: '2027-09', countedSeconds: 5 * 3600, paidSeconds: 5 * 3600 },
    ]);
  });

  it('flags minutes where the clock and the GPS disagree', () => {
    const odd = oddMinutes([
      minute(nine),
      minute(nine + 60, { distanceM: 20 }),
      minute(nine + 120, { movingSeconds: 0, distanceM: 900 }),
    ]);
    expect(odd).toEqual([
      { minute: nine + 60, kind: 'moving-but-still' },
      { minute: nine + 120, kind: 'still-but-moved' },
    ]);
  });
});

describe('review fixes: uploads', () => {
  const live = (t: number): Report => ({
    kind: 'live',
    t,
    lat: 17.44,
    lng: 78.39,
    place: 'outside',
    moving: false,
  });

  it('a wrong or forged "oldest held" cannot skip reports the screen still has', () => {
    const box = enqueue(EMPTY_OUTBOX, [live(1), live(2), live(3)], T);
    // Claims it only holds from 1,000,000 but sends 1–3: nothing is lost.
    const r = receive(EMPTY_INBOX, nextBatch(box, 10), 1_000_000);
    expect(r.accepted.map((n) => n.seq)).toEqual([1, 2, 3]);
    expect(r.inbox.lost).toBe(0);
    // With an empty batch the claim proves nothing.
    expect(receive(EMPTY_INBOX, [], 1_000_000).inbox.upTo).toBe(0);
    expect(receive(EMPTY_INBOX, [], Number.POSITIVE_INFINITY).inbox.upTo).toBe(0);
    // A huge real gap is skipped in one step, not one number at a time.
    const far = receive(EMPTY_INBOX, [{ seq: 50_000_000, report: live(9), at: T }], 50_000_000);
    expect(far.inbox.lost).toBe(49_999_999);
    expect(far.ack).toBe(50_000_000);
  });

  it('an ack above what was sent is ignored, so the outbox is never emptied by mistake', () => {
    const box = enqueue(EMPTY_OUTBOX, [live(1), live(2)], T);
    expect(acknowledge(box, 999_999).waiting).toHaveLength(2);
    expect(acknowledge(box, 1.5).waiting).toHaveLength(2);
    expect(acknowledge(box, 1).waiting.map((n) => n.seq)).toEqual([2]);
  });
});

describe('review fixes: distance', () => {
  it('no distance across a long GPS gap or a reset', () => {
    const a = sec(T, {});
    const far = sec(T + 8 * 3600, { position: { lat: 17.48, lng: 78.39 } });
    const m = minutesOf(feed([a, far]));
    expect(m.reduce((n, x) => n + x.distanceM, 0)).toBe(0);
    const reset = sec(T + 1, { fix: 'reset', position: { lat: 17.48, lng: 78.39 } });
    expect(minutesOf(feed([a, reset]))[0]?.distanceM).toBe(0);
  });
});
