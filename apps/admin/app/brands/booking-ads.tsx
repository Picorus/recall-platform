'use client';
// P3.9.1: a booking's ads. Its brand's ads with what the automatic checks found and a preview; a
// Sales admin uploads an ad (a picture, or a 15-second MP4 video) and chooses the 2 to 5 the booking
// runs (they take turns). An ad that failed a check cannot be chosen.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { adSummary, MAX_ADS, MIN_ADS, type AdView } from '../../lib/ads';

export default function BookingAds({
  bookingId,
  brandId,
  canAct,
}: {
  readonly bookingId: string;
  readonly brandId: string;
  readonly canAct: boolean;
}) {
  const [ads, setAds] = useState<readonly AdView[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api<{ ads: AdView[] }>(`/ads?brand=${brandId}`),
      api<{ ads: AdView[] }>(`/ads/booking/${bookingId}`),
    ])
      .then(([all, mine]) => {
        setAds(all.ads);
        const ids = mine.ads.map((a) => a.adId);
        setChosen(ids);
        setSaved(ids);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the ads.'),
      );
  }, [bookingId, brandId]);
  useEffect(load, [load]);

  const upload = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    const name = String(f.get('name') ?? '').trim();
    if (!(file instanceof File) || file.size === 0) return setError('Choose a file');
    setBusy(true);
    setError('');
    setNote('');
    fetch(`/api/ads/upload?brand=${brandId}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    })
      .then(async (r) => {
        const x = (await r.json().catch(() => ({}))) as { error?: string; ad?: AdView };
        if (!r.ok || !x.ad)
          throw new ApiError(r.status, x.error ?? 'The upload failed. Try again.');
        setNote(`${x.ad.name}: ${adSummary(x.ad)}`);
        form.reset();
        load();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'The upload failed.'),
      )
      .finally(() => setBusy(false));
  };
  const save = () => {
    setBusy(true);
    setError('');
    api(`/ads/booking/${bookingId}`, { adIds: chosen })
      .then(() => {
        setNote('Ads saved for this booking.');
        load();
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };
  const toggle = (id: string) =>
    setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const changed = chosen.join() !== saved.join();

  return (
    <section className="stack" aria-label="Ads">
      <h4 style={{ margin: 0 }}>
        Ads ({saved.length} chosen; {MIN_ADS} to {MAX_ADS} take turns)
      </h4>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {ads.length === 0 && <p className="muted">No ads uploaded for this brand yet.</p>}
      <ul className="plain">
        {ads.map((a) => (
          <li key={a.adId} className="ad-row">
            <label className="ad-pick">
              <input
                type="checkbox"
                checked={chosen.includes(a.adId)}
                disabled={!canAct || a.outcome === 'fail'}
                onChange={() => toggle(a.adId)}
                aria-label={`Run ${a.name}`}
              />
            </label>
            {a.kind === 'mp4' ? (
              <video className="ad-preview" src={a.preview} muted controls preload="metadata" />
            ) : (
              // A plain img: the link is signed and short-lived (no image optimiser in between).
              <img className="ad-preview" src={a.preview} alt={a.name} />
            )}
            <div>
              <strong>{a.name}</strong>
              <div className={a.outcome === 'fail' ? 'error' : 'muted'}>{adSummary(a)}</div>
            </div>
          </li>
        ))}
      </ul>
      {canAct && ads.length > 0 && (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          onClick={save}
          disabled={busy || !changed}
        >
          Save the chosen ads
        </button>
      )}
      {canAct && (
        <form className="cal-bar" onSubmit={upload} aria-label="Upload an ad">
          <label className="rc-field">
            <span className="rc-field__label">Ad name</span>
            <input className="rc-input" name="name" maxLength={80} required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">File (picture, or 15-second MP4)</span>
            <input
              className="rc-input"
              name="file"
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4"
              required
            />
          </label>
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Upload
          </button>
        </form>
      )}
    </section>
  );
}
