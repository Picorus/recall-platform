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
  const [pdf, setPdf] = useState<{ file: File; url: string }>();
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

  // The PDF is fetched once the report is shown, so Download and Share use it at once (a phone
  // only shares straight from the press, not after a wait).
  useEffect(() => {
    if (!report) return;
    let url = '';
    fetch(pdfUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const file = new File([await r.blob()], fileName, { type: 'application/pdf' });
        url = URL.createObjectURL(file);
        setPdf({ file, url });
      })
      .catch(() => setNote('The PDF is not ready right now: try again in a while.'));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [report, pdfUrl, fileName]);

  // The report shown whole, also after the phone turns.
  const fit = () => {
    const f = frame.current;
    const h = f?.contentDocument?.documentElement.scrollHeight;
    if (f && h) f.style.height = `${h + 16}px`;
  };
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const shareText = report
    ? `RECALL campaign report ${report.bookingId} (${report.period})\n${report.summary.join('\n')}`
    : '';

  /** On a phone: the PDF itself to WhatsApp (or any app); elsewhere: the summary on WhatsApp. */
  const share = () => {
    setNote('');
    if (pdf && navigator.canShare?.({ files: [pdf.file] })) {
      navigator.share({ files: [pdf.file], text: shareText }).catch((e: unknown) => {
        // The person closed the share sheet: nothing to do.
        if (!(e instanceof DOMException && e.name === 'AbortError'))
          setNote('Could not share from here: download the PDF and send it.');
      });
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener');
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
        <Link href={report ? `/campaigns?${q}` : '/'}>Back to campaigns</Link>
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
            {pdf ? (
              <a className="rc-button rc-button--primary" href={pdf.url} download={fileName}>
                Download PDF
              </a>
            ) : (
              <span className="rc-button rc-button--primary" aria-disabled="true">
                Getting the PDF…
              </span>
            )}
            <button type="button" className="rc-button rc-button--secondary" onClick={share}>
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
            onLoad={fit}
          />
        </>
      )}
    </Shell>
  );
}
