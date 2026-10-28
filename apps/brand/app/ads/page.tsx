'use client';
// P5.5 Your ads, for one campaign. The main path: upload your own ad, a 15-second video or pictures
// (each picture is shown for a whole 15-second turn), 1280 × 640, no sound, up to 30 MB. Each file
// is checked at once (size, shape, length) and then by our reviewer. Choose 2 to 5 of your ads for
// the campaign; they take turns. Tips on what works on a moving screen at night are at the side.
import { Fold, Info } from '@recall/web-ui';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, upload, type Ad } from '../../lib/api';
import { dayText } from '../../lib/format';
import { Shell, useMe } from '../../lib/session';
import MakeAd from './make-ad';

interface BookingAds {
  readonly bookingId: string;
  readonly adsDueAt: number;
  readonly firstHourAt: number;
  readonly ads: readonly Ad[];
}

const MARK = { pass: '✓', warn: '!', fail: '✗' } as const;
const indiaDay = (t: number) => new Date((t + 19_800) * 1000).toISOString().slice(0, 10);

function status(a: Ad): { text: string; tone: string } {
  if (a.outcome === 'fail')
    return { text: 'Cannot run: fix the file and upload it again', tone: 'error' };
  if (a.review?.decision === 'approved') return { text: 'Approved', tone: 'ok' };
  if (a.review?.decision === 'rejected')
    return { text: `Not approved: ${a.review.reason ?? 'see our note'}`, tone: 'error' };
  return { text: 'Being checked by our team', tone: 'muted' };
}

const TIPS = [
  'One message, big: people see it for a few seconds from a bike or a car.',
  'Your logo and name large, in the first seconds.',
  'Light words on a dark background read best at night.',
  'No small print, no long phone numbers or web addresses.',
  'No flashing, nothing that looks like a road sign or a traffic light.',
  'No sound: the screens play none, so the picture must say it all.',
  'A video lasts exactly 15 seconds; a picture is shown for 15 seconds.',
];

