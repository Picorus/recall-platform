'use client';
// P3.7 Inventory calendar: one area's week, every start hour: bikes booked and held, the limit and
// what is free, the bikes usually seen, and what was delivered in hours already over. A Sales admin
// holds a client's hours, days and bikes until a set time (no money), releases a hold early or turns
// it into a draft booking; a super admin sets or lifts a manual limit. Every change asks why.
import { Info } from '@recall/web-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import {
  addDays,
  cellLines,
  cellTone,
  holdLive,
  indiaToUtc,
  tenths,
  type Cell,
  type HoldView,
} from '../../lib/calendar';
import { clock, dayName, dayOfIndia, rupees } from '../../lib/format';
import { hourLabel, START_HOURS } from '../../lib/prices';
import { Shell, useMember } from '../../lib/session';

interface Page {
  readonly at: number;
  readonly areas: readonly { areaId: string; name: string }[];
  readonly week: {
    readonly areaId: string;
    readonly days: readonly string[];
    readonly mode: 'poc' | 'forecast';
    readonly cells: readonly Cell[];
    readonly holds: readonly HoldView[];
  } | null;
}

const isSuper = (m: Member) => m.role === 'super-admin';
const canHold = (m: Member) => isSuper(m) || (m.role === 'admin' && m.areas.includes('sales'));
const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;

function holdStatus(h: HoldView, now: number): string {
  if (h.bookingId) return `booked as ${h.bookingId}`;
  if (h.endedEarly) return `released ${when(h.endedEarly.at)}: ${h.endedEarly.reason}`;
  return h.until > now ? `held until ${when(h.until)}` : `ended ${when(h.until)}`;
}

function linesText(h: HoldView): string {
  const days = [...new Set(h.lines.map((l) => l.date))].map(dayName).join(', ');
  const hours = [...new Set(h.lines.map((l) => l.startHour))].sort((a, b) => a - b).map(hourLabel);
  const bikes = [...new Set(h.lines.map((l) => l.bikes))].join('/');
  return `${bikes} bikes · ${days} · ${hours.join(' ')}`;
}

