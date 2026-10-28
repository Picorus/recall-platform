'use client';
// P5.6 Review and pay: the booking line by line (each area and day with its hours, bikes and price),
// the repeat discount, GST as it will be invoiced and the total; the five plain rules with one tick
// box; then payment in full at the payment provider (UPI, card or net banking). The GST invoice is
// made the moment it is paid (Invoices, P5.8).
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { dayText, rupees } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';

interface Review {
  readonly bookingId: string;
  readonly state: string;
  readonly trial: boolean;
  readonly repeatMonths: number;
  readonly lines: readonly {
    area: string;
    day: string;
    hours: readonly number[];
    bikes: number;
    band: string;
    paisePerBikeHour: number;
    paise: number;
  }[];
  readonly bikeHours: number;
  readonly plays: number;
  readonly listPaise: number;
  readonly discountPaise: number;
  readonly subtotalPaise: number;
  readonly gst: { cgst: number; sgst: number; igst: number };
  readonly totalPaise: number;
  readonly adsDueAt: number;
  readonly terms: readonly { key: string; title: string; text: string }[];
  readonly termsVersion: number;
  readonly gstBp: number;
  readonly blocked: string | null;
}

const hourText = (h: number) => {
  const x = h % 24;
  return x === 0 ? '12 am' : x === 12 ? '12 pm' : x < 12 ? `${x} am` : `${x - 12} pm`;
};
/** "7 pm, 8 pm" as "7–9 pm" when the hours run on. */
function hoursText(hours: readonly number[]): string {
  const runs: number[][] = [];
  for (const h of [...hours].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && last.at(-1) === h - 1) last.push(h);
    else runs.push([h]);
  }
  return runs.map((r) => `${hourText(r[0] ?? 0)} – ${hourText((r.at(-1) ?? 0) + 1)}`).join(', ');
}
const indiaDay = (t: number) => new Date((t + 19_800) * 1000).toISOString().slice(0, 10);

export default function PayPage() {
  const me = useMe();
  const [q, setQ] = useState({ brand: '', booking: '' });
  const [r, setR] = useState<Review>();
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = { brand: p.get('brand') ?? '', booking: p.get('booking') ?? '' };
    setQ(v);
    api<Review>(
      `/review?brand=${encodeURIComponent(v.brand)}&booking=${encodeURIComponent(v.booking)}`,
    )
      .then(setR)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  }, []);

  const pay = async () => {
    if (!r) return;
    setBusy(true);
    setError('');
    try {
      const link = await api<{ url: string }>(
        `/pay?brand=${encodeURIComponent(q.brand)}&booking=${encodeURIComponent(q.booking)}`,
        { agree, termsVersion: r.termsVersion },
      );
      // To the payment provider's page (UPI, card or net banking); never anything but https.
      if (!/^https:\/\//.test(link.url))
        throw new Error('The payment page is not ready. Try again.');
      window.location.assign(link.url);
    } catch (e) {
      setError(
        e instanceof ApiError || e instanceof Error
          ? e.message
          : 'Could not reach the server. Try again.',
      );
      setBusy(false);
    }
  };

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const back = `/campaigns?brand=${encodeURIComponent(q.brand)}`;
  const payable =
    r && (r.state === 'draft' || r.state === 'awaiting-payment') && !r.trial && !r.blocked;
  const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Review and pay</h1>
        <Link className="back-link" href={back}>
          Back to campaigns
        </Link>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {r && (
        <div className="book">
          <div className="stack">
            <section className="rc-card stack" aria-label="Your booking">
              <h2>Your booking</h2>
              <ul className="plain lines">
                {r.lines.map((l) => (
                  <li key={`${l.day}|${l.area}|${l.band}|${l.bikes}`} className="line">
                    <div>
                      <b>
                        {dayText(l.day)} · {l.area}
                      </b>
                      <div className="muted">
                        {hoursText(l.hours)} · {l.bikes} bikes · {l.band}{' '}
                        {rupees(l.paisePerBikeHour)} a bike-hour
                      </div>
                    </div>
                    <span className="mono">{rupees(l.paise)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rc-card stack" aria-label="The rules">
              <h2>The rules, in plain words</h2>
              <ol className="terms">
                {r.terms.map((t) => (
                  <li key={t.key}>
                    <b>{t.title}.</b> {t.text}
                  </li>
                ))}
              </ol>
              <label className="row">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                />
                I have read these five rules and agree to them
              </label>
            </section>
          </div>
          <aside className="rc-card stack summary" aria-label="To pay">
            <h2>To pay</h2>
            <dl className="facts">
              <dt>Bike-hours</dt>
              <dd>{r.bikeHours.toLocaleString('en-IN')}</dd>
              <dt>Plays promised</dt>
              <dd>{r.plays.toLocaleString('en-IN')}</dd>
              <dt>Price</dt>
              <dd>{rupees(r.listPaise)}</dd>
              {r.discountPaise > 0 && (
                <>
                  <dt>{r.repeatMonths}-month discount</dt>
                  <dd>−{rupees(r.discountPaise)}</dd>
                </>
              )}
              {r.gst.igst > 0 ? (
                <>
                  <dt>IGST {pct(r.gstBp)}</dt>
                  <dd>{rupees(r.gst.igst)}</dd>
                </>
              ) : (
                <>
                  <dt>CGST {pct(r.gstBp / 2)}</dt>
                  <dd>{rupees(r.gst.cgst)}</dd>
                  <dt>SGST {pct(r.gstBp / 2)}</dt>
                  <dd>{rupees(r.gst.sgst)}</dd>
                </>
              )}
              <dt>Total</dt>
              <dd>
                <b>{rupees(r.totalPaise)}</b>
              </dd>
            </dl>
            {payable ? (
              <>
                <button
                  type="button"
                  className="rc-button rc-button--primary"
                  disabled={!agree || busy}
                  onClick={() => void pay()}
                >
                  {busy ? 'Opening payment…' : `Pay ${rupees(r.totalPaise)}`}
                </button>
                <p className="muted">
                  Pay in full by UPI, card or net banking. Your hours are kept for you once you
                  start paying; your GST invoice is ready as soon as it is paid. Your ads are due by{' '}
                  {dayText(indiaDay(r.adsDueAt))}.
                </p>
              </>
            ) : r.repeatMonths > 1 && r.state === 'draft' ? (
              <>
                <p>
                  A {r.repeatMonths}-month deal is set up with our sales team: they call you, agree
                  the dates and how you pay.
                </p>
                {asked ? (
                  <p className="ok" role="status">
                    Thank you: our sales team will call you soon.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="rc-button rc-button--primary"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      api(
                        `/deal?brand=${encodeURIComponent(q.brand)}&booking=${encodeURIComponent(q.booking)}`,
                        {},
                      )
                        .then(() => setAsked(true))
                        .catch((e: unknown) =>
                          setError(e instanceof ApiError ? e.message : 'Try again.'),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    Ask our sales team to call me
                  </button>
                )}
              </>
            ) : r.blocked ? (
              <>
                <p className="error">{r.blocked}</p>
                <Link
                  className="rc-button rc-button--secondary"
                  href={`/book?brand=${encodeURIComponent(q.brand)}&again=${encodeURIComponent(r.bookingId)}`}
                >
                  Book again
                </Link>
              </>
            ) : (
              <p>This campaign is paid.</p>
            )}
          </aside>
        </div>
      )}
    </Shell>
  );
}
