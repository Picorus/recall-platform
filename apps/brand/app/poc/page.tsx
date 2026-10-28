'use client';
// P7.8.3 POC: a POC brand's own page. Its months (paid, to pay with a Pay button, or not paid in
// time), and what each month delivered: plays, different bikes, bike-hours, by day and month side by
// side; the busiest streets; people who may have seen it (an estimate, never billed). Nothing is
// promised, so there is no target: the numbers as they are.
import { BarChart, dayLabel, Info, monthLabel } from '@recall/web-ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { rupees } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';

type MonthState = 'paid' | 'link-sent' | 'to-pay' | 'missed';

interface PocMonth {
  readonly month: string;
  readonly ref: string;
  readonly feePaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly state: MonthState;
  readonly payBy: number;
  readonly paidAt: number | null;
}

interface PocPage {
  readonly on: boolean;
  readonly perBrand: number;
  readonly months: readonly PocMonth[];
  readonly ads: readonly { adId: string; name: string; approved: boolean }[];
  readonly month: string;
  readonly report: {
    readonly plays: number;
    readonly bikes: number;
    readonly bikeHours: number;
    readonly days: readonly { day: string; plays: number; bikes: number; bikeHours: number }[];
    readonly months: readonly { month: string; plays: number; bikes: number; bikeHours: number }[];
    readonly streets: readonly { name: string; plays: number }[];
    readonly people: { readonly text: string };
  } | null;
}

const STATE: Record<MonthState, string> = {
  paid: 'Paid',
  'link-sent': 'To pay',
  'to-pay': 'To pay',
  missed: 'Not paid in time',
};
const CHIP: Record<MonthState, string> = {
  paid: 'rc-chip--go',
  'link-sent': 'rc-chip--info',
  'to-pay': 'rc-chip--info',
  missed: 'rc-chip--stop',
};
const n = (x: number) => x.toLocaleString('en-IN');
const when = (t: number) =>
  new Date((t + 19_800) * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export default function PocBrandPage() {
  const me = useMe();
  const [brand, setBrand] = useState('');
  const [page, setPage] = useState<PocPage>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = (b: string, month?: string) =>
    api<PocPage>(
      `/poc?brand=${encodeURIComponent(b)}${month ? `&month=${encodeURIComponent(month)}` : ''}`,
    )
      .then((p) => {
        setPage(p);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('brand') ?? '';
    setBrand(b);
    void load(b);
  }, []);
  const pay = async (month: string) => {
    setBusy(month);
    setError('');
    try {
      const link = await api<{ url: string }>(
        `/poc/pay?brand=${encodeURIComponent(brand)}&month=${encodeURIComponent(month)}`,
        {},
      );
      // To the payment provider's page (UPI, card or net banking); never anything but https.
      if (!/^https:\/\//.test(link.url))
        throw new Error('The payment page is not ready. Try again.');
      window.location.assign(link.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy('');
    }
  };
  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const r = page?.report;
  const q = `brand=${encodeURIComponent(brand)}`;
  return (
    <Shell me={me}>
      <h1>Your POC package</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <Info label="How the POC package works">
            Every month you pay for, your ads play on every RECALL bike in the POC zone, every
            business hour: {page.perBrand} plays an hour on each bike, in turn with the other
            brands. Each month is paid before it starts; a month not paid by then does not play.
            Nothing is promised: these are the numbers as they are. Invoices are on the{' '}
            <Link href={`/invoices?${q}`}>Invoices</Link> page.
          </Info>
          <section className="rc-card stack" aria-label="Your months">
            <h2 style={{ margin: 0 }}>Your months</h2>
            <ul className="plain stack">
              {page.months.map((m) => (
                <li key={m.month} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <b>{monthLabel(m.month, true)}</b> · {rupees(m.totalPaise)} with GST
                  </span>
                  <span className="row">
                    <span className={`rc-chip ${CHIP[m.state]}`}>{STATE[m.state]}</span>
                    {m.state === 'paid' && m.paidAt !== null && (
                      <span className="muted">on {when(m.paidAt)}</span>
                    )}
                    {(m.state === 'to-pay' || m.state === 'link-sent') && (
                      <>
                        <span className="muted">by {when(m.payBy)}, 8 am</span>
                        <button
                          type="button"
                          className="rc-button rc-button--primary rc-button--small"
                          disabled={busy !== ''}
                          aria-busy={busy === m.month}
                          onClick={() => void pay(m.month)}
                        >
                          Pay
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {page.months.length > 1 && (
            <div className="row" role="group" aria-label="Month">
              {page.months.map((m) => (
                <button
                  key={m.month}
                  type="button"
                  className={`rc-button rc-button--small ${m.month === page.month ? 'rc-button--secondary' : 'rc-button--quiet'}`}
                  aria-pressed={m.month === page.month}
                  onClick={() => void load(brand, m.month)}
                >
                  {monthLabel(m.month, true)}
                </button>
              ))}
            </div>
          )}
          {r && (
            <section className="stack" aria-label={`${monthLabel(page.month, true)} in numbers`}>
              <h2 style={{ margin: 0 }}>{monthLabel(page.month, true)} in numbers</h2>
              <div className="tiles">
                <div className="rc-stat">
                  <span className="rc-stat__label">Plays</span>
                  <span className="rc-stat__value">{n(r.plays)}</span>
                </div>
                <div className="rc-stat">
                  <span className="rc-stat__label">Different bikes</span>
                  <span className="rc-stat__value">{n(r.bikes)}</span>
                </div>
                <div className="rc-stat">
                  <span className="rc-stat__label">Bike-hours</span>
                  <span className="rc-stat__value">{n(r.bikeHours)}</span>
                  <span className="rc-stat__note">hours a bike played your ads</span>
                </div>
                <div className="rc-stat">
                  <span className="rc-stat__label">People</span>
                  <span className="rc-stat__value">{r.people.text}</span>
                  <span className="rc-stat__note">an estimate, never billed</span>
                </div>
              </div>
              <BarChart
                title="Plays by day"
                points={r.days.map((d) => ({ label: dayLabel(d.day), value: d.plays }))}
                empty="No plays yet this month."
              />
              <BarChart
                title="Your months side by side"
                points={r.months.map((m) => ({ label: monthLabel(m.month), value: m.plays }))}
                valueName="Plays"
              />
              {r.streets.length > 0 && (
                <div className="rc-card stack">
                  <h3 style={{ margin: 0 }}>Busiest streets</h3>
                  <ol>
                    {r.streets.map((s) => (
                      <li key={s.name}>
                        {s.name}: {n(s.plays)} plays
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </Shell>
  );
}
