'use client';
// P3.13.3: agencies and aggregators. Each partner with a cut and what it is owed; its monthly
// statement (cuts by booking, GST, TDS, payments, its invoices) to download and send; a payment
// made by bank transfer and the partner's invoice recorded (finance); a cut given on a booking
// (super admin, never automatic).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { dayOfIndia, rupees } from '../../lib/format';
import type { PartnerList, PartnerRow, PartnerStatement } from '../../lib/money';
import { readPercent, readRupees } from '../../lib/prices';

const failed = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.');
const KIND_NAMES = { agency: 'Agency', aggregator: 'Aggregator' } as const;

function save(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Reads a form field as a string. */
const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function Statement({
  partner,
  month,
  canPay,
  onChanged,
}: {
  readonly partner: PartnerRow;
  readonly month: string;
  readonly canPay: boolean;
  readonly onChanged: () => void;
}) {
  const [s, setS] = useState<{
    statement: PartnerStatement;
    file: { name: string; csv: string };
  }>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ statement: PartnerStatement; file: { name: string; csv: string } }>(
      `/money/partners/statement?partner=${partner.partnerId}&kind=${partner.kind}&month=${month}`,
    )
      .then((x) => {
        setS(x);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e)));
  }, [partner, month]);
  useEffect(load, [load]);
  const act = (path: string, body: object, done: string, form: HTMLFormElement) => {
    setBusy(true);
    setError('');
    api(`/money/partners/${path}`, { partnerId: partner.partnerId, kind: partner.kind, ...body })
      .then(() => {
        setNote(done);
        form.reset();
        load();
        onChanged();
      })
      .catch((e: unknown) => setError(failed(e)))
      .finally(() => setBusy(false));
  };
  const pay = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = readRupees(field(f, 'amount'));
    if (typeof amount !== 'number') return setError(amount.problem);
    act(
      'pay',
      { amountPaise: amount, reference: field(f, 'reference'), note: field(f, 'note') },
      `Payment of ${rupees(amount)} to ${partner.name} recorded.`,
      e.currentTarget,
    );
  };
  const invoice = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const taxable = readRupees(field(f, 'taxable'));
    const gst = readRupees(field(f, 'gst') || '0');
    if (typeof taxable !== 'number') return setError(taxable.problem);
    if (typeof gst !== 'number') return setError(gst.problem);
    act(
      'invoice',
      {
        invoiceNo: field(f, 'invoiceNo'),
        invoiceDate: field(f, 'invoiceDate'),
        gstin: field(f, 'gstin'),
        taxablePaise: taxable,
        gstPaise: gst,
      },
      `Invoice ${field(f, 'invoiceNo')} of ${partner.name} recorded.`,
      e.currentTarget,
    );
  };
  if (!s) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const st = s.statement;
  return (
    <div className="stack" aria-label={`Statement of ${partner.name}`} role="region">
      <h3 style={{ margin: 0 }}>
        {st.name} · {KIND_NAMES[st.kind]} · {st.month}
      </h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      <div className="rc-table-wrap">
        <table className="rc-table" aria-label="Statement">
          <thead>
            <tr>
              <th>Item</th>
              <th>Cut before GST</th>
              <th>GST</th>
              <th>TDS held back</th>
              <th>Owed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Owed at the start</td>
              <td />
              <td />
              <td />
              <td className="mono">{rupees(st.openingPaise)}</td>
            </tr>
            {st.cuts.map((c) => (
              <tr key={c.bookingId}>
                <td>
                  Cut on <span className="mono">{c.bookingId}</span>
                </td>
                <td className="mono">{rupees(c.cutPaise)}</td>
                <td className="mono">{rupees(c.gstPaise)}</td>
                <td className="mono">{rupees(c.tdsPaise)}</td>
                <td className="mono">{rupees(c.netPaise)}</td>
              </tr>
            ))}
            {st.payments.map((p, i) => (
              <tr key={`p${i}`}>
                <td>
                  Paid {dayOfIndia(p.at)} ({p.reference}, {p.by})
                </td>
                <td />
                <td />
                <td />
                <td className="mono">{rupees(-p.amountPaise)}</td>
              </tr>
            ))}
            <tr>
              <td>Owed at the end</td>
              <td />
              <td />
              <td />
              <td className="mono">{rupees(st.closingPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted">
        Their invoices this month:{' '}
        {st.invoices.length === 0
          ? 'none yet'
          : st.invoices
              .map(
                (i) =>
                  `${i.invoiceNo} (${i.invoiceDate}, ${rupees(i.taxablePaise)} + GST ${rupees(i.gstPaise)})`,
              )
              .join(', ')}
        .
      </p>
      <div className="cal-bar">
        <button
          className="rc-button rc-button--secondary"
          type="button"
          onClick={() => save(s.file.name, s.file.csv)}
        >
          Download statement
        </button>
      </div>
      {canPay && (
        <>
          <form className="cal-bar" onSubmit={pay} aria-label="Record a payment">
            <label className="rc-field">
              <span className="rc-field__label">Paid (₹)</span>
              <input className="rc-input" name="amount" required maxLength={20} />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Bank reference (UTR)</span>
              <input className="rc-input" name="reference" required maxLength={60} />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Note</span>
              <input className="rc-input" name="note" maxLength={300} />
            </label>
            <button className="rc-button" type="submit" disabled={busy}>
              Record payment
            </button>
          </form>
          <form className="cal-bar" onSubmit={invoice} aria-label="Record their invoice">
            <label className="rc-field">
              <span className="rc-field__label">Invoice number</span>
              <input className="rc-input" name="invoiceNo" required maxLength={16} />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Date</span>
              <input className="rc-input" name="invoiceDate" type="date" required />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Their GSTIN</span>
              <input className="rc-input" name="gstin" maxLength={15} />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Before GST (₹)</span>
              <input className="rc-input" name="taxable" required maxLength={20} />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">GST (₹)</span>
              <input className="rc-input" name="gst" maxLength={20} />
            </label>
            <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
              Record invoice
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function GiveCut({ onDone }: { readonly onDone: () => void }) {
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const gst = readPercent(field(f, 'gst') || '0');
    if (typeof gst !== 'number') return setError(gst.problem);
    const rate = field(f, 'rate') ? readPercent(field(f, 'rate')) : undefined;
    if (rate !== undefined && typeof rate !== 'number') return setError(rate.problem);
    setBusy(true);
    setError('');
    api('/money/partners/cut', {
      bookingId: field(f, 'bookingId'),
      kind: field(f, 'kind'),
      partnerId: field(f, 'partnerId'),
      gstBp: gst,
      ...(rate === undefined ? {} : { rateBp: rate }),
      reason: field(f, 'reason'),
    })
      .then(() => {
        setNote(`Cut given on ${field(f, 'bookingId')}.`);
        form.reset();
        onDone();
      })
      .catch((x: unknown) => setError(failed(x)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="stack" onSubmit={submit} aria-label="Give a cut on a booking">
      <h3 style={{ margin: 0 }}>Give a cut on a booking</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Booking</span>
          <input className="rc-input" name="bookingId" required maxLength={40} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">To</span>
          <select className="rc-input" name="kind" defaultValue="agency">
            <option value="agency">An agency</option>
            <option value="aggregator">An aggregator</option>
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Partner id</span>
          <input className="rc-input" name="partnerId" required maxLength={64} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Rate % (empty: the price book&apos;s)</span>
          <input className="rc-input" name="rate" maxLength={6} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Their GST %</span>
          <input className="rc-input" name="gst" defaultValue="18" maxLength={6} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Why (logged)</span>
          <input className="rc-input" name="reason" required minLength={5} maxLength={300} />
        </label>
        <button className="rc-button" type="submit" disabled={busy}>
          Give cut
        </button>
      </div>
    </form>
  );
}

export default function Partners({ month }: { readonly month: string }) {
  const [list, setList] = useState<PartnerList>();
  const [open, setOpen] = useState<PartnerRow>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<PartnerList>('/money/partners')
      .then((x) => {
        setList(x);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e)));
  }, []);
  useEffect(load, [load]);
  if (error) return <p className="error">{error}</p>;
  if (!list) return null;
  return (
    <section className="rc-card stack" aria-label="Agencies and aggregators">
      <h2 style={{ margin: 0 }}>Agencies and aggregators</h2>
      {list.partners.length === 0 ? (
        <p className="muted">No cuts given yet.</p>
      ) : (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Partners">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Bookings</th>
                <th>Owed now</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.partners.map((p) => (
                <tr key={`${p.kind}:${p.partnerId}`}>
                  <td>
                    {p.name} <span className="muted">· {KIND_NAMES[p.kind]}</span>
                  </td>
                  <td>{p.bookings}</td>
                  <td className="mono">{rupees(p.owedPaise)}</td>
                  <td>
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      aria-pressed={open?.partnerId === p.partnerId && open.kind === p.kind}
                      onClick={() => setOpen(p)}
                    >
                      Statement
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && month && (
        <Statement
          key={`${open.kind}:${open.partnerId}:${month}`}
          partner={open}
          month={month}
          canPay={list.canPay}
          onChanged={load}
        />
      )}
      {list.canGiveCut && <GiveCut onDone={load} />}
    </section>
  );
}
