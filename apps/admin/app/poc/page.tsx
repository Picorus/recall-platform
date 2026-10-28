'use client';
// P7.8 POC (Sales): the brands on the POC package side by side: each month paid, with a link out,
// to pay or missed; plays this month and today; the bikes fitted against the POC's most. A Sales
// admin (or a super admin) adds a brand with its commitment and its 2 to 5 ads, sends a month's
// payment link (a month is paid before it starts, or never plays) and opens a brand's numbers.
import { BarChart, dayLabel, Info, Meter, rupeesShort } from '@recall/web-ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AdView } from '../../lib/ads';
import { api, ApiError } from '../../lib/api';
import type { AccountRow } from '../../lib/brands';
import { count, dayOfIndia, rupees } from '../../lib/format';
import {
  commitmentMonths,
  MONTH_CHIP,
  MONTH_STATE,
  monthShort,
  startMonths,
  type PocDesk,
  type PocDeskBrand,
  type PocReport,
} from '../../lib/poc';
import { Shell, useMember } from '../../lib/session';

const failed = (e: unknown, what: string) => (e instanceof ApiError ? e.message : what);

const PHASE_TEXT = {
  none: 'Not switched on',
  scheduled: 'Scheduled',
  running: 'On',
  ended: 'Ended',
} as const;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rc-stat">
      <span className="rc-stat__label">{label}</span>
      <span className="rc-stat__value">{value}</span>
      {note && <span className="rc-stat__note">{note}</span>}
    </div>
  );
}