export default function AdsPage() {
  const me = useMe();
  const [q, setQ] = useState({ brand: '', booking: '' });
  const [mine, setMine] = useState<readonly Ad[]>();
  const [booking, setBooking] = useState<BookingAds>();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (brand: string, bookingId: string) => {
    const [a, b] = await Promise.all([
      api<{ ads: Ad[] }>(`/ads?brand=${encodeURIComponent(brand)}`),
      api<BookingAds>(
        `/booking-ads?brand=${encodeURIComponent(brand)}&booking=${encodeURIComponent(bookingId)}`,
      ),
    ]);
    setMine(a.ads);
    setBooking(b);
    setChosen(b.ads.map((x) => x.adId));
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = { brand: p.get('brand') ?? '', booking: p.get('booking') ?? '' };
    setQ(v);
    load(v.brand, v.booking).catch((e: unknown) =>
      setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
    );
  }, [load]);

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    const name = String(f.get('name') ?? '').trim();
    if (!(file instanceof File) || file.size === 0) return setError('Choose a file.');
    setBusy(true);
    setError('');
    setDone('');
    try {
      const r = await upload<{ ad: Ad }>(
        `/ads/upload?brand=${encodeURIComponent(q.brand)}&name=${encodeURIComponent(name || file.name.slice(0, 80))}`,
        file,
      );
      setMine((m) => [r.ad, ...(m ?? [])]);
      if (r.ad.outcome !== 'fail' && chosen.length < 5) setChosen((c) => [...c, r.ad.adId]);
      setDone(
        r.ad.outcome === 'fail'
          ? `${r.ad.name} cannot run: see what to fix below.`
          : `${r.ad.name} is uploaded. Save your choice when your ads are ready.`,
      );
      form.reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The upload did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await api(
        `/booking-ads?brand=${encodeURIComponent(q.brand)}&booking=${encodeURIComponent(q.booking)}`,
        { adIds: chosen },
      );
      await load(q.brand, q.booking);
      setDone('Your choice is saved. Our team checks each ad before it runs.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
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
  const file = (a: Ad) =>
    `/api/ads/file?brand=${encodeURIComponent(q.brand)}&ad=${encodeURIComponent(a.adId)}`;
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Your ads</h1>
        <Link className="back-link" href={`/campaigns?brand=${encodeURIComponent(q.brand)}`}>
          Back to campaigns
        </Link>
      </div>
      {booking && (
        <p>
          For campaign <span className="mono">{booking.bookingId}</span>, starting{' '}
          {dayText(indiaDay(booking.firstHourAt))}. Your ads are due by{' '}
          <b>{dayText(indiaDay(booking.adsDueAt))}</b>.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      <div className="book">
        <div className="stack">
          <form className="rc-card stack" onSubmit={send} aria-label="Upload an ad">
            <h2>Upload your ad</h2>
            <Info label="Which files work">
              A 15-second MP4 video, or a picture (PNG, JPEG or WebP) shown for 15 seconds. 1280 ×
              640 (2 : 1), no sound, up to 30 MB. Several pictures take turns, like a carousel.
            </Info>
            <label className="rc-field">
              <span className="rc-field__label">File</span>
              <input
                className="rc-input"
                name="file"
                type="file"
                accept="video/mp4,image/png,image/jpeg,image/webp"
                required
              />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Name (for you)</span>
              <input className="rc-input" name="name" maxLength={80} placeholder="Diwali offer" />
            </label>
            <button className="rc-button rc-button--primary" type="submit" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
          </form>

          <MakeAd
            brand={q.brand}
            onMade={(ad) => {
              setMine((m) => [ad, ...(m ?? [])]);
              if (ad.outcome !== 'fail' && chosen.length < 5) setChosen((c) => [...c, ad.adId]);
              setDone(`${ad.name} is made. Save your choice when your ads are ready.`);
            }}
          />

          <section className="stack" aria-label="Your ads">
            <h2>Choose 2 to 5 for this campaign</h2>
            {mine?.length === 0 && <p className="muted">No ads yet: upload your first above.</p>}
            <ul className="ads">
              {mine?.map((a) => {
                const st = status(a);
                const usable = a.outcome !== 'fail' && a.review?.decision !== 'rejected';
                const on = chosen.includes(a.adId);
                return (
                  <li key={a.adId} className="rc-card stack" aria-label={`Ad ${a.name}`}>
                    {a.kind === 'mp4' ? (
                      <video src={file(a)} muted loop playsInline controls preload="metadata" />
                    ) : a.kind ? (
                      <img src={file(a)} alt={a.name} />
                    ) : null}
                    <b>{a.name}</b>
                    <span className={st.tone}>{st.text}</span>
                    <ul className="plain checks">
                      {a.checks
                        .filter(
                          (c) =>
                            c.outcome !== 'pass' || c.check === 'pixels' || c.check === 'length',
                        )
                        .map((c) => (
                          <li
                            key={c.check}
                            className={
                              c.outcome === 'fail'
                                ? 'error'
                                : c.outcome === 'warn'
                                  ? 'warn'
                                  : 'muted'
                            }
                          >
                            {MARK[c.outcome]} {c.detail}
                          </li>
                        ))}
                    </ul>
                    <label className="row">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!usable || (!on && chosen.length >= 5)}
                        onChange={() =>
                          setChosen((c) => (on ? c.filter((x) => x !== a.adId) : [...c, a.adId]))
                        }
                      />
                      Use in this campaign
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
        <aside className="rc-card stack summary" aria-label="Your choice">
          <h2>Your choice</h2>
          <p>{chosen.length} of 2 to 5 ads chosen.</p>
          <Info label="How they take turns">
            They take turns: each plays for 15 seconds, one after the other. You can add your ads
            after paying too, until they are due.
          </Info>
          <button
            type="button"
            className="rc-button rc-button--primary"
            disabled={busy || chosen.length < 2 || chosen.length > 5}
            onClick={() => void save()}
          >
            Save my choice
          </button>
          <Link
            className="rc-button rc-button--secondary"
            href={`/pay?brand=${encodeURIComponent(q.brand)}&booking=${encodeURIComponent(q.booking)}`}
          >
            Next: review and pay
          </Link>
          <Fold title="What works on the road" hint={`${TIPS.length} tips for ads people notice`}>
            <ul className="tips">
              {TIPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </Fold>
        </aside>
      </div>
    </Shell>
  );
}
