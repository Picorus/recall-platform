'use client';
// P5.4 Book: areas picked on RECALL's map (its own shapes), hours (single hours or ready-made
// picks, each with its price band), the days of the week, a start date and how many weeks, bikes
// each hour, and an optional monthly repeat (6 months 8% off, 12 months 12% off). A live summary
// prices it as it changes (bike-hours, plays promised, price, GST, total) and says what stops it
// (under the minimum, too soon, hours sold). "Book again" opens with an earlier booking's plan.
import { Info } from '@recall/web-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type Account,
  type BookForm,
  type Plan,
  type PlanPrice,
} from '../../lib/api';
import { daysText, rupees } from '../../lib/format';
import { Icon } from '../../lib/icons';
import { areaPhoto } from '../../lib/photos';
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

  if (!me || !form || !plan)
    return (
      <main className="narrow">
        <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>
      </main>
    );
  const set = (p: Partial<Plan>) => setPlan({ ...plan, ...p });
  const ok = price?.price !== null && price !== undefined && price.problems.length === 0;
  return (
    <Shell me={me}>
      <header className="page-head">
        <p className="eyebrow">New campaign</p>
        <h1>Book{account ? ` for ${account.name}` : ''}</h1>
      </header>
      <div className="book">
        <div className="stack">
          <section className="rc-card stack step" aria-label="Areas">
            <h2>
              <span className="step__n">1</span>Areas
            </h2>
            <p className="muted">Tap the areas where your ads should play.</p>
            <div className="area-cards" role="group" aria-label="Areas to pick">
              {form.areas.map((a) => {
                const on = plan.areaIds.includes(a.areaId);
                const flip = () => set({ areaIds: toggle(plan.areaIds, a.areaId) });
                return (
                  <div
                    key={a.areaId}
                    role="checkbox"
                    aria-checked={on}
                    aria-label={a.name}
                    tabIndex={0}
                    className={on ? 'area-card on' : 'area-card'}
                    onClick={flip}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        flip();
                      }
                    }}
                  >
                    <img src={areaPhoto(a.name)} alt="" loading="lazy" />
                    <span className="area-card__tick" aria-hidden="true">
                      <Icon name="check" size={16} />
                    </span>
                    <span className="area-card__name">{a.name}</span>
                  </div>
                );
              })}
            </div>
            <p>
              {plan.areaIds.length === 0
                ? 'No area picked yet.'
                : `Picked: ${form.areas
                    .filter((a) => plan.areaIds.includes(a.areaId))
                    .map((a) => a.name)
                    .join(', ')}`}
            </p>
          </section>

          <section className="rc-card stack step" aria-label="Hours">
            <h2>
              <span className="step__n">2</span>Hours
            </h2>
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
                  className={`hour hour--${h.band.toLowerCase()}`}
                  aria-pressed={plan.hours.includes(h.hour)}
                  onClick={() => set({ hours: toggle(plan.hours, h.hour) })}
                >
                  <b>{h.label}</b>
                  <span>
                    <span className="sep">{' · '}</span>
                    {h.band} {rupees(h.paisePerBikeHour)}
                  </span>
                </button>
              ))}
            </div>
            <p className="muted">Prices are per bike for one hour, before GST.</p>
          </section>

          <section className="rc-card stack step" aria-label="Days">
            <h2>
              <span className="step__n">3</span>Days and bikes
            </h2>
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

          <section className="rc-card stack step" aria-label="Repeat">
            <h2>
              <span className="step__n">4</span>Repeat every month <small>(optional)</small>
            </h2>
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
            <Info label="How repeating works">
              The same days again each month. The discount is on Peak and Normal hours. A 6- or
              12-month deal is set up with our sales team: they call you after you continue.
            </Info>
          </section>
        </div>

        <aside
          id="summary"
          className="rc-card stack summary"
          aria-label="Summary"
          aria-live="polite"
        >
          <h2>Summary</h2>
          {price?.price ? (
            <>
              <div className="summary__total">
                <span>Total with GST</span>
                <b className="rc-num">{rupees(price.price.totalPaise)}</b>
              </div>
              <dl className="facts summary__facts rc-num">
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
              </dl>
            </>
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
            className="rc-button rc-button--primary rc-button--large rc-button--block"
            disabled={!ok || busy}
            aria-busy={busy}
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
      {/* On a phone the summary is at the end of the page: the total stays in sight at the bottom. */}
      <div className="book-bar">
        <span className="rc-num">
          {price?.price ? (
            <>
              <small>Total with GST</small>
              <b>{rupees(price.price.totalPaise)}</b>
            </>
          ) : (
            <small>Pick areas and hours to see the price</small>
          )}
        </span>
        <a className="rc-button rc-button--strong rc-button--small" href="#summary">
          Review
        </a>
      </div>
    </Shell>
  );
}
