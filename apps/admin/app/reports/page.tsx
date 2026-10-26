'use client';
// P3.14.1 Reports: every campaign that has ended and where its final report stands (waiting for its
// last checks, built and being sent, sent, no contact, could not be delivered). A report opens as
// the brand sees it, downloads as a PDF, and Sales or Support admins send it again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { count, dayOfIndia } from '../../lib/format';
import {
  sendText,
  STAGE_CHIP,
  STAGE_NAMES,
  type Channel,
  type ReportList,
  type ReportRow,
} from '../../lib/reports';
import { Shell, useMember } from '../../lib/session';

const failed = (e: unknown, what: string) =>
  e instanceof ApiError ? e.message : `Could not ${what}. Try again.`;
const pct = (bp: number) => `${Math.floor(bp / 100)}%`;

function Report({
  row,
  canResend,
  onChanged,
}: {
  readonly row: ReportRow;
  readonly canResend: boolean;
  readonly onChanged: () => void;
}) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (row.builtAt === null) return;
    api<{ html: string }>(`/reports/${row.bookingId}/page`)
      .then((x) => setHtml(x.html))
      .catch((e: unknown) => setError(failed(e, 'open the report')));
  }, [row.bookingId, row.builtAt]);
  const pdf = () => {
    setBusy(true);
    api<{ name: string; base64: string }>(`/reports/${row.bookingId}/pdf`)
      .then((x) => {
        const bytes = Uint8Array.from(atob(x.base64), (ch) => ch.charCodeAt(0));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        a.download = x.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      })
      .catch((e: unknown) => setError(failed(e, 'get the PDF')))
      .finally(() => setBusy(false));
  };
  const resend = (channel: Channel) => {
    setBusy(true);
    setError('');
    api<{ status: string }>(`/reports/${row.bookingId}/resend`, { channel })
      .then((x) => {
        setNote(
          x.status === 'sent'
            ? `Sent again on ${channel === 'whatsapp' ? 'WhatsApp' : 'email'}.`
            : 'It did not go through: check the contact on the brand’s page.',
        );
        onChanged();
      })
      .catch((e: unknown) => setError(failed(e, 'send it')))
      .finally(() => setBusy(false));
  };
  return (
    <section className="rc-card stack" aria-label={`Report ${row.bookingId}`}>
      <h2 style={{ margin: 0 }}>
        {row.brandName} · <span className="mono">{row.bookingId}</span>
      </h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {row.builtAt === null ? (
        <p className="muted">
          Not built yet: it is built once every hour has had its make-ups and refund check.
        </p>
      ) : (
        <>
          <div className="cal-bar">
            <button
              className="rc-button rc-button--secondary"
              type="button"
              disabled={busy}
              onClick={pdf}
            >
              Download PDF
            </button>
            {canResend && (
              <>
                <button
                  className="rc-button rc-button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => resend('whatsapp')}
                >
                  Send again on WhatsApp
                </button>
                <button
                  className="rc-button rc-button--secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => resend('email')}
                >
                  Send again by email
                </button>
              </>
            )}
          </div>
          {/* The brand's page, with nothing able to run in it. */}
          <iframe
            title={`Report ${row.bookingId} as the brand sees it`}
            sandbox=""
            srcDoc={html}
            style={{ width: '100%', height: '70vh', border: '1px solid var(--line)' }}
          />
        </>
      )}
    </section>
  );
}

export default function ReportsPage() {
  const me = useMember();
  const [list, setList] = useState<ReportList>();
  const [open, setOpen] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(0);
  const load = useCallback(() => {
    const n = ++asked.current;
    api<ReportList>('/reports')
      .then((x) => {
        if (n !== asked.current) return;
        setList(x);
        setError('');
      })
      .catch((e: unknown) => {
        if (n === asked.current) setError(failed(e, 'load the reports'));
      });
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);
  if (!me) return <p className="muted">Loading…</p>;
  const row = list?.rows.find((r) => r.bookingId === open);
  return (
    <Shell member={me}>
      <h1>Reports</h1>
      <p className="muted">
        Each campaign&apos;s final report is built about two days after its last hour, then sent to
        the brand on WhatsApp and by email.
        {list && !list.sending ? ' Sending is not set up yet on this server.' : ''}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list && list.rows.length === 0 && <p className="muted">No campaign has ended yet.</p>}
      {list && list.rows.length > 0 && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Reports">
            <thead>
              <tr>
                <th>Brand · booking</th>
                <th>Ran</th>
                <th>Plays</th>
                <th>Where it stands</th>
                <th>Sent to the brand</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.bookingId}>
                  <td>
                    {r.brandName} · <span className="mono">{r.bookingId}</span>
                  </td>
                  <td>
                    {dayOfIndia(r.from)}
                    {dayOfIndia(r.until - 1) !== dayOfIndia(r.from)
                      ? ` – ${dayOfIndia(r.until - 1)}`
                      : ''}
                  </td>
                  <td className="mono">
                    {r.delivered !== null && r.promised !== null && r.deliveredBp !== null
                      ? `${count(r.delivered)} of ${count(r.promised)} (${pct(r.deliveredBp)})`
                      : '–'}
                  </td>
                  <td>
                    <span className={`rc-chip ${STAGE_CHIP[r.stage]}`}>{STAGE_NAMES[r.stage]}</span>
                  </td>
                  <td className="stack">
                    <span>WhatsApp: {sendText(r.sends.whatsapp)}</span>
                    <span>Email: {sendText(r.sends.email)}</span>
                  </td>
                  <td>
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      aria-pressed={open === r.bookingId}
                      onClick={() => setOpen(r.bookingId)}
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
      {row && (
        <Report
          key={row.bookingId}
          row={row}
          canResend={list?.canResend ?? false}
          onChanged={load}
        />
      )}
    </Shell>
  );
}
