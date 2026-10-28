'use client';
// P5.10 Statement: an agency's month with RECALL: its share (cut) on each booking our team gave one,
// the GST it charges on it, the TDS held back, what we paid and its invoices, opening and closing.
// Its share never shows on a brand's invoice.
import { Fold, foldHint, Info, latestOf } from '@recall/web-ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Statement } from '../../lib/api';
import { rupees } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';

const monthText = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
/** "2027-08" and n months before or after. */
const shift = (m: string, n: number) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const dateOf = (t: number) =>
  new Date((t + 19_800) * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export default function StatementPage() {
  const me = useMe();
  const [brand, setBrand] = useState('');
  const [page, setPage] = useState<Statement>();
  const [error, setError] = useState('');

  const load = (b: string, month?: string) =>
    api<Statement>(
      `/statement?brand=${encodeURIComponent(b)}${month ? `&month=${encodeURIComponent(month)}` : ''}`,
    )
      .then(setPage)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('brand') ?? '';
    setBrand(b);
    void load(b);
  }, []);

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Statement</h1>
        <Link className="back-link" href={`/campaigns?brand=${encodeURIComponent(brand)}`}>
          Back
        </Link>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <div className="row">
            <button
              type="button"
              className="rc-button rc-button--secondary"
              onClick={() => void load(brand, shift(page.month, -1))}
            >
              ← {monthText(shift(page.month, -1))}
            </button>
            <h2 style={{ margin: 0 }}>{monthText(page.month)}</h2>
            <button
              type="button"
              className="rc-button rc-button--secondary"
              onClick={() => void load(brand, shift(page.month, 1))}
            >
              {monthText(shift(page.month, 1))} →
            </button>
          </div>
          <dl className="facts" aria-label="Summary">
            <dt>Owed to you at the start</dt>
            <dd>{rupees(page.openingPaise)}</dd>
            <dt>Owed to you at the end</dt>
            <dd>
              <b>{rupees(page.closingPaise)}</b>
            </dd>
          </dl>
          <section className="stack" aria-label="Your share">
            <h2>Your share, by booking</h2>
            {page.cuts.length === 0 ? (
              <p className="muted">
                Nothing this month. Your share is given by our team on each booking it covers, and
                earned as the plays are delivered.
              </p>
            ) : (
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Booking</th>
                    <th className="num">Share</th>
                    <th className="num wide">GST</th>
                    <th className="num wide">TDS held</th>
                    <th className="num">To you</th>
                  </tr>
                </thead>
                <tbody>
                  {page.cuts.map((c) => (
                    <tr key={c.bookingId}>
                      <td className="mono">{c.bookingId}</td>
                      <td className="num">{rupees(c.cutPaise)}</td>
                      <td className="num wide">{rupees(c.gstPaise)}</td>
                      <td className="num wide">{rupees(c.tdsPaise)}</td>
                      <td className="num">{rupees(c.netPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {page.payments.length > 0 && (
            <section className="stack" aria-label="Paid to you">
              <Fold
                title="Paid to you"
                hint={`${rupees(page.payments.reduce((n, p) => n + p.amountPaise, 0))} · ${foldHint(
                  page.payments.length,
                  ['payment', 'payments'],
                  latestOf(page.payments.map((p) => p.at)),
                )}`}
              >
                <ul className="plain">
                  {page.payments.map((p) => (
                    <li key={`${p.at}-${p.reference}`} className="row">
                      <span className="muted">{dateOf(p.at)}</span>
                      <b>{rupees(p.amountPaise)}</b>
                      <span className="mono">{p.reference}</span>
                    </li>
                  ))}
                </ul>
              </Fold>
            </section>
          )}
          {page.invoices.length > 0 && (
            <section className="stack" aria-label="Your invoices to us">
              <Fold
                title="Your invoices to us"
                hint={foldHint(
                  page.invoices.length,
                  ['invoice', 'invoices'],
                  [...page.invoices]
                    .map((i) => i.invoiceDate)
                    .sort()
                    .at(-1),
                )}
              >
                <ul className="plain">
                  {page.invoices.map((i) => (
                    <li key={i.invoiceNo} className="row">
                      <span className="mono">{i.invoiceNo}</span>
                      <span className="muted">{i.invoiceDate}</span>
                      <span>
                        {rupees(i.taxablePaise)} + GST {rupees(i.gstPaise)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Fold>
            </section>
          )}
          <Info label="How you are paid">
            Send us your GST invoice for your share each month; we pay by bank transfer, less TDS.
            Your share never shows on a brand&apos;s invoice.
          </Info>
        </>
      )}
    </Shell>
  );
}
