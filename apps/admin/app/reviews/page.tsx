'use client';
// P3.9.2 Ad review: uploaded ads waiting for a person, the ones bookings need soonest first. The
// reviewer looks at the ad (preview) and what the automatic checks found, then approves (every rule
// on the checklist ticked) or rejects with why. A booking runs once all its ads are approved; past
// its deadline (7 days before, a setting) a reviewer approves it on short notice, with why.
import { Fold, foldHint, latestOf } from '@recall/web-ui';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adSummary, reviewText, type AdView } from '../../lib/ads';
import { api, ApiError, type Member } from '../../lib/api';
import { clock, dayOfIndia } from '../../lib/format';
import { CHECKLIST, dueText, MIN_REASON } from '../../lib/reviews';
import { Shell, useMember } from '../../lib/session';

interface QueueAd extends AdView {
  readonly brandName: string;
  readonly neededBy: number | null;
  readonly bookings: readonly string[];
}

interface Queue {
  readonly at: number;
  readonly waiting: readonly QueueAd[];
  readonly shortNotice: readonly {
    bookingId: string;
    brandName: string;
    adsDueAt: number;
    firstHourAt: number;
  }[];
  readonly recent: readonly (AdView & { brandName: string })[];
}

interface Outcome {
  readonly approvedBookings: readonly string[];
  readonly waiting: readonly { bookingId: string; problem: string }[];
}

type Decision = 'approved' | 'rejected';

const canReview = (m: Member) =>
  m.role === 'super-admin' || (m.role === 'admin' && m.areas.includes('ad-review'));
const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;

function Preview({ ad }: { readonly ad: AdView }) {
  return ad.kind === 'mp4' ? (
    <video className="ad-preview" src={ad.preview} muted controls preload="metadata" />
  ) : (
    // A plain img: the link is signed and short-lived (no image optimiser in between).
    <img className="ad-preview" src={ad.preview} alt={ad.name} />
  );
}

function Decide({
  ad,
  busy,
  onDecide,
}: {
  readonly ad: QueueAd;
  readonly busy: boolean;
  readonly onDecide: (
    decision: Decision,
    reason: string,
    checklist: Record<string, boolean>,
  ) => void;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const all = CHECKLIST.every((c) => ticks[c.key]);
  const failed = ad.outcome === 'fail';
  const submit = (e: FormEvent) => e.preventDefault();
  return (
    <form className="stack" onSubmit={submit} aria-label={`Review ${ad.name}`}>
      {!failed && (
        <fieldset className="stack">
          <legend className="rc-field__label">Tick every rule to approve</legend>
          {CHECKLIST.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={ticks[c.key] === true}
                onChange={(e) => setTicks({ ...ticks, [c.key]: e.target.checked })}
              />{' '}
              {c.text}
            </label>
          ))}
        </fieldset>
      )}
      <label className="rc-field">
        <span className="rc-field__label">Why reject (the brand is told)</span>
        <input
          className="rc-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          aria-label={`Why, for ${ad.name}`}
        />
      </label>
      <div className="cal-bar">
        {!failed && (
          <button
            className="rc-button"
            type="button"
            disabled={busy || !all}
            onClick={() => onDecide('approved', '', ticks)}
          >
            Approve
          </button>
        )}
        <button
          className="rc-button rc-button--secondary"
          type="button"
          disabled={busy || reason.trim().length < MIN_REASON}
          onClick={() => onDecide('rejected', reason, ticks)}
        >
          Reject
        </button>
      </div>
    </form>
  );
}

function ShortNotice({
  bookingId,
  busy,
  onApprove,
}: {
  readonly bookingId: string;
  readonly busy: boolean;
  readonly onApprove: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="cal-bar">
      <label className="rc-field">
        <span className="rc-field__label">Why approve on short notice (logged)</span>
        <input
          className="rc-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          aria-label={`Why approve ${bookingId} on short notice`}
        />
      </label>
      <button
        className="rc-button"
        type="button"
        disabled={busy || reason.trim().length < MIN_REASON}
        onClick={() => onApprove(reason)}
      >
        Approve {bookingId}
      </button>
    </div>
  );
}

