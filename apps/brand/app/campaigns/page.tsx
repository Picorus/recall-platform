'use client';
// P5.3 My campaigns: every booking of the business, under Scheduled (with any not paid yet),
// Running and Done (with any cancelled), each with its areas, days, bike-hours, plays promised and
// total, what comes next, and "Book again".
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Campaign, type Campaigns } from '../../lib/api';
import { daysText, rupees } from '../../lib/format';
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
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h1>{page.account.name}</h1>
            <div className="row">
              <Link className="rc-button rc-button--primary" href={`/book?${q}`}>
                Book
              </Link>
              <Link href={`/invoices?${q}`}>Invoices</Link>
              <Link href={`/team?${q}`}>Team</Link>
              <Link href={`/help?${q}`}>Help</Link>
              <Link href={`/business?${q}`}>Business details</Link>
              {page.account.kind === 'agency' && <Link href={`/statement?${q}`}>Statement</Link>}
            </div>
          </div>
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
          <div className="row" role="tablist" aria-label="Campaigns">
            {TABS.map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                className="rc-chip"
                aria-selected={tab === t}
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
              >
                {label} ({page.campaigns.filter((c) => tabOf(c) === t).length})
              </button>
            ))}
          </div>
          {page.campaigns.length === 0 && (
            <section className="rc-card stack">
              <h2>No campaigns yet</h2>
              <p>Pick your areas, hours and days, and see the price as you go.</p>
              <Link className="rc-button rc-button--primary" href={`/book?${q}`}>
                Book your first campaign
              </Link>
            </section>
          )}
          {page.campaigns.length > 0 && shown.length === 0 && (
            <p className="muted">Nothing here.</p>
          )}
          <ul className="plain" aria-label={TABS.find(([t]) => t === tab)?.[1]}>
            {shown.map((c) => (
              <li
                key={c.bookingId}
                className="rc-card stack"
                aria-label={`Campaign ${c.bookingId}`}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{daysText(c.firstDay, c.lastDay)}</b>
                  <span className={`rc-chip ${STAGE[c.stage].chip}`}>
                    <span className="rc-chip__dot" />
                    {c.trial ? 'Free week · ' : ''}
                    {STAGE[c.stage].word}
                  </span>
                </div>
                <p>{c.areas.join(', ')}</p>
                <dl className="facts">
                  <dt>Days</dt>
                  <dd>{c.days}</dd>
                  <dt>Bike-hours</dt>
                  <dd>{c.bikeHours.toLocaleString('en-IN')}</dd>
                  <dt>Plays promised</dt>
                  <dd>{c.playsPromised.toLocaleString('en-IN')}</dd>
                  <dt>Total</dt>
                  <dd>{c.trial ? 'Free' : `${rupees(c.totalPaise)} with GST`}</dd>
                </dl>
                {c.note && <p className="muted">{c.note}</p>}
                <div className="row">
                  <span className="mono muted">{c.bookingId}</span>
                  {c.stage === 'to-pay' && (
                    <Link
                      className="rc-button rc-button--primary"
                      href={`/pay?${q}&booking=${encodeURIComponent(c.bookingId)}`}
                    >
                      Review and pay
                    </Link>
                  )}
                  {page.account.kind === 'brand' &&
                    (c.stage === 'to-pay' || c.stage === 'scheduled') && (
                      <Link href={`/ads?${q}&booking=${encodeURIComponent(c.bookingId)}`}>
                        Your ads
                      </Link>
                    )}
                  {c.report && (
                    <Link
                      className="rc-button rc-button--primary"
                      href={`/campaigns/${encodeURIComponent(c.bookingId)}/report`}
                    >
                      See the report
                    </Link>
                  )}
                  <Link href={`/book?${q}&again=${encodeURIComponent(c.bookingId)}`}>
                    Book again
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}
