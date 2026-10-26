'use client';
// P3.10: booking lines and where each stands (plays, bikes, make-ups, refunds). Used by the Delivery
// page (a business day) and the booking panel (one booking). A super admin decides a proposed refund
// here, with why.
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { STATUS_NAMES, statusChip, statusText, type DeliveryLine } from '../../lib/delivery';
import { count, dayName } from '../../lib/format';
import { hourLabel } from '../../lib/prices';

function RefundDecision({
  line,
  onDone,
}: {
  readonly line: DeliveryLine;
  readonly onDone: (note: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refundId = line.refund?.refundId ?? '';
  const decide = (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError('');
    api('/delivery/refund', { refundId, decision, reason: reason.trim() })
      .then(() => onDone(`Refund for ${line.bookingId} ${decision}.`))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };
  const ok = reason.trim().length >= 5;
  return (
    <div className="cal-bar" aria-label={`Refund for ${line.lineId}`}>
      {error && (
        <p className="error" role="alert" style={{ flexBasis: '100%' }}>
          {error}
        </p>
      )}
      <label className="rc-field">
        <span className="rc-field__label">Why (logged)</span>
        <input
          className="rc-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
          aria-label={`Why, refund for ${line.bookingId} ${hourLabel(line.startHour)}`}
        />
      </label>
      <button
        className="rc-button"
        type="button"
        disabled={busy || !ok}
        onClick={() => decide('approved')}
      >
        Approve refund
      </button>
      <button
        className="rc-button rc-button--secondary"
        type="button"
        disabled={busy || !ok}
        onClick={() => decide('rejected')}
      >
        Reject
      </button>
    </div>
  );
}

export default function DeliveryLines({
  lines,
  showBooking,
  canDecide,
  onChanged,
}: {
  readonly lines: readonly DeliveryLine[];
  /** On the day page: which booking and brand each line is. */
  readonly showBooking: boolean;
  /** A super admin decides refunds. */
  readonly canDecide: boolean;
  readonly onChanged: (note: string) => void;
}) {
  if (lines.length === 0) return <p className="muted">No lines.</p>;
  return (
    <div className="rc-table-wrap">
      <table className="rc-table" aria-label="Delivery">
        <thead>
          <tr>
            <th>Hour</th>
            {showBooking && <th>Brand · booking</th>}
            <th>Area</th>
            <th>Bikes seen (its hour)</th>
            <th>Plays</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId}>
              <td>
                {showBooking ? '' : `${dayName(l.date)} `}
                {hourLabel(l.startHour)}
              </td>
              {showBooking && (
                <td>
                  {l.brandName} · <span className="mono">{l.bookingId}</span>
                </td>
              )}
              <td>{l.areaName}</td>
              <td>
                {count(l.bikesSeen)} of {count(l.bikes)}
              </td>
              <td>
                {count(l.view.delivered)} of {count(l.promised)}
              </td>
              <td className="stack">
                <span>
                  <span className={`rc-chip ${statusChip(l.view.status)}`}>
                    {STATUS_NAMES[l.view.status]}
                  </span>{' '}
                  {statusText(l)}
                </span>
                {canDecide && l.view.status === 'refund-due' && (
                  <RefundDecision line={l} onDone={onChanged} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
