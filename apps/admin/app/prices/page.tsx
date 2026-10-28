'use client';
// P3.6 Prices and rules: band prices and hours, deal offers, the floor, minimums, the portal lead
// time, the ad deadline and the trial. Sales and Finance look; a super admin changes them, with a
// reason, as the next version starting now (bookings keep the version they were sold on). "Check"
// asks the price rules first and shows what would change; every version is listed with who,
// when, why and what changed.
import { Fold } from '@recall/web-ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia, rupees } from '../../lib/format';
import {
  BANDS,
  changeOf,
  formOf,
  hourLabel,
  percentBox,
  START_HOURS,
  type BandName,
  type Book,
  type PriceForm,
} from '../../lib/prices';
import { Shell, useMember } from '../../lib/session';

interface Change {
  readonly setting: string;
  readonly before: string;
  readonly after: string;
}

interface Version {
  readonly version: number;
  readonly validFrom: string;
  readonly savedBy: string;
  readonly savedAt: string;
  readonly reason: string | null;
  readonly changes: readonly Change[];
  readonly book: Book;
}

interface Page {
  readonly versions: readonly Version[];
  readonly inForce: number | null;
  readonly plan: Book | null;
}

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const when = (iso: string) => `${dayOfIndia(secs(iso))} ${clock(secs(iso))}`;

