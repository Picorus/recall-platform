'use client';
// P3.12 Payouts: the weekly run. It is prepared by itself on Monday from 10:00 India time (or by
// hand); someone else approves it; then it is sent to each rider's checked bank or UPI. A line can be
// held (not sent until released) or dropped (owed in the next run); failures are sent again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayName, dayOfIndia, rupees } from '../../lib/format';
import {
  cancellable,
  paidText,
  runStage,
  sendable,
  STATE_CHIP,
  STATE_NAMES,
  statesText,
  type RunList,
  type RunPage,
  type RunRow,
} from '../../lib/payouts';
import { Shell, useMember } from '../../lib/session';

const when = (t: number) => `${dayOfIndia(t)}, ${clock(t)}`;
const failed = (e: unknown, what: string) =>
  e instanceof ApiError ? e.message : `Could not ${what}. Try again.`;

function LineActions({
  runId,
  row,
  onDone,
}: {
  readonly runId: string;
  readonly row: RunRow;
  readonly onDone: (note: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = (what: 'hold' | 'release' | 'drop') => {
    setBusy(true);
    setError('');
    const body =
      what === 'drop'
        ? { riderId: row.riderId, reason: reason.trim() }
        : { riderId: row.riderId, held: what === 'hold', reason: reason.trim() };
    api(`/payouts/run/${runId}/${what === 'drop' ? 'drop' : 'hold'}`, body)
      .then(() => {
        setReason('');
        onDone(
          `${row.riderId}: ${what === 'hold' ? 'held' : what === 'release' ? 'released' : 'dropped, owed in the next run'}.`,
        );
      })
      .catch((e: unknown) => setError(failed(e, what)))
      .finally(() => setBusy(false));
  };
  if (!['waiting', 'held', 'failed'].includes(row.state)) return null;
  return (
    <div className="cal-bar">
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
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          aria-label={`Why, ${row.riderId}`}
        />
      </label>
      {row.state === 'held' ? (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          disabled={busy || reason.trim().length < 3}
          onClick={() => act('release')}
        >
          Release
        </button>
      ) : (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          disabled={busy || reason.trim().length < 3}
          onClick={() => act('hold')}
        >
          Hold
        </button>
      )}
      <button
        className="rc-button rc-button--quiet"
        type="button"
        disabled={busy || reason.trim().length < 5}
        onClick={() => act('drop')}
      >
        Drop to next run
      </button>
    </div>
  );
}

function Run({
  runId,
  canSend,
  onChanged,
}: {
  readonly runId: string;
  readonly canSend: boolean;
  readonly onChanged: () => void;
}) {
  const [run, setRun] = useState<RunPage>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const load = useCallback(() => {
    api<RunPage>(`/payouts/run/${runId}`)
      .then((r) => {
        setRun(r);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e, 'load the run')));
  }, [runId]);
  useEffect(load, [load]);
  const done = (n: string) => {
    setNote(n);
    load();
    onChanged();
  };
  const act = (path: string, body: object, after: (x: Record<string, unknown>) => string) => {
    setBusy(true);
    setError('');
    api<Record<string, unknown>>(`/payouts/run/${runId}/${path}`, body)
      .then((x) => done(after(x)))
      .catch((e: unknown) => setError(failed(e, path)))
      .finally(() => setBusy(false));
  };
  if (!run) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const f = run.findings;
  return (
    <section className="rc-card stack" aria-label={`Run for ${dayName(runId)}`}>
      <h2 style={{ margin: 0 }}>
        Run for {dayName(runId)} · {runStage(run)}
      </h2>
      <p className="muted">
        Prepared by {run.preparedBy} ({when(run.preparedAt)})
        {run.approvedBy && run.approvedAt
          ? ` · approved by ${run.approvedBy} (${when(run.approvedAt)})`
          : ''}{' '}
        · {run.lines} {run.lines === 1 ? 'rider' : 'riders'} · {paidText(run)}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {run.canAct && (
        <div className="cal-bar">
          {run.canApprove && run.lines > 0 && (
            <button
              className="rc-button"
              type="button"
              disabled={busy}
              onClick={() => act('approve', {}, () => 'Approved. It can be sent now.')}
            >
              Approve
            </button>
          )}
          {run.approvedBy && sendable(run) && (
            <button
              className="rc-button"
              type="button"
              disabled={busy || !canSend}
              title={canSend ? undefined : 'No payout provider yet'}
              onClick={() =>
                act('send', {}, (x) => {
                  const n = (k: string) => (Array.isArray(x[k]) ? (x[k] as unknown[]).length : 0);
                  return `Sent: ${n('paid')} paid, ${n('pending')} waiting for the bank, ${n('failed')} failed (tried again on the next send), ${n('givenUp')} given up, ${n('held')} held.`;
                })
              }
            >
              {(run.states.failed ?? 0) + (run.states.pending ?? 0) > 0 ? 'Send again' : 'Send'}
            </button>
          )}
          {cancellable(run) ? (
            <>
              <label className="rc-field">
                <span className="rc-field__label">Why cancel the rest (logged)</span>
                <input
                  className="rc-input"
                  value={why}
                  maxLength={300}
                  onChange={(e) => setWhy(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.preventDefault();
                  }}
                />
              </label>
              <button
                className="rc-button rc-button--quiet"
                type="button"
                disabled={busy || why.trim().length < 5}
                onClick={() =>
                  act('cancel', { reason: why.trim() }, (x) => {
                    const n = Array.isArray(x.cancelled) ? x.cancelled.length : 0;
                    return `${n} not yet paid moved to the next run.`;
                  })
                }
              >
                Cancel the rest
              </button>
            </>
          ) : null}
        </div>
      )}
      {!canSend && (
        <p className="muted">
          No payout provider is connected yet: runs can be prepared and approved, not sent.
        </p>
      )}
      {f && (f.noAccount.length > 0 || f.payProblems.length > 0 || f.lateChanges.length > 0) && (
        <div className="stack" aria-label="Found when prepared">
          {f.noAccount.length > 0 && (
            <p className="error">
              Not paid, no checked bank or UPI:{' '}
              {f.noAccount.map((x) => `${x.riderId} (${rupees(x.owedPaise)})`).join(', ')}. Check
              their bank on the Riders page; they are paid in the next run.
            </p>
          )}
          {f.payProblems.length > 0 && (
            <p className="error">
              Pay could not be brought up to date:{' '}
              {f.payProblems.map((x) => `${x.riderId} (${x.error})`).join(', ')}.
            </p>
          )}
          {f.lateChanges.length > 0 && (
            <p className="error">
              Changes in closed months, to settle by hand:{' '}
              {f.lateChanges
                .map((x) => `${x.riderId} ${x.month} (${rupees(x.grossChange)})`)
                .join(', ')}
              .
            </p>
          )}
        </div>
      )}
      {run.rows.length === 0 ? (
        <p className="muted">Nobody to pay in this run.</p>
      ) : (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Payout lines">
            <thead>
              <tr>
                <th>Rider</th>
                <th>Amount</th>
                <th>Paid to</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {run.rows.map((r) => (
                <tr key={r.riderId}>
                  <td className="mono">{r.riderId}</td>
                  <td className="mono">{rupees(r.amountPaise)}</td>
                  <td>{r.to}</td>
                  <td className="stack">
                    <span>
                      <span className={`rc-chip ${STATE_CHIP[r.state]}`}>
                        {STATE_NAMES[r.state]}
                      </span>
                      {r.reason ? ` ${r.reason}` : ''}
                      {r.tries > 1 ? ` · ${r.tries} tries` : ''}
                    </span>
                    {r.history.length > 0 && (
                      <details>
                        <summary>History</summary>
                        <ul>
                          {r.history.map((h, i) => (
                            <li key={i}>
                              {when(h.at)} · {h.by}: {h.text}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {run.canAct && <LineActions runId={runId} row={r} onDone={done} />}
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

export default function PayoutsPage() {
  const me = useMember();
  const [list, setList] = useState<RunList>();
  const [open, setOpen] = useState('');
  const [monday, setMonday] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the newest request's answer is shown.
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    api<RunList>('/payouts')
      .then((x) => {
        if (n !== asked.current) return;
        setList(x);
        setMonday((m) => m || x.lastMonday);
        setOpen((o) => o || (x.runs[0]?.runId ?? ''));
        setError('');
      })
      .catch((e: unknown) => {
        if (n === asked.current) setError(failed(e, 'load the payout runs'));
      });
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);
  const prepare = () => {
    setBusy(true);
    setError('');
    api<{ runId: string; lines: number }>('/payouts/prepare', { monday })
      .then((r) => {
        setNote(
          `Run for ${dayName(r.runId)} prepared: ${r.lines} riders. Someone else approves it.`,
        );
        setOpen(r.runId);
        load();
      })
      .catch((e: unknown) => setError(failed(e, 'prepare the run')))
      .finally(() => setBusy(false));
  };

  if (!me) return <p className="muted">Loading…</p>;
  return (
    <Shell member={me}>
      <h1>Payouts</h1>
      <p className="muted">
        Each Monday from 10:00 the week&apos;s run is prepared by itself. Someone other than who
        prepared it approves it; then it is sent to each rider&apos;s checked bank or UPI.
      </p>
      {list?.canAct && (
        <div className="cal-bar">
          <label className="rc-field">
            <span className="rc-field__label">Monday</span>
            <input
              className="rc-input"
              type="date"
              value={monday}
              onChange={(e) => setMonday(e.target.value)}
            />
          </label>
          <button
            className="rc-button rc-button--secondary"
            type="button"
            disabled={busy || !monday}
            onClick={prepare}
          >
            Prepare run now
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {list && list.openOlder.length > 0 && (
        <section className="rc-card stack" aria-label="Still open in older runs">
          <h2 style={{ margin: 0 }}>Still open in older runs ({list.openOlder.length})</h2>
          <p className="muted">
            This money is not in any new run until it is released and sent, or dropped.
          </p>
          <ul>
            {list.openOlder.map((l) => (
              <li key={`${l.runId}/${l.riderId}`}>
                <button
                  className="rc-button rc-button--quiet"
                  type="button"
                  onClick={() => setOpen(l.runId)}
                >
                  {dayName(l.runId)}
                </button>{' '}
                <span className="mono">{l.riderId}</span> · {rupees(l.amountPaise)} ·{' '}
                {STATE_NAMES[l.state]}
              </li>
            ))}
          </ul>
        </section>
      )}
      {list && list.runs.length === 0 && <p className="muted">No payout runs yet.</p>}
      {list && list.runs.length > 0 && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Payout runs">
            <thead>
              <tr>
                <th>Monday</th>
                <th>Where it stands</th>
                <th>Riders</th>
                <th>Paid</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.runs.map((r) => (
                <tr key={r.runId}>
                  <td>{dayName(r.runId)}</td>
                  <td>
                    {runStage(r)} <span className="muted">({statesText(r.states)})</span>
                  </td>
                  <td>{r.lines}</td>
                  <td className="mono">{paidText(r)}</td>
                  <td>
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      aria-pressed={open === r.runId}
                      onClick={() => setOpen(r.runId)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list && open && <Run key={open} runId={open} canSend={list.canSend} onChanged={load} />}
    </Shell>
  );
}
