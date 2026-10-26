'use client';
// P3.13.1 Money: where money stands now (held for campaigns, owed back to brands, to partners, to
// riders, TDS and GST not yet paid), a month's payments received, its tax invoices and credit
// notes, the GST summary, and the accountant's files. Read-only: nothing here moves money.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia, rupees } from '../../lib/format';
import { E_INVOICE, PAYMENT_NAMES, type MoneyMonth } from '../../lib/money';
import { Shell, useMember } from '../../lib/session';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 2026" from "2026-10". */
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;
const when = (t: number) => `${dayOfIndia(t)}, ${clock(t)}`;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rc-stat">
      <span className="rc-stat__label">{label}</span>
      <span className="rc-stat__value">{value}</span>
      {note && <span className="rc-stat__note">{note}</span>}
    </div>
  );
}

/** Saves a text file in the browser. */
function save(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function MoneyPage() {
  const me = useMember();
  const [m, setM] = useState<MoneyMonth>();
  const [month, setMonth] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the newest request's answer is shown.
  const asked = useRef(0);
  const load = useCallback((which: string) => {
    const n = ++asked.current;
    api<MoneyMonth>(which ? `/money?month=${which}` : '/money')
      .then((x) => {
        if (n !== asked.current) return;
        setM(x);
        setMonth(x.month);
        setError('');
      })
      .catch((e: unknown) => {
        if (n !== asked.current) return;
        setM(undefined);
        setError(e instanceof ApiError ? e.message : 'Could not load the month.');
      });
  }, []);
  useEffect(() => {
    if (me) load('');
  }, [me, load]);
  const download = () => {
    setBusy(true);
    api<{ files: { name: string; csv: string }[] }>(`/money/export?month=${month}`)
      .then((x) => x.files.forEach((f) => save(f.name, f.csv)))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not get the files.'),
      )
      .finally(() => setBusy(false));
  };

  if (!me) return <p className="muted">Loading…</p>;
  const p = m?.position;
  const g = m?.gst;
  const gstOf = (x: { cgst: number; sgst: number; igst: number }) => x.cgst + x.sgst + x.igst;
  return (
    <Shell member={me}>
      <h1>Money</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {p && (
        <section className="stack" aria-label="Where money stands now">
          <h2 style={{ margin: 0 }}>Where money stands now</h2>
          <div className="tiles">
            <Stat
              label="Held for campaigns"
              value={rupees(p.heldForCampaignsPaise)}
              note="paid, not yet delivered (before GST)"
            />
            <Stat
              label="Owed back to brands"
              value={rupees(p.owedBack.reduce((t, b) => t + b.paise, 0))}
              note={`${p.owedBack.length} brands`}
            />
            <Stat label="Owed to riders" value={rupees(p.owedToRidersPaise)} note="Monday runs" />
            <Stat
              label="Owed to partners"
              value={rupees(p.owedToAgenciesPaise + p.owedToAggregatorsPaise)}
              note={`agencies ${rupees(p.owedToAgenciesPaise)} · aggregators ${rupees(p.owedToAggregatorsPaise)}`}
            />
            <Stat label="TDS to deposit" value={rupees(p.tdsPaise)} />
            <Stat label="GST not yet paid" value={rupees(p.gstPaise)} note="less input credit" />
          </div>
          {p.owedBack.length > 0 && (
            <p className="muted">
              Owed back: {p.owedBack.map((b) => `${b.brandName} ${rupees(b.paise)}`).join(' · ')}.
              Paying it back comes in the next step.
            </p>
          )}
        </section>
      )}
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Month</span>
          <input
            className="rc-input"
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              if (e.target.value) load(e.target.value);
            }}
          />
        </label>
        <button
          className="rc-button rc-button--secondary"
          type="button"
          disabled={busy || !month}
          onClick={download}
        >
          Download files for the accountant
        </button>
      </div>
      {g && (
        <section className="stack" aria-label="GST for the month">
          <h2 style={{ margin: 0 }}>GST for {monthName(g.month)}</h2>
          <div className="tiles">
            <Stat
              label="Invoices"
              value={rupees(g.invoices.taxable)}
              note={`${g.invoices.count} issued · GST ${rupees(gstOf(g.invoices))}`}
            />
            <Stat
              label="Credit notes"
              value={rupees(g.creditNotes.taxable)}
              note={`${g.creditNotes.count} issued · GST ${rupees(gstOf(g.creditNotes))}`}
            />
            <Stat label="Input credit" value={rupees(g.inputTaxCredit)} note="partner invoices" />
            <Stat label="GST to pay" value={rupees(g.netGstPayable)} />
            <Stat
              label="TDS held back"
              value={rupees(g.tds.riders + g.tds.partners)}
              note={`riders ${rupees(g.tds.riders)} · partners ${rupees(g.tds.partners)} · deposit by the 7th`}
            />
            <Stat
              label="Year so far"
              value={rupees(g.yearTurnover)}
              note={`e-invoicing ${E_INVOICE[g.eInvoice]}`}
            />
          </div>
          {g.inputGstAwaitingInvoices > 0 && (
            <p className="muted">
              {rupees(g.inputGstAwaitingInvoices)} of partner GST waits for their invoices before it
              can be claimed.
            </p>
          )}
          {g.missingTaxDetails.length > 0 && (
            <p className="error">
              Invoices without the brand&apos;s tax details (add them before filing):{' '}
              {g.missingTaxDetails.join(', ')}
            </p>
          )}
        </section>
      )}
      {m && m.unknownPayments.length > 0 && (
        <p className="error" role="status">
          {m.unknownPayments.length} payment messages for links we have no record of:{' '}
          {m.unknownPayments
            .slice(0, 5)
            .map((u) => `${u.paymentId ?? u.linkId} (${when(u.receivedAt)})`)
            .join(', ')}
          . Check them with the payment provider.
        </p>
      )}
      {m && (
        <section className="stack" aria-label="Payments received">
          <h2 style={{ margin: 0 }}>Payments received ({m.payments.length})</h2>
          {m.paymentsTruncated && <p className="error">Only the latest 500 are shown.</p>}
          {m.payments.length === 0 ? (
            <p className="muted">None this month.</p>
          ) : (
            <div className="rc-table-wrap">
              <table className="rc-table" aria-label="Payments">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Brand · booking</th>
                    <th>Amount</th>
                    <th>What it is</th>
                  </tr>
                </thead>
                <tbody>
                  {m.payments.map((x) => (
                    <tr key={x.paymentId}>
                      <td>{when(x.at)}</td>
                      <td>
                        {x.brandName} · <span className="mono">{x.bookingId}</span>
                      </td>
                      <td className="mono">{rupees(x.amountPaise)}</td>
                      <td>
                        <span
                          className={`rc-chip ${x.state === 'paid' ? 'rc-chip--go' : 'rc-chip--stop'}`}
                        >
                          {PAYMENT_NAMES[x.state]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {m && (
        <section className="stack" aria-label="Invoices and credit notes">
          <h2 style={{ margin: 0 }}>Invoices and credit notes ({m.documents.length})</h2>
          {m.documentsTruncated && <p className="error">Only the first 1,000 are shown.</p>}
          {m.documents.length === 0 ? (
            <p className="muted">None this month.</p>
          ) : (
            <div className="rc-table-wrap">
              <table className="rc-table" aria-label="Tax documents">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Date</th>
                    <th>Billed to</th>
                    <th>Booking</th>
                    <th>Before GST</th>
                    <th>GST</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {m.documents.map((d) => (
                    <tr key={d.docNo}>
                      <td className="mono">
                        {d.docNo}
                        {d.againstDoc ? ` (against ${d.againstDoc})` : ''}
                      </td>
                      <td>{dayOfIndia(d.issuedAt)}</td>
                      <td>
                        {d.legalName}
                        {d.gstin ? <span className="muted"> · {d.gstin}</span> : null}
                      </td>
                      <td className="mono">{d.bookingId}</td>
                      <td className="mono">{rupees(d.taxablePaise)}</td>
                      <td className="mono">{rupees(d.gstPaise)}</td>
                      <td className="mono">{rupees(d.totalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </Shell>
  );
}
