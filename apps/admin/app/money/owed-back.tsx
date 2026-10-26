'use client';
// P3.13.2: money owed back to brands (approved refunds, payments after a cancellation or of a wrong
// amount). Finance sends each back through the payment provider against the brand's payment, or,
// when the provider cannot, records the bank transfer they made by hand (its reference).
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia, rupees } from '../../lib/format';
import { BACK_CHIP, BACK_NAMES, type OwedBackItem, type OwedBackList } from '../../lib/money';

const when = (t: number) => `${dayOfIndia(t)}, ${clock(t)}`;
const failed = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.');

function Actions({
  item,
  canSend,
  onDone,
}: {
  readonly item: OwedBackItem;
  readonly canSend: boolean;
  readonly onDone: (note: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const sendable = ['owed', 'failed', 'pending'].includes(item.state) && item.paymentId !== null;
  const byHand = ['owed', 'failed', 'given up'].includes(item.state);
  const go = (path: string, body: object, done: (x: { state: string }) => string) => {
    setBusy(true);
    setError('');
    api<{ state: string }>(`/money/owed-back/${path}`, { owedEntry: item.owedEntry, ...body })
      .then((x) => onDone(done(x)))
      .catch((e: unknown) => setError(failed(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="stack">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sendable && (
        <div className="cal-bar">
          <button
            className="rc-button"
            type="button"
            disabled={busy || !canSend}
            title={canSend ? undefined : 'No payment provider yet'}
            onClick={() =>
              go('send', {}, (x) =>
                x.state === 'refunded'
                  ? `${rupees(item.amountPaise)} sent back to ${item.brandName}.`
                  : `${item.brandName}: ${BACK_NAMES[x.state as keyof typeof BACK_NAMES] ?? x.state}.`,
              )
            }
          >
            {item.state === 'owed' ? 'Send back' : 'Send again'}
          </button>
        </div>
      )}
      {byHand && (
        <div className="cal-bar" role="group" aria-label={`Bank transfer, ${item.owedEntry}`}>
          <label className="rc-field">
            <span className="rc-field__label">Bank reference (UTR)</span>
            <input
              className="rc-input"
              value={reference}
              maxLength={60}
              onChange={(e) => setReference(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Note</span>
            <input
              className="rc-input"
              value={note}
              maxLength={300}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </label>
          <button
            className="rc-button rc-button--secondary"
            type="button"
            disabled={busy || reference.trim().length < 4}
            onClick={() =>
              go(
                'by-hand',
                { reference: reference.trim(), note: note.trim() },
                () => `${item.brandName}: bank transfer recorded.`,
              )
            }
          >
            Record bank transfer
          </button>
        </div>
      )}
    </div>
  );
}

export default function OwedBack({ onChanged }: { readonly onChanged: () => void }) {
  const [list, setList] = useState<OwedBackList>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(() => {
    api<OwedBackList>('/money/owed-back')
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
    <section className="rc-card stack" aria-label="Owed back to brands">
      <h2 style={{ margin: 0 }}>Owed back to brands ({list.items.length})</h2>
      {note && <p role="status">{note}</p>}
      {list.items.length === 0 ? (
        <p className="muted">Nothing owed back.</p>
      ) : (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Money owed back">
            <thead>
              <tr>
                <th>Brand · booking</th>
                <th>What</th>
                <th>Amount</th>
                <th>Where it stands</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <tr key={i.owedEntry}>
                  <td>
                    {i.brandName}
                    {i.bookingId ? (
                      <>
                        {' '}
                        · <span className="mono">{i.bookingId}</span>
                      </>
                    ) : null}
                    <div className="muted">since {when(i.owedAt)}</div>
                  </td>
                  <td>
                    {i.kind === 'refund' ? 'Refund (credit note)' : 'Payment to send back'}
                    <div className="muted">{i.why}</div>
                  </td>
                  <td className="mono">{rupees(i.amountPaise)}</td>
                  <td className="stack">
                    <span>
                      <span className={`rc-chip ${BACK_CHIP[i.state]}`}>{BACK_NAMES[i.state]}</span>
                      {i.reason ? ` ${i.reason}` : ''}
                    </span>
                    {!i.paymentId && (
                      <span className="muted">No payment on record: pay by bank transfer.</span>
                    )}
                    {i.history.length > 0 && (
                      <details>
                        <summary>History</summary>
                        <ul>
                          {i.history.map((h, n) => (
                            <li key={n}>
                              {when(h.at)} · {h.by}: {h.text}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {list.canPay && (
                      <Actions
                        item={i}
                        canSend={list.canSend}
                        onDone={(n) => {
                          setNote(n);
                          load();
                          onChanged();
                        }}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