function Changes({ rows, first }: { readonly rows: readonly Change[]; readonly first?: boolean }) {
  if (rows.length === 0) return <p className="muted">Nothing changes.</p>;
  return (
    <div className="rc-table-wrap">
      <table className="rc-table">
        <thead>
          <tr>
            <th>Setting</th>
            {!first && <th>Before</th>}
            <th>{first ? 'Value' : 'After'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.setting}>
              <td>{c.setting}</td>
              {!first && <td>{c.before}</td>}
              <td>{c.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Box({
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly disabled: boolean;
  readonly hint?: string;
}) {
  return (
    <label className="rc-field">
      <span className="rc-field__label">
        {label}
        {hint && <span className="muted"> ({hint})</span>}
      </span>
      <input
        className="rc-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode="decimal"
        required
      />
    </label>
  );
}

export default function PricesPage() {
  const me = useMember();
  const [page, setPage] = useState<Page>();
  const [form, setForm] = useState<PriceForm>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState<{
    problems: string[];
    changes: Change[];
    openQuotes?: number;
  }>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Page>('/prices')
      .then((p) => {
        setPage(p);
        const newest = p.versions[0]?.book;
        setForm(newest ? formOf(newest) : undefined);
        setChecked(undefined);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (!me) return <p className="narrow muted">Loading…</p>;
  const isSuper = me.role === 'super-admin';
  const newest = page?.versions[0];
  const inForce = page?.versions.find((v) => v.version === page.inForce);

  const call = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await f();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  const edit = (patch: Partial<PriceForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setChecked(undefined);
  };
  const changeNow = () => {
    if (!newest || !form) return undefined;
    const c = changeOf(newest.book, form);
    if ('problem' in c) {
      setChecked({ problems: [c.problem], changes: [] });
      return undefined;
    }
    return c.change;
  };
  const check = () => {
    const change = changeNow();
    if (!change || !newest) return;
    void call(async () => {
      setChecked(await api('/prices/check', { baseVersion: newest.version, change }));
    });
  };
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const change = changeNow();
    if (!change || !newest) return;
    void call(async () => {
      const r = await api<{ version: number; openQuotes: number }>('/prices', {
        baseVersion: newest.version,
        change,
        reason,
      });
      setReason('');
      load();
      setNote(
        `Version ${r.version} saved. It applies from now; bookings already made keep their prices.` +
          (r.openQuotes
            ? ` ${r.openQuotes} open quote${r.openQuotes === 1 ? '' : 's'} must be quoted again.`
            : ''),
      );
    });
  };
  const start = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void call(async () => {
      await api('/prices', { baseVersion: null, change: {}, reason });
      setReason('');
      load();
      setNote('Version 1 saved: the plan’s prices apply from the start of this month.');
    });
  };
  const locked = !isSuper || busy;

  return (
    <Shell member={me}>
      <h1>Prices and rules</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {page && !newest && (
        <section className="rc-card stack">
          <h2 style={{ margin: 0 }}>No prices saved yet</h2>
          <p>Nothing can be sold until there is a first version. The plan’s prices are:</p>
          {page.plan && <PlanSummary book={page.plan} />}
          {isSuper ? (
            <form className="stack" onSubmit={start} aria-label="Start with the plan’s prices">
              <ReasonBox value={reason} onChange={setReason} />
              <button className="rc-button" type="submit" disabled={busy}>
                Start with these prices
              </button>
            </form>
          ) : (
            <p className="muted">A super admin saves the first version.</p>
          )}
        </section>
      )}
      {newest && form && (
        <>
          <p className="muted">
            {inForce
              ? `Version ${inForce.version} in force since ${when(inForce.validFrom)}.`
              : 'No version is in force yet.'}{' '}
            Prices are per bike-hour, before GST ({percentBox(newest.book.gstBp)}% on top).
            {!isSuper && ' Only a super admin changes them.'}
          </p>
          <form className="stack" onSubmit={save} aria-label="Prices and rules">
            <section className="rc-card stack">
              <h2 style={{ margin: 0 }}>Price bands</h2>
              <div className="tiles">
                {BANDS.map((n) => (
                  <Box
                    key={n}
                    label={`${n} (₹ a bike-hour)`}
                    value={form.prices[n]}
                    onChange={(v) => edit({ prices: { ...form.prices, [n]: v } })}
                    disabled={locked}
                  />
                ))}
              </div>
              <p className="muted">Which band each start hour sells in (India time):</p>
              <div className="tiles">
                {START_HOURS.map((h) => (
                  <label className="rc-field" key={h}>
                    <span className="rc-field__label">{hourLabel(h)}</span>
                    <select
                      className="rc-input"
                      value={form.hourBands[h] ?? ''}
                      disabled={locked}
                      aria-label={`Band at ${hourLabel(h)}`}
                      onChange={(e) =>
                        edit({
                          hourBands: { ...form.hourBands, [h]: e.target.value as BandName },
                        })
                      }
                    >
                      {BANDS.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <Box
                label="Floor (₹ a bike-hour)"
                hint="no price, offer or discount goes below it"
                value={form.floor}
                onChange={(v) => edit({ floor: v })}
                disabled={locked}
              />
            </section>

            <section className="rc-card stack">
              <h2 style={{ margin: 0 }}>Deal offers</h2>
              <p className="muted">
                A discount on the bill for long deals, on Peak and Normal hours only (never Lite).
              </p>
              {form.offers.map((o, i) => (
                <div className="tiles" key={i}>
                  <Box
                    label="Months"
                    value={o.months}
                    onChange={(v) =>
                      edit({
                        offers: form.offers.map((x, j) => (j === i ? { ...x, months: v } : x)),
                      })
                    }
                    disabled={locked}
                  />
                  <Box
                    label="Discount (%)"
                    value={o.percent}
                    onChange={(v) =>
                      edit({
                        offers: form.offers.map((x, j) => (j === i ? { ...x, percent: v } : x)),
                      })
                    }
                    disabled={locked}
                  />
                  {!locked && (
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      onClick={() => edit({ offers: form.offers.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {!locked && (
                <button
                  className="rc-button rc-button--secondary"
                  type="button"
                  onClick={() => edit({ offers: [...form.offers, { months: '', percent: '' }] })}
                >
                  Add an offer
                </button>
              )}
              <Box
                label="Each month of a deal may differ from its share by (%)"
                value={form.spread}
                onChange={(v) => edit({ spread: v })}
                disabled={locked}
              />
            </section>

            <section className="rc-card stack">
              <h2 style={{ margin: 0 }}>Booking rules</h2>
              <div className="tiles">
                <Box
                  label="Minimum bikes a line"
                  value={form.minBikes}
                  onChange={(v) => edit({ minBikes: v })}
                  disabled={locked}
                />
                <Box
                  label="Minimum spend a booking (₹)"
                  value={form.minBooking}
                  onChange={(v) => edit({ minBooking: v })}
                  disabled={locked}
                />
                <Box
                  label="Portal bookings start at least (days ahead)"
                  value={form.leadDays}
                  onChange={(v) => edit({ leadDays: v })}
                  disabled={locked}
                />
                <Box
                  label="Ads due (days before the first hour)"
                  value={form.adsDays}
                  onChange={(v) => edit({ adsDays: v })}
                  disabled={locked}
                />
              </div>
              <p className="muted">
                The lead time is for brands booking in their own portal; staff can book for any
                start date.
              </p>
            </section>

            <section className="rc-card stack">
              <h2 style={{ margin: 0 }}>Free trial</h2>
              <div className="tiles">
                <Box
                  label="Length (days)"
                  value={form.trialDays}
                  onChange={(v) => edit({ trialDays: v })}
                  disabled={locked}
                />
                <Box
                  label="Bike-hours at most"
                  value={form.trialBikeHours}
                  onChange={(v) => edit({ trialBikeHours: v })}
                  disabled={locked}
                />
              </div>
              <p className="muted">One trial per business (phone and GST number), in one area.</p>
            </section>

            {isSuper && (
              <section className="rc-card stack">
                <h2 style={{ margin: 0 }}>Save as a new version</h2>
                <button
                  className="rc-button rc-button--secondary"
                  type="button"
                  onClick={check}
                  disabled={busy}
                >
                  Check
                </button>
                {checked && (
                  <div className="stack" aria-label="Check result">
                    {checked.problems.length > 0 ? (
                      <ul className="error" role="alert">
                        {checked.problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>The price rules allow this.</p>
                    )}
                    {checked.changes.length > 0 && <Changes rows={checked.changes} />}
                    {!!checked.openQuotes && (
                      <p>
                        {checked.openQuotes} open quote{checked.openQuotes === 1 ? '' : 's'} will
                        need a new quote at these prices before payment.
                      </p>
                    )}
                  </div>
                )}
                <ReasonBox value={reason} onChange={setReason} />
                <button className="rc-button" type="submit" disabled={busy}>
                  Save
                </button>
                <button
                  className="rc-button rc-button--quiet"
                  type="button"
                  onClick={() => {
                    setForm(formOf(newest.book));
                    setChecked(undefined);
                  }}
                  disabled={busy}
                >
                  Undo my edits
                </button>
              </section>
            )}
          </form>

          <Fold
            title="Versions"
            hint={`${page?.versions.length ?? 0} saved${page?.inForce ? `, version ${page.inForce} in force` : ''} · what changed, who and why`}
          >
            <ul className="plain">
              {page?.versions.map((v) => (
                <li className="rc-card stack" key={v.version}>
                  <strong>
                    Version {v.version}
                    {v.version === page.inForce ? ' (in force)' : ''} · from {when(v.validFrom)}
                  </strong>
                  <span className="muted">
                    Saved by {v.savedBy} · {v.reason ?? 'no reason recorded'}
                  </span>
                  <Changes rows={v.changes} first={v.version === 1} />
                </li>
              ))}
            </ul>
          </Fold>
        </>
      )}
    </Shell>
  );
}

function ReasonBox({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
}) {
  return (
    <label className="rc-field">
      <span className="rc-field__label">Reason (kept with the version)</span>
      <input
        className="rc-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={3}
        maxLength={200}
        required
      />
    </label>
  );
}

function PlanSummary({ book }: { readonly book: Book }) {
  return (
    <dl className="facts">
      {book.bands.map((b) => (
        <div key={b.name} style={{ display: 'contents' }}>
          <dt>{b.name}</dt>
          <dd>
            {rupees(b.paisePerBikeHour)} a bike-hour · {b.startHours.map(hourLabel).join(' ')}
          </dd>
        </div>
      ))}
      <dt>Floor</dt>
      <dd>{rupees(book.floorPaisePerBikeHour)}</dd>
      <dt>Minimums</dt>
      <dd>
        {book.minBikesPerLine} bikes a line · {rupees(book.minBookingPaise)} a booking
      </dd>
      <dt>Deadlines</dt>
      <dd>
        Portal bookings {book.portalLeadDays} days ahead · ads {book.adsDueDays} days before
      </dd>
      <dt>Trial</dt>
      <dd>
        {book.trialDays} days · {book.trialBikeHours} bike-hours
      </dd>
    </dl>
  );
}