export default function CalendarPage() {
  const me = useMember();
  const [page, setPage] = useState<Page>();
  const [area, setArea] = useState('');
  const [from, setFrom] = useState('');
  const [picked, setPicked] = useState<Cell>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // The hold form.
  const [days, setDays] = useState<string[]>([]);
  const [hours, setHours] = useState<number[]>([]);

  // Only the newest request's answer is shown (an older one arriving late must not switch back).
  const asked = useRef(0);
  const started = useRef(false);
  const load = useCallback((a: string, f: string) => {
    const q = new URLSearchParams();
    if (a) q.set('area', a);
    if (f) q.set('from', f);
    const n = ++asked.current;
    api<Page>(`/calendar?${q.toString()}`)
      .then((p) => {
        if (n !== asked.current) return;
        setPage(p);
        if (p.week) {
          setArea(p.week.areaId);
          setFrom(p.week.days[0] ?? '');
          // A hold covers only days on screen: days ticked in another week are dropped.
          const shown = p.week.days;
          setDays((d) => d.filter((x) => shown.includes(x)));
        }
        setPicked((c) =>
          c ? p.week?.cells.find((x) => x.date === c.date && x.startHour === c.startHour) : c,
        );
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me && !started.current) {
      started.current = true;
      load('', '');
    }
  }, [me, load]);

  const byKey = useMemo(
    () => new Map(page?.week?.cells.map((c) => [`${c.date}|${c.startHour}`, c]) ?? []),
    [page],
  );

  if (!me) return <p className="narrow muted">Loading…</p>;
  const week = page?.week;
  const now = page?.at ?? 0;

  const call = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await f();
      load(area, from);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  const pick = (c: Cell) => {
    setPicked(c);
    setDays([c.date]);
    setHours([c.startHour]);
  };
  const toggle = <T,>(list: T[], x: T) =>
    list.includes(x) ? list.filter((y) => y !== x) : [...list, x];

  const setLimit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!picked) return;
    const f = new FormData(e.currentTarget);
    const text = String(f.get('limit') ?? '').trim();
    if (text !== '' && !/^\d{1,6}$/.test(text))
      return setError('The limit is a whole number of bikes.');
    void call(async () => {
      await api('/calendar/limit', {
        areaId: area,
        date: picked.date,
        startHour: picked.startHour,
        maxBikes: text === '' ? null : Number(text),
        reason: String(f.get('reason') ?? ''),
      });
      setNote(text === '' ? 'Limit lifted.' : `Limit set to ${text} bikes.`);
    });
  };
  const hold = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const until = indiaToUtc(String(f.get('endDate') ?? ''), String(f.get('endTime') ?? ''));
    if (until === null) return setError('Give the end as a date and a time (India time).');
    const bikes = String(f.get('bikes') ?? '');
    if (!/^\d{1,6}$/.test(bikes)) return setError('Bikes must be a whole number.');
    void call(async () => {
      const r = await api<{ holdId: string }>('/holds', {
        brandId: String(f.get('brand') ?? '').trim(),
        areaId: area,
        dates: days.filter((d) => week?.days.includes(d)),
        hours,
        bikes: Number(bikes),
        until,
        reason: String(f.get('reason') ?? ''),
      });
      setNote(`Held: ${r.holdId}.`);
    });
  };
  const release = (h: HoldView) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    void call(async () => {
      await api(`/holds/${h.holdId}/end`, { reason });
      setNote(`${h.holdId} released: its bikes are on sale again.`);
    });
  };
  const book = (h: HoldView) =>
    void call(async () => {
      const r = await api<{ bookingId: string; total: number }>(`/holds/${h.holdId}/book`, {});
      setNote(
        `Draft booking ${r.bookingId} made for ${h.brandId}: ${rupees(r.total)} with GST. The hold keeps the bikes until it is paid or the hold ends.`,
      );
    });

  return (
    <Shell member={me}>
      <h1>Inventory calendar</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {page && !week && <p className="muted">No area is on sale yet.</p>}
      {week && (
        <>
          <div className="cal-bar">
            <label className="rc-field">
              <span className="rc-field__label">Area</span>
              <select
                className="rc-input"
                value={area}
                onChange={(e) => {
                  setPicked(undefined);
                  load(e.target.value, from);
                }}
              >
                {page.areas.map((a) => (
                  <option key={a.areaId} value={a.areaId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rc-button rc-button--quiet"
              type="button"
              onClick={() => load(area, addDays(from, -7))}
            >
              Previous week
            </button>
            <button
              className="rc-button rc-button--quiet"
              type="button"
              onClick={() => load(area, '')}
            >
              From today
            </button>
            <button
              className="rc-button rc-button--quiet"
              type="button"
              onClick={() => load(area, addDays(from, 7))}
            >
              Next week
            </button>
          </div>
          <p className="muted">
            {week.mode === 'poc'
              ? 'POC: every bike runs; an area-hour is limited only where a super admin set a limit.'
              : 'Each area-hour is limited by what past weeks show it can carry, unless a super admin set a limit.'}{' '}
            Bikes are counted once a booking is awaiting payment; drafts keep nothing.
          </p>
          <div className="rc-table-wrap">
            <table className="rc-table cal" aria-label="Area-hours this week">
              <thead>
                <tr>
                  <th>Start</th>
                  {week.days.map((d) => (
                    <th key={d}>{dayName(d)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {START_HOURS.map((h) => (
                  <tr key={h}>
                    <th scope="row">{hourLabel(h)}</th>
                    {week.days.map((d) => {
                      const c = byKey.get(`${d}|${h}`);
                      if (!c) return <td key={d} />;
                      const [a, b] = cellLines(c);
                      const on = picked?.date === d && picked.startHour === h;
                      return (
                        <td key={d} className={`cal-${cellTone(c)}${on ? ' cal-on' : ''}`}>
                          <button
                            type="button"
                            className="cal-cell"
                            aria-label={`${dayName(d)} ${hourLabel(h)}: ${a}, ${b}`}
                            onClick={() => pick(c)}
                          >
                            <span>{a}</span>
                            <span className="muted">{b}</span>
                            {c.deliveredTenths !== null && c.booked > 0 && (
                              <span className="muted">{tenths(c.deliveredTenths)} delivered</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {picked && (
            <section className="rc-card stack" aria-label="Area-hour">
              <h2 style={{ margin: 0 }}>
                {dayName(picked.date)} {hourLabel(picked.startHour)}
              </h2>
              <dl className="facts">
                <dt>Booked</dt>
                <dd>{picked.booked} bikes</dd>
                <dt>Held</dt>
                <dd>{picked.held} bikes</dd>
                <dt>Limit</dt>
                <dd>
                  {picked.limit === null
                    ? 'none'
                    : `${picked.limit} bikes${picked.manualLimit === null ? ' (forecast)' : ' (set by a super admin)'}`}
                </dd>
                <dt>Free</dt>
                <dd>{picked.free === null ? 'no limit' : `${picked.free} bikes`}</dd>
                <dt>Usually seen</dt>
                <dd>{picked.usual === null ? 'not enough weeks yet' : `${picked.usual} bikes`}</dd>
                {picked.deliveredTenths !== null && (
                  <>
                    <dt>Delivered</dt>
                    <dd>{tenths(picked.deliveredTenths)} bike-hours (paid lines)</dd>
                  </>
                )}
              </dl>
              {isSuper(me) && (
                <form
                  className="stack"
                  onSubmit={setLimit}
                  aria-label="Manual limit"
                  // A new form for each cell, so a box never keeps another hour's limit.
                  key={`${area}|${picked.date}|${picked.startHour}`}
                >
                  <label className="rc-field">
                    <span className="rc-field__label">Limit (bikes; empty lifts it)</span>
                    <input
                      className="rc-input"
                      name="limit"
                      inputMode="numeric"
                      defaultValue={picked.manualLimit ?? ''}
                    />
                  </label>
                  <label className="rc-field">
                    <span className="rc-field__label">Why (logged)</span>
                    <input
                      className="rc-input"
                      name="reason"
                      minLength={3}
                      maxLength={200}
                      required
                    />
                  </label>
                  <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                    Save limit
                  </button>
                </form>
              )}
            </section>
          )}

          {canHold(me) && (
            <section className="rc-card stack">
              <h2 style={{ margin: 0 }}>Hold for a client</h2>
              <Info label="How this works">
                Keeps bikes for a brand until the end you set (no money). It blocks other brands
                only where an area-hour has a limit. Pick a cell to start from it.
              </Info>
              <form className="stack" onSubmit={hold} aria-label="Hold">
                <label className="rc-field">
                  <span className="rc-field__label">Brand id (e.g. chai-co)</span>
                  <input className="rc-input" name="brand" pattern="[a-z0-9][a-z0-9-]*" required />
                </label>
                <fieldset className="areas">
                  <legend>Days</legend>
                  {week.days.map((d) => (
                    <label key={d}>
                      <input
                        type="checkbox"
                        checked={days.includes(d)}
                        onChange={() => setDays(toggle(days, d))}
                      />
                      {dayName(d)}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="areas">
                  <legend>Start hours</legend>
                  {START_HOURS.map((h) => (
                    <label key={h}>
                      <input
                        type="checkbox"
                        checked={hours.includes(h)}
                        onChange={() => setHours(toggle(hours, h))}
                      />
                      {hourLabel(h)}
                    </label>
                  ))}
                </fieldset>
                <div className="tiles">
                  <label className="rc-field">
                    <span className="rc-field__label">Bikes in each hour</span>
                    <input className="rc-input" name="bikes" inputMode="numeric" required />
                  </label>
                  <label className="rc-field">
                    <span className="rc-field__label">Ends on (India time)</span>
                    <input className="rc-input" name="endDate" type="date" required />
                  </label>
                  <label className="rc-field">
                    <span className="rc-field__label">at</span>
                    <input
                      className="rc-input"
                      name="endTime"
                      type="time"
                      defaultValue="18:00"
                      required
                    />
                  </label>
                </div>
                <label className="rc-field">
                  <span className="rc-field__label">Why (logged)</span>
                  <input
                    className="rc-input"
                    name="reason"
                    minLength={3}
                    maxLength={200}
                    required
                  />
                </label>
                <button
                  className="rc-button"
                  type="submit"
                  disabled={busy || days.length === 0 || hours.length === 0}
                >
                  Hold
                </button>
              </form>
            </section>
          )}

          <section>
            <h2>Holds this week</h2>
            {week.holds.length === 0 && <p className="muted">None.</p>}
            <ul className="plain">
              {week.holds.map((h) => (
                <li className="rc-card stack" key={h.holdId}>
                  <strong>
                    {h.brandId} · {h.holdId}
                  </strong>
                  <span>{linesText(h)}</span>
                  <span className="muted">
                    {holdStatus(h, now)} · by {h.heldBy}
                    {h.reason ? ` · ${h.reason}` : ''}
                  </span>
                  {canHold(me) && holdLive(h, now) && (
                    <div className="stack">
                      <button
                        className="rc-button rc-button--secondary"
                        type="button"
                        onClick={() => book(h)}
                        disabled={busy}
                      >
                        Turn into a booking
                      </button>
                      <form
                        className="areas"
                        onSubmit={release(h)}
                        aria-label={`Release ${h.holdId}`}
                      >
                        <input
                          className="rc-input"
                          name="reason"
                          placeholder="Why release it"
                          aria-label="Why release it"
                          minLength={3}
                          maxLength={200}
                          required
                        />
                        <button
                          className="rc-button rc-button--quiet"
                          type="submit"
                          disabled={busy}
                        >
                          Release
                        </button>
                      </form>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Shell>
  );
}
