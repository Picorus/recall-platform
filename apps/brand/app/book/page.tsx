'use client';
// P5.4 Book: areas picked on RECALL's map (its own shapes), hours (single hours or ready-made
// picks, each with its price band), the days of the week, a start date and how many weeks, bikes
// each hour, and an optional monthly repeat (6 months 8% off, 12 months 12% off). A live summary
// prices it as it changes (bike-hours, plays promised, price, GST, total) and says what stops it
// (under the minimum, too soon, hours sold). "Book again" opens with an earlier booking's plan.
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { pathOf, projector } from '../../lib/area-map';
import {
  api,
  ApiError,
  type Account,
  type BookForm,
  type Plan,
  type PlanPrice,
} from '../../lib/api';
import { daysText, rupees } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const toggle = <T,>(list: readonly T[], x: T) =>
  list.includes(x) ? list.filter((y) => y !== x) : [...list, x];

export default function BookPage() {
  const me = useMe();
  const router = useRouter();
  const [brand, setBrand] = useState('');
  const [account, setAccount] = useState<Account>();
  const [form, setForm] = useState<BookForm>();
  const [plan, setPlan] = useState<Plan>();
  const [price, setPrice] = useState<PlanPrice>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const b = q.get('brand') ?? '';
    const again = q.get('again');
    setBrand(b);
    api<{ account: Account; form: BookForm; plan: Plan | null }>(
      `/book-form?brand=${encodeURIComponent(b)}${again ? `&again=${encodeURIComponent(again)}` : ''}`,
    )
      .then((r) => {
        setAccount(r.account);
        setForm(r.form);
        setPlan(
          r.plan ?? {
            areaIds: [],
            hours: [],
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            startDate: r.form.earliestStart,
            weeks: 1,
            bikes: 20,
            repeatMonths: 1,
          },
        );
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  }, []);

  // The live price: asked a moment after the last change; only the newest answer counts.
  const asked = useRef(0);
  useEffect(() => {
    if (!plan || !brand) return;
    const mine = ++asked.current;
    // The price on screen is for the plan before: never booked by mistake on a stale one.
    setPrice(undefined);
    const t = setTimeout(() => {
      api<PlanPrice>(`/quote?brand=${encodeURIComponent(brand)}`, { plan })
        .then((p) => mine === asked.current && setPrice(p))
        .catch(
          (e: unknown) =>
            mine === asked.current &&
            setPrice({ price: null, problems: [e instanceof ApiError ? e.message : 'Try again'] }),
        );
    }, 350);
    return () => clearTimeout(t);
  }, [plan, brand]);

  const at = useMemo(
    () =>
      form
        ? projector(
            form.areas.map((a) => a.ring),
            640,
            420,
          )
        : undefined,
    [form],
  );

  const book = async () => {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ bookingId: string }>(`/bookings?brand=${encodeURIComponent(brand)}`, {
        plan,
      });
      // Next: its ads (a brand's), then review and pay.
      const b = encodeURIComponent(brand);
      const id = encodeURIComponent(r.bookingId);
      router.replace(
        account?.kind === 'agency'
          ? `/pay?brand=${b}&booking=${id}`
          : `/ads?brand=${b}&booking=${id}`,
      );
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.');
      setBusy(false);
    }
  };

  if (!me || !form || !plan || !at)
    return (
      <main className="narrow">
        <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>
      </main>
    );
  const set = (p: Partial<Plan>) => setPlan({ ...plan, ...p });
  const ok = price?.price !== null && price !== undefined && price.problems.length === 0;
  return (
    <Shell me={me}>
      <h1>Book{account ? ` for ${account.name}` : ''}</h1>
      <div className="book">
        <div className="stack">
          <section className="rc-card stack" aria-label="Areas">
            <h2>1 · Areas</h2>
            <p className="muted">Tap the areas where your ads should play.</p>
            <svg viewBox="0 0 640 420" className="area-map" role="group" aria-label="Map of areas">
              {form.areas.map((a) => {
                const on = plan.areaIds.includes(a.areaId);
                const [cx, cy] = at(a.centre);
                return (
                  <g
                    key={a.areaId}
                    role="checkbox"
                    aria-checked={on}
                    aria-label={a.name}
                    tabIndex={0}
                    onClick={() => set({ areaIds: toggle(plan.areaIds, a.areaId) })}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        set({ areaIds: toggle(plan.areaIds, a.areaId) });
                      }
                    }}
                    className={on ? 'area on' : 'area'}
                  >
                    <path d={pathOf(a.ring, at)} />
                    <text x={cx} y={cy} textAnchor="middle">
                      {a.name}
                    </text>
                  </g>
                );
              })}
            </svg>
            <p>
              {plan.areaIds.length === 0
                ? 'No area picked yet.'
                : `Picked: ${form.areas
                    .filter((a) => plan.areaIds.includes(a.areaId))
                    .map((a) => a.name)
                    .join(', ')}`}
            </p>
          </section>

          <section className="rc-card stack" aria-label="Hours">
            <h2>2 · Hours</h2>
            <div className="row" role="group" aria-label="Ready-made picks">
              {form.picks.map((p) => {
                const on = p.hours.every((h) => plan.hours.includes(h));
                return (
                  <button
                    key={p.key}
                    type="button"
                    className="rc-chip"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        hours: on
                          ? plan.hours.filter((h) => !p.hours.includes(h))
                          : [...new Set([...plan.hours, ...p.hours])],
                      })
                    }
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="hours" role="group" aria-label="Single hours">
              {form.hours.map((h) => (
                <button
                  key={h.hour}
                  type="button"
                  className="rc-chip"
                  aria-pressed={plan.hours.includes(h.hour)}
                  onClick={() => set({ hours: toggle(plan.hours, h.hour) })}
                >
                  {h.label} · {h.band} {rupees(h.paisePerBikeHour)}
                </button>
              ))}
            </div>
            <p className="muted">Prices are per bike for one hour, before GST.</p>
          </section>

          <section className="rc-card stack" aria-label="Days">
            <h2>3 · Days and bikes</h2>
            <div className="row" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  className="rc-chip"
                  aria-pressed={plan.weekdays.includes(i + 1)}
                  onClick={() => set({ weekdays: toggle(plan.weekdays, i + 1) })}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="fields">
              <label className="rc-field">
                <span className="rc-field__label">Start from</span>
                <input
                  className="rc-input"
                  type="date"
                  min={form.earliestStart}
                  value={plan.startDate}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
                <span className="rc-field__help">
                  At least {form.leadDays} days ahead; sooner through our team.
                </span>
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Weeks</span>
                <input
                  className="rc-input"
                  type="number"
                  min={1}
                  max={form.maxWeeks}
                  value={plan.weeks}
                  onChange={(e) => set({ weeks: Number(e.target.value) })}
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Bikes each hour</span>
                <input
                  className="rc-input"
                  type="number"
                  min={form.minBikes}
                  max={form.maxBikes}
                  value={plan.bikes}
                  onChange={(e) => set({ bikes: Number(e.target.value) })}
                />
                <span className="rc-field__help">
                  {form.minBikes} to {form.maxBikes}, in each area.
                </span>
              </label>
            </div>
          </section>

          <section className="rc-card stack" aria-label="Repeat">
            <h2>4 · Repeat every month (optional)</h2>
            <div className="row" role="radiogroup" aria-label="Repeat">
              {[1, ...Object.keys(form.repeatOffersBp).map(Number)].map((m) => (
                <button
                  key={m}
                  type="button"
                  className="rc-chip"
                  role="radio"
                  aria-checked={plan.repeatMonths === m}
                  aria-pressed={plan.repeatMonths === m}
                  onClick={() => set({ repeatMonths: m })}
                >
                  {m === 1
                    ? 'Just once'
                    : `${m} months · ${(form.repeatOffersBp[m] ?? 0) / 100}% off`}
                </button>
              ))}
            </div>
            <p className="muted">
              The same days again each month. The discount is on Peak and Normal hours. A 6- or
              12-month deal is set up with our sales team: they call you after you continue.
            </p>
          </section>
        </div>

        <aside className="rc-card stack summary" aria-label="Summary" aria-live="polite">
          <h2>Summary</h2>
          {price?.price ? (
            <dl className="facts">
              <dt>Dates</dt>
              <dd>{daysText(price.price.firstDay, price.price.lastDay)}</dd>
              <dt>Days</dt>
              <dd>{price.price.days}</dd>
              <dt>Bike-hours</dt>
              <dd>{price.price.bikeHours.toLocaleString('en-IN')}</dd>
              <dt>Plays promised</dt>
              <dd>{price.price.plays.toLocaleString('en-IN')}</dd>
              <dt>Price</dt>
              <dd>{rupees(price.price.listPaise)}</dd>
              {price.price.discountPaise > 0 && (
                <>
                  <dt>Repeat discount</dt>
                  <dd>−{rupees(price.price.discountPaise)}</dd>
                </>
              )}
              <dt>GST</dt>
              <dd>{rupees(price.price.gstPaise)}</dd>
              <dt>Total</dt>
              <dd>
                <b>{rupees(price.price.totalPaise)}</b>
              </dd>
            </dl>
          ) : (
            <p className="muted">Pick areas, hours and days to see the price.</p>
          )}
          {price && price.problems.length > 0 && (
            <ul className="plain" aria-label="To fix">
              {price.problems.map((p) => (
                <li key={p} className="error">
                  {p}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="rc-button rc-button--primary"
            disabled={!ok || busy}
            onClick={() => void book()}
          >
            {busy ? 'Saving…' : 'Continue'}
          </button>
          <p className="muted">
            Nothing is held for you until you pay. Your ads are due {form.adsDueDays} days before
            the start.
          </p>
        </aside>
      </div>
    </Shell>
  );
}
