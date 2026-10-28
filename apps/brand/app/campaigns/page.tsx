'use client';
// P5.3 My campaigns: every booking of the business, under Scheduled (with any not paid yet),
// Running and Done (with any cancelled), each with its areas, days, bike-hours, plays promised and
// total, what comes next, and "Book again". P7.7.7: bike-hours booked by month, as a chart.
import { BarChart, monthLabel, monthsBetween } from '@recall/web-ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Campaign, type Campaigns } from '../../lib/api';
import { daysText, rupees } from '../../lib/format';
import { Icon } from '../../lib/icons';
import { areaPhoto } from '../../lib/photos';
import { Shell, useMe } from '../../lib/session';

type Tab = 'scheduled' | 'running' | 'done';
const TABS: readonly (readonly [Tab, string])[] = [
  ['scheduled', 'Scheduled'],
  ['running', 'Running'],
  ['done', 'Done'],
];
const tabOf = (c: Campaign): Tab =>
  c.stage === 'running'
    ? 'running'
    : c.stage === 'done' || c.stage === 'cancelled' || c.stage === 'missed'
      ? 'done'
      : 'scheduled';
const STAGE: Record<Campaign['stage'], { word: string; chip: string }> = {
  'to-pay': { word: 'To pay', chip: 'rc-chip--paused' },
  scheduled: { word: 'Scheduled', chip: 'rc-chip--offline' },
  running: { word: 'Running', chip: 'rc-chip--go' },
  done: { word: 'Done', chip: 'rc-chip--offline' },
  cancelled: { word: 'Cancelled', chip: 'rc-chip--stop' },
  missed: { word: 'Ads missed', chip: 'rc-chip--stop' },
};