/** A Sales admin adds a brand: its first month, how many, its ads (each reviewed as usual). */
function AddBrand({ desk, onDone }: { readonly desk: PocDesk; readonly onDone: () => void }) {
  const [accounts, setAccounts] = useState<readonly AccountRow[]>([]);
  const [brandId, setBrandId] = useState('');
  const [ads, setAds] = useState<readonly AdView[]>([]);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const firsts = startMonths(desk.openFrom, desk.phase);
  const [first, setFirst] = useState(firsts[0] ?? '');
  const lengths = first ? commitmentMonths(first, desk.phase, desk.rules.pocMonths) : [];
  const [months, setMonths] = useState(desk.rules.pocMonths);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ accounts: AccountRow[] }>('/brands')
      .then((r) => setAccounts(r.accounts))
      .catch((e: unknown) => setError(failed(e, 'Could not load the brands.')));
  }, []);
  useEffect(() => {
    setPicked([]);
    if (!brandId) return setAds([]);
    api<{ ads: AdView[] }>(`/ads?brand=${encodeURIComponent(brandId)}`)
      .then((r) =>
        setAds(r.ads.filter((a) => a.outcome !== 'fail' && a.review?.decision !== 'rejected')),
      )
      .catch((e: unknown) => setError(failed(e, 'Could not load its ads.')));
  }, [brandId]);
  const taken = new Set(desk.brands.map((b) => b.brandId));
  const choices = accounts.filter((a) => a.kind === 'brand' && a.active && !taken.has(a.brandId));
  const n = Math.min(months, lengths.length || 1);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/poc/brands', { brandId, firstMonth: first, months: n, adIds: picked, reason });
      setBrandId('');
      setReason('');
      onDone();
    } catch (err) {
      setError(failed(err, 'Could not add the brand.'));
    } finally {
      setBusy(false);
    }
  };
  if (firsts.length === 0)
    return (
      <p className="muted">
        Brands join a POC that is switched on (Settings, a super admin): none can join now.
      </p>
    );
  return (
    <form className="rc-card stack" onSubmit={(e) => void save(e)} aria-label="Add a POC brand">
      <h2 style={{ margin: 0 }}>Add a brand</h2>
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Brand</span>
          <select
            className="rc-input"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {choices.map((a) => (
              <option key={a.brandId} value={a.brandId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">From</span>
          <select className="rc-input" value={first} onChange={(e) => setFirst(e.target.value)}>
            {firsts.map((m) => (
              <option key={m} value={m}>
                {monthShort(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Months</span>
          <select
            className="rc-input"
            value={n}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            {lengths.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      {brandId && (
        <fieldset className="plain stack" aria-label="Its ads">
          <legend className="rc-field__label">
            Its ads: choose 2 to 5 (only approved ones play)
          </legend>
          {ads.length === 0 && <p className="muted">No ads yet: upload them on the Brands page.</p>}
          {ads.map((a) => (
            <label key={a.adId}>
              <input
                type="checkbox"
                checked={picked.includes(a.adId)}
                onChange={(e) =>
                  setPicked(
                    e.target.checked ? [...picked, a.adId] : picked.filter((x) => x !== a.adId),
                  )
                }
              />{' '}
              {a.name} · {a.review?.decision === 'approved' ? 'approved' : 'waiting for review'}
            </label>
          ))}
        </fieldset>
      )}
      <p className="muted">
        {n} {n === 1 ? 'month' : 'months'} × {rupees(desk.rules.feePaise)} + GST, each paid before
        it starts.
      </p>
      <label className="rc-field">
        <span className="rc-field__label">Why (kept with it)</span>
        <input
          className="rc-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={5}
          maxLength={300}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          className="rc-button rc-button--primary"
          disabled={
            busy || !brandId || picked.length < 2 || picked.length > 5 || reason.trim().length < 5
          }
        >
          Add to the POC
        </button>
      </div>
    </form>
  );
}

/** A brand's numbers for a month: plays, bikes, hours, by day; streets; people (an estimate). */
function Numbers({ brand, month }: { readonly brand: PocDeskBrand; readonly month: string }) {
  const [r, setR] = useState<PocReport>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<PocReport>(
      `/poc/report?brand=${encodeURIComponent(brand.brandId)}&month=${encodeURIComponent(month)}`,
    )
      .then(setR)
      .catch((e: unknown) => setError(failed(e, 'Could not load the numbers.')));
  }, [brand.brandId, month]);
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!r) return <p className="muted">Loading…</p>;
  return (
    <section className="rc-card stack" aria-label={`${brand.name}, ${monthShort(month)}`}>
      <h2 style={{ margin: 0 }}>
        {brand.name}, {monthShort(month)}
      </h2>
      <div className="tiles">
        <Stat label="Plays" value={count(r.plays)} />
        <Stat label="Different bikes" value={count(r.bikes)} />
        <Stat label="Bike-hours" value={count(r.bikeHours)} note="hours a bike played it" />
        <Stat label="People" value={r.people.text} note="an estimate, never billed" />
      </div>
      <BarChart
        title="Plays by day"
        points={r.days.map((d) => ({ label: dayLabel(d.day), value: d.plays }))}
        empty="No plays yet this month."
      />
      {r.streets.length > 0 && (
        <p>Busiest streets: {r.streets.map((s) => `${s.name} (${count(s.plays)})`).join(', ')}</p>
      )}
    </section>
  );
}

export default function PocPage() {
  const me = useMember();
  const [desk, setDesk] = useState<PocDesk>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<string>();
  const load = useCallback(() => {
    api<PocDesk>('/poc')
      .then((d) => {
        setDesk(d);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e, 'Could not load the POC.')));
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);
  const act = async (path: string, ref: string) => {
    setNote('');
    try {
      const r = await api<{ url?: string; outcome?: string }>(path, { ref });
      setNote(
        r.url ? `Payment link for ${ref}: ${r.url}` : `Payment for ${ref}: ${r.outcome ?? ''}`,
      );
      load();
    } catch (e) {
      setError(failed(e, 'Could not reach the payment provider.'));
    }
  };
  if (!me) return <p className="muted">Loading…</p>;
  const thisMonth = desk?.brands.filter((b) => b.months.some((m) => m.month === desk.month)) ?? [];
  const paid = thisMonth.filter((b) =>
    b.months.some((m) => m.month === desk?.month && m.state === 'paid'),
  );
  const opened = desk?.brands.find((b) => b.brandId === open);
  return (
    <Shell member={me}>
      <h1>POC</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {desk && (
        <>
          <Info label="How the POC package works">
            Up to {desk.rules.maxBrands} brands each pay {rupees(desk.rules.feePaise)} + GST a
            month, before the month starts. On every bike, every business hour, inside the POC zone,
            each brand paid for the month gets {desk.perBrand} plays, in turn; RECALL&apos;s own ads
            fill every sixth spot and any free slot. Nothing is promised: no make-ups, no refunds.
          </Info>
          <div className="tiles">
            <Stat
              label="The POC"
              value={PHASE_TEXT[desk.phase.phase]}
              note={
                desk.phase.phase === 'none'
                  ? 'a super admin switches it on in Settings'
                  : `from ${dayOfIndia(desk.phase.startsAt)}; planned to ${dayOfIndia(desk.phase.plannedEnd - 86_400)}`
              }
            />
            <Stat
              label={`Brands in ${monthShort(desk.month)}`}
              value={`${count(thisMonth.length)} of ${count(desk.rules.maxBrands)}`}
              note={`${count(paid.length)} paid`}
            />
            <Stat
              label="Fee a month"
              value={rupeesShort(desk.rules.feePaise)}
              note="+ GST, paid before the month"
            />
          </div>
          <Meter
            label="Bikes with a screen"
            value={desk.bikes.fitted}
            max={desk.bikes.max}
            note={`of ${count(desk.bikes.max)} the POC allows`}
            tone={desk.bikes.fitted >= desk.bikes.max ? 'stop' : 'data'}
          />
          <BarChart
            title={`Plays this month, brand by brand (${monthShort(desk.month)})`}
            summary={`${count(desk.brands.reduce((s, b) => s + b.playsMonth, 0))} plays`}
            points={desk.brands.map((b) => ({ label: b.name, value: b.playsMonth }))}
            maxLabels={12}
            empty="No POC plays yet this month."
          />
          {note && <p role="status">{note}</p>}
          <div className="rc-table-wrap">
            <table className="rc-table" aria-label="POC brands">
              <thead>
                <tr>
                  <th>Brand</th>
                  <th>Months</th>
                  <th>Plays this month</th>
                  <th>Today</th>
                  <th>Ads</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {desk.brands.map((b) => (
                  <tr key={b.brandId}>
                    <td>{b.name}</td>
                    <td>
                      <div className="areas">
                        {b.months.map((m) => (
                          <span key={m.month} className="row">
                            <span className={`rc-chip ${MONTH_CHIP[m.state]}`}>
                              {monthShort(m.month)}: {MONTH_STATE[m.state]}
                            </span>
                            {desk.canChange &&
                              (m.state === 'to-pay' || m.state === 'link-sent') && (
                                <button
                                  type="button"
                                  className="rc-button rc-button--quiet rc-button--small"
                                  onClick={() =>
                                    void act(
                                      m.state === 'to-pay' ? '/poc/pay' : '/poc/check',
                                      m.ref,
                                    )
                                  }
                                >
                                  {m.state === 'to-pay' ? 'Send link' : 'Check payment'}
                                </button>
                              )}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{count(b.playsMonth)}</td>
                    <td>{count(b.playsToday)}</td>
                    <td>
                      {b.ads.filter((a) => a.approved).length} of {b.ads.length} approved
                    </td>
                    <td>
                      <button
                        type="button"
                        className="rc-button rc-button--secondary rc-button--small"
                        onClick={() => setOpen(open === b.brandId ? undefined : b.brandId)}
                      >
                        {open === b.brandId ? 'Close' : 'Numbers'}
                      </button>
                    </td>
                  </tr>
                ))}
                {desk.brands.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No POC brands yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {opened && (
            <Numbers
              brand={opened}
              month={
                opened.months.find((m) => m.month === desk.month)?.month ??
                opened.months[0]?.month ??
                desk.month
              }
            />
          )}
          {desk.canChange && <AddBrand desk={desk} onDone={load} />}
        </>
      )}
    </Shell>
  );
}