export default function ReviewsPage() {
  const me = useMember();
  const [q, setQ] = useState<Queue>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the newest request's answer is shown.
  const asked = useRef(0);

  const load = useCallback(() => {
    const n = ++asked.current;
    api<Queue>('/reviews')
      .then((x) => {
        if (n !== asked.current) return;
        setQ(x);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the queue.'),
      );
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const act = <T,>(path: string, body: object, done: (x: T) => string) => {
    setBusy(true);
    setError('');
    setNote('');
    api<T>(path, body)
      .then((x) => {
        setNote(done(x));
        load();
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };
  const decide =
    (ad: QueueAd) => (decision: Decision, reason: string, checklist: Record<string, boolean>) =>
      act<Outcome>(
        `/reviews/ad/${ad.adId}`,
        { decision, reason: reason.trim() || null, checklist },
        (o) =>
          [
            `${ad.name}: ${decision}.`,
            o.approvedBookings.length ? `Ready to run: ${o.approvedBookings.join(', ')}.` : '',
            ...o.waiting.map((w) => `${w.bookingId} waits: ${w.problem}.`),
          ]
            .filter(Boolean)
            .join(' '),
      );

  if (!me) return <p className="muted">Loading…</p>;
  const mine = canReview(me);
  return (
    <Shell member={me}>
      <h1>Ad review</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {!q ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {q.shortNotice.length > 0 && (
            <section className="rc-card stack" aria-label="Short notice">
              <h2 style={{ margin: 0 }}>Bookings waiting: ads approved past the deadline</h2>
              <ul className="plain">
                {q.shortNotice.map((b) => (
                  <li key={b.bookingId} className="stack">
                    <div>
                      <span className="mono">{b.bookingId}</span> · {b.brandName} · ads were due{' '}
                      {when(b.adsDueAt)} · first hour {when(b.firstHourAt)}
                    </div>
                    {mine && (
                      <ShortNotice
                        bookingId={b.bookingId}
                        busy={busy}
                        onApprove={(reason) =>
                          act(
                            `/reviews/booking/${b.bookingId}`,
                            { reason },
                            () => `${b.bookingId}: approved on short notice; ready to run.`,
                          )
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="stack" aria-label="Waiting for review">
            <h2 style={{ margin: 0 }}>Waiting for review ({q.waiting.length})</h2>
            {q.waiting.length === 0 && <p className="muted">Nothing waiting.</p>}
            <ul className="plain">
              {q.waiting.map((a) => (
                <li key={a.adId} className="rc-card ad-row">
                  <Preview ad={a} />
                  <div className="stack">
                    <div>
                      <strong>{a.name}</strong> · {a.brandName} ·{' '}
                      <span className={a.neededBy !== null && a.neededBy < q.at ? 'error' : ''}>
                        {dueText(a.neededBy, q.at)}
                      </span>
                      {a.bookings.length > 0 && (
                        <span className="muted"> · for {a.bookings.join(', ')}</span>
                      )}
                    </div>
                    <div className={a.outcome === 'fail' ? 'error' : 'muted'}>{adSummary(a)}</div>
                    {mine && <Decide ad={a} busy={busy} onDecide={decide(a)} />}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="stack" aria-label="Latest decisions">
            <Fold
              title="Latest decisions"
              hint={foldHint(
                q.recent.length,
                ['decision', 'decisions'],
                latestOf(q.recent.flatMap((a) => (a.review ? [a.review.at] : []))),
                q.at,
              )}
            >
              {q.recent.length === 0 && <p className="muted">None yet.</p>}
              <ul className="plain">
                {q.recent.map((a) => (
                  <li key={a.adId}>
                    <strong>{a.name}</strong> · {a.brandName} · {reviewText(a)}
                    {a.review && <span className="muted"> · {when(a.review.at)}</span>}
                  </li>
                ))}
              </ul>
            </Fold>
          </section>
        </>
      )}
    </Shell>
  );
}
