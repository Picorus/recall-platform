'use client';
// P5.7 Final report: the page the "Done, here is your report" message links to. Plays delivered,
// different bikes, the heat map, busiest streets, made-up plays and an estimate of who saw it, the same
// report our team sees and the PDF carries. Download the PDF, share it (on a phone: straight to
// WhatsApp), or book again. P7.7.7: plays delivered day by day and hour by hour, as charts.
import { BarChart, dayLabel, hourLabel, Meter } from '@recall/web-ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Report } from '../../../../lib/api';
import { dayText } from '../../../../lib/format';
import { Icon } from '../../../../lib/icons';
import { areaPhoto } from '../../../../lib/photos';
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
      <Link className="back-link" href={report ? `/campaigns?${q}` : '/'}>
        <Icon name="back" size={16} />
        Back to campaigns
      </Link>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <section className="report-cover">
            <img src={areaPhoto('Hitech City')} alt="" />
            <div className="report-cover__words">
              <p className="eyebrow">{report.account.name}</p>
              <h1 className="display">Campaign report</h1>
              <p>
                {report.period && `${report.period} · `}
                <span className="mono">{report.bookingId}</span>
              </p>
            </div>
          </section>
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
              <Icon name="share" size={16} />
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
          <ReportCharts report={report} />
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

const n = (v: number) => v.toLocaleString('en-IN');

/**
 * Plays the screens delivered against those promised, in all, day by day and by hour of the day.
 * Billing is by bike-hours (shown in each hover); people counts are estimates and live in the report.
 */
function ReportCharts({ report }: { report: Report }) {
  const days = report.days ?? [];
  const hours = report.hours ?? [];
  if (days.length === 0 || report.promised === undefined || report.delivered === undefined)
    return null;
  const bikeHours = days.reduce((t, d) => t + d.bikeHours, 0);
  const full = report.delivered >= report.promised;
  return (
    <section className="stack" aria-label="Plays delivered">
      <div className="rc-chart-card stack">
        <Meter
          label={`Plays delivered on ${n(bikeHours)} bike-hours booked`}
          value={report.delivered}
          max={report.promised}
          format={n}
          note={`of ${n(report.promised)} promised${full ? ' · all delivered' : ''}`}
          tone={full ? 'go' : 'data'}
        />
      </div>
      <div className="rc-chart-grid">
        {days.length > 1 && (
          <div className="rc-chart-card">
            <BarChart
              title="Plays, day by day"
              summary={`Delivered against promised, ${days.length} ${days.length === 1 ? 'day' : 'days'}`}
              points={days.map((d) => ({
                label: dayLabel(d.date),
                full: `${dayText(d.date)} · ${n(d.bikeHours)} bike-hours`,
                value: d.delivered,
                target: d.promised,
              }))}
              format={n}
              valueName="Delivered"
              targetName="Promised"
            />
          </div>
        )}
        {hours.length > 1 && (
          <div className="rc-chart-card">
            <BarChart
              title="Plays by hour of the day"
              summary="All days added up, India time"
              points={hours.map((h) => ({
                label: hourLabel(h.hour),
                full: `${hourLabel(h.hour)}–${hourLabel(h.hour + 1)} · ${n(h.bikeHours)} bike-hours`,
                value: h.delivered,
                target: h.promised,
              }))}
              format={n}
              valueName="Delivered"
              targetName="Promised"
            />
          </div>
        )}
      </div>
    </section>
  );
}
