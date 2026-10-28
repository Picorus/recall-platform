'use client';
// P5.8 Invoices: the business's tax invoices and credit notes for a financial year (April–March),
// newest first; download one, or all of the year's in one PDF.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Invoices } from '../../lib/api';
import { rupees } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';

const dateOf = (t: number) =>
  new Date((t + 19_800) * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
/** "2027-28" → "April 2027 to March 2028". */
const yearText = (fy: string) => `April ${fy.slice(0, 4)} to March ${Number(fy.slice(0, 4)) + 1}`;

export default function InvoicesPage() {
  const me = useMe();
  const [brand, setBrand] = useState('');
  const [page, setPage] = useState<Invoices>();
  const [error, setError] = useState('');

  const load = (b: string, fy?: string) =>
    api<Invoices>(
      `/invoices?brand=${encodeURIComponent(b)}${fy ? `&fy=${encodeURIComponent(fy)}` : ''}`,
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
  const q = `brand=${encodeURIComponent(brand)}`;
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Invoices</h1>
        <Link className="back-link" href={`/campaigns?${q}`}>
          Back to campaigns
        </Link>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <p className="muted">
            Tax invoices are made when you pay; a credit note when money comes back to you. Each
            shows GST as CGST and SGST (Telangana) or IGST (other states).
          </p>
          <div className="row">
            {page.years.length > 1 && (
              <label className="rc-field">
                <span className="rc-field__label">Year</span>
                <select
                  className="rc-input"
                  value={page.fy}
                  onChange={(e) => void load(brand, e.target.value)}
                >
                  {page.years.map((y) => (
                    <option key={y} value={y}>
                      {yearText(y)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {page.documents.length > 0 && (
              <a
                className="rc-button rc-button--secondary"
                href={`/api/invoices/year-pdf?${q}&fy=${encodeURIComponent(page.fy)}`}
                download
              >
                Download all for {yearText(page.fy)}
              </a>
            )}
          </div>
          {page.documents.length === 0 ? (
            <section className="rc-card stack">
              <h2>No invoices yet</h2>
              <p>Your first tax invoice is made as soon as you pay for a campaign.</p>
            </section>
          ) : (
            <table className="doc-table" aria-label={`Invoices ${page.fy}`}>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th className="wide">Campaign</th>
                  <th className="num wide">Before GST</th>
                  <th className="num wide">GST</th>
                  <th className="num">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {page.documents.map((d) => (
                  <tr key={d.docNo}>
                    <td>
                      <span className="mono">{d.docNo}</span>
                      <br />
                      <span className="muted">
                        {d.kind === 'invoice'
                          ? 'Tax invoice'
                          : `Credit note on ${d.againstDoc ?? ''}`}
                      </span>
                    </td>
                    <td>{dateOf(d.issuedAt)}</td>
                    <td className="mono wide">{d.bookingId}</td>
                    <td className="num wide">{rupees(d.taxablePaise)}</td>
                    <td className="num wide">{rupees(d.cgstPaise + d.sgstPaise + d.igstPaise)}</td>
                    <td className="num">
                      {d.kind === 'credit-note' ? '−' : ''}
                      {rupees(d.totalPaise)}
                    </td>
                    <td>
                      <a
                        href={`/api/invoices/pdf?${q}&doc=${d.docNo.replaceAll('/', '-')}`}
                        download
                        aria-label={`Download ${d.docNo}`}
                      >
                        PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {page.truncated && (
            <p className="muted">Showing the latest 500: download all for the year to see each.</p>
          )}
          {page.documents.some((d) => d.gstinHeld) && (
            <p className="muted">
              Your GST number is not on some invoices: it is printed once our team has checked it
              (we may ask for your GST certificate). Ask us on Help if you need it added.
            </p>
          )}
        </>
      )}
    </Shell>
  );
}
