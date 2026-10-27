'use client';
// P5.7 Final report: the page the "Done, here is your report" message links to. Plays delivered,
// different bikes, the heat map, busiest streets, made-up plays and an estimate of who saw it, the same
// report our team sees and the PDF carries. Download the PDF, share it (on a phone: straight to
// WhatsApp), or book again.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Report } from '../../../../lib/api';
import { Shell, useMe } from '../../../../lib/session';

export default function ReportPage() {
  const me = useMe();
  const { booking = '' } = useParams<{ booking: string }>();
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!me) return;
    api<Report>(`/report?booking=${encodeURIComponent(booking)}`)
      .then(setReport)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  }, [me, booking]);

  const pdfUrl = `/api/report/pdf?booking=${encodeURIComponent(booking)}`;
  const fileName = `RECALL-report-${booking}.pdf`;
  const shareText = report
    ? `RECALL campaign report ${report.bookingId} (${report.period})\n${report.summary.join('\n')}`
    : '';

  /** On a phone: the PDF itself to WhatsApp (or any app); elsewhere: the summary on WhatsApp. */
  const share = async () => {
    setBusy(true);
    setNote('');
    try {
      const r = await fetch(pdfUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const file = new File([await r.blob()], fileName, { type: 'application/pdf' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text: shareText });
          return;
        }
      } else if (r.status === 429) {
        setNote('Too many downloads this hour: the summary is shared instead.');
      }
      window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener');
    } catch (e) {
      // The person closed the share sheet: nothing to do.
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setNote('Could not share from here: download the PDF and send it.');
    } finally {
      setBusy(false);
    }
  };

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const q = report ? `brand=${encodeURIComponent(report.account.brandId)}` : '';
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Campaign report</h1>
        {report && <Link href={`/campaigns?${q}`}>Back to campaigns</Link>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            <b>{report.account.name}</b> · <span className="mono">{report.bookingId}</span>
            {report.period && ` · ${report.period}`}
          </p>
          <div className="row">
            <a className="rc-button rc-button--primary" href={pdfUrl} download={fileName}>
              Download PDF
            </a>
            <button
              type="button"
              className="rc-button rc-button--secondary"
              disabled={busy}
              onClick={() => void share()}
            >
              Share on WhatsApp
            </button>
            <Link
              className="rc-button rc-button--secondary"
              href={`/book?${q}&again=${encodeURIComponent(report.bookingId)}`}
            >
              Book again
            </Link>
          </div>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
          {/* The report page itself, as sent. No scripts can run in it (sandbox); same origin only
              so its height can be read to show it whole. */}
          <iframe
            ref={frame}
            title={`Report ${report.bookingId}`}
            className="report-frame"
            sandbox="allow-same-origin"
            srcDoc={report.html}
            onLoad={() => {
              const f = frame.current;
              const h = f?.contentDocument?.documentElement.scrollHeight;
              if (f && h) f.style.height = `${h + 16}px`;
            }}
          />
        </>
      )}
    </Shell>
  );
}