export default function CampaignsPage() {
  const me = useMe();
  const [page, setPage] = useState<Campaigns>();
  const [tab, setTab] = useState<Tab>();
  const [error, setError] = useState('');
  const [brand, setBrand] = useState('');

  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('brand') ?? '';
    setBrand(b);
    api<Campaigns>(`/campaigns?brand=${encodeURIComponent(b)}`)
      .then((p) => {
        setPage(p);
        // Open on what matters now: running, else scheduled, else done.
        const has = (t: Tab) => p.campaigns.some((c) => tabOf(c) === t);
        setTab(has('running') ? 'running' : has('scheduled') ? 'scheduled' : 'done');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  }, []);

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const q = `brand=${encodeURIComponent(brand)}`;
  const shown = page?.campaigns.filter((c) => tabOf(c) === tab) ?? [];
  return (
    <Shell me={me}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <header className="page-head">
            <p className="eyebrow">Campaigns</p>
            <h1>{page.account.name}</h1>
          </header>
          {page.account.via && (
            <p className="muted">
              You book for {page.account.name} through {page.account.via.name}.
            </p>
          )}
          {page.account.kind === 'agency' && (
            <section className="rc-card stack" aria-label="Your brands">
              <h2>Your brands</h2>
              {me.accounts.some((x) => x.via?.agencyId === page.account.brandId) ? (
                <ul className="plain">
                  {me.accounts
                    .filter((x) => x.via?.agencyId === page.account.brandId)
                    .map((x) => (
                      <li key={x.brandId}>
                        {/* A full load: this page reads its business once, when it opens. */}
                        <a href={`/campaigns?brand=${encodeURIComponent(x.brandId)}`}>
                          <b>{x.name}</b>
                        </a>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="muted">
                  No brands linked yet. Ask us on Help to link the brands you book for: you then
                  book and add ads on each brand&apos;s own account, and your share shows on your
                  statement, never on the brand&apos;s invoice.
                </p>
              )}
            </section>
          )}
          {/* A chart only from two months on: one month is already in its campaigns' cards. */}
          {page.months && page.months.length > 1 && <MonthsChart months={page.months} />}
          <div className="rc-segmented" role="tablist" aria-label="Campaigns">
            {TABS.map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
              >
                {label} ({page.campaigns.filter((c) => tabOf(c) === t).length})
              </button>
            ))}
          </div>
          {page.campaigns.length === 0 && (
            <section className="first-camp">
              <img src={areaPhoto('Hitech City')} alt="" />
              <div className="stack">
                <h2 className="display">No campaigns yet</h2>
                <p className="lede">
                  Pick your areas, hours and days, and see the price as you go.
                </p>
                <Link className="rc-button rc-button--primary rc-button--large" href={`/book?${q}`}>
                  Book your first campaign
                </Link>
              </div>
            </section>
          )}
          {page.campaigns.length > 0 && shown.length === 0 && (
            <p className="muted">Nothing here.</p>
          )}
          <ul
            className="camps rc-stagger"
            key={tab}
            aria-label={TABS.find(([t]) => t === tab)?.[1]}
          >
            {shown.map((c) => (
              <li key={c.bookingId} className="camp" aria-label={`Campaign ${c.bookingId}`}>
                <div className="camp__pic">
                  <img src={areaPhoto(c.areas[0] ?? '')} alt="" loading="lazy" />
                  {c.stage === 'running' && (
                    <span className="camp__live">
                      <i />
                      Playing now
                    </span>
                  )}
                </div>
                <div className="camp__body">
                  <div className="camp__head">
                    <div>
                      <h3>{c.areas.join(', ')}</h3>
                      <b className="camp__when">{daysText(c.firstDay, c.lastDay)}</b>
                    </div>
                    <span className={`rc-chip ${STAGE[c.stage].chip}`}>
                      <span className="rc-chip__dot" />
                      {c.trial ? 'Free week · ' : ''}
                      {STAGE[c.stage].word}
                    </span>
                  </div>
                  <dl className="camp__nums rc-num">
                    <div>
                      <dt>Days</dt>
                      <dd>{c.days}</dd>
                    </div>
                    <div>
                      <dt>Bike-hours</dt>
                      <dd>{c.bikeHours.toLocaleString('en-IN')}</dd>
                    </div>
                    <div>
                      <dt>Plays promised</dt>
                      <dd>{c.playsPromised.toLocaleString('en-IN')}</dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>{c.trial ? 'Free' : `${rupees(c.totalPaise)} with GST`}</dd>
                    </div>
                  </dl>
                  {c.note && <p className="muted">{c.note}</p>}
                  <div className="camp__acts">
                    {c.stage === 'to-pay' && (
                      <Link
                        className="rc-button rc-button--primary rc-button--small"
                        href={`/pay?${q}&booking=${encodeURIComponent(c.bookingId)}`}
                      >
                        Review and pay
                      </Link>
                    )}
                    {c.report && (
                      <Link
                        className="rc-button rc-button--strong rc-button--small"
                        href={`/campaigns/${encodeURIComponent(c.bookingId)}/report`}
                      >
                        See the report
                      </Link>
                    )}
                    {page.account.kind === 'brand' &&
                      (c.stage === 'to-pay' || c.stage === 'scheduled') && (
                        <Link
                          className="rc-button rc-button--secondary rc-button--small"
                          href={`/ads?${q}&booking=${encodeURIComponent(c.bookingId)}`}
                        >
                          <Icon name="image" size={16} />
                          Your ads
                        </Link>
                      )}
                    <Link
                      className="rc-button rc-button--quiet rc-button--small"
                      href={`/book?${q}&again=${encodeURIComponent(c.bookingId)}`}
                    >
                      Book again
                    </Link>
                    <span className="mono camp__id">{c.bookingId}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

/** Bike-hours booked and paid for, month by month (the last 12 months with a booking). */
function MonthsChart({ months }: { months: NonNullable<Campaigns['months']> }) {
  const all = monthsBetween(months[0]?.month ?? '', months.at(-1)?.month ?? '').slice(-12);
  const of = new Map(months.map((m) => [m.month, m.bikeHours]));
  const shown = all.map((m) => ({ month: m, bikeHours: of.get(m) ?? 0 }));
  const total = shown.reduce((n, m) => n + m.bikeHours, 0);
  const n = (v: number) => v.toLocaleString('en-IN');
  return (
    <section className="rc-chart-card" aria-label="Bike-hours by month">
      <BarChart
        title="Bike-hours booked, month by month"
        summary={`${n(total)} bike-hours paid for${
          shown.length > 1 ? ` from ${monthLabel(all[0] ?? '', true)}` : ''
        }`}
        points={shown.map((m) => ({
          label: monthLabel(m.month),
          full: monthLabel(m.month, true),
          value: m.bikeHours,
        }))}
        format={(v) => `${n(v)} bike-hours`}
        axisFormat={n}
        valueName="Bike-hours"
        height={140}
      />
    </section>
  );
}
