'use client';
// P5.5: a ready-made ad for a brand with none: its logo, a headline (up to 30 characters), an offer
// line (up to 40), an optional code and QR code, its colour and one of three themes. The picture is
// drawn on our server as you type; "Make another version" moves things around; "Use this ad" keeps
// it as one of your ads (checked and reviewed like any other).
import { useEffect, useRef, useState } from 'react';
import { ApiError, upload, type Ad } from '../../lib/api';

const THEMES = [
  ['midnight', 'Your colour on midnight'],
  ['colour', 'Your colour as the background'],
  ['band', 'Paper on midnight with a colour band'],
] as const;
const SWATCHES = ['#C9F24B', '#FFD23F', '#FF7A00', '#E63946', '#2A9D8F', '#3A86FF', '#FFFFFF'];

async function post(path: string, body: object): Promise<Response> {
  return fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
}

export default function MakeAd({
  brand,
  onMade,
}: {
  readonly brand: string;
  readonly onMade: (ad: Ad) => void;
}) {
  const [t, setT] = useState({
    headline: '',
    offer: '',
    code: '',
    qr: '',
    colour: '#C9F24B',
    theme: 'midnight' as (typeof THEMES)[number][0],
    layout: 0,
  });
  const [picture, setPicture] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [logoAt, setLogoAt] = useState(0);
  const asked = useRef(0);
  const b = encodeURIComponent(brand);

  // Drawn a moment after the last change; only the newest picture is shown.
  useEffect(() => {
    if (t.headline.trim().length < 2) return;
    const mine = ++asked.current;
    const timer = setTimeout(() => {
      void post(`/ads/template-preview?brand=${b}`, { template: t }).then(async (r) => {
        if (mine !== asked.current) return;
        if (!r.ok) {
          const e = (await r.json().catch(() => ({}))) as { error?: string };
          setProblem(e.error ?? 'Could not draw it. Try again.');
          return;
        }
        const url = URL.createObjectURL(await r.blob());
        setPicture((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
        setProblem('');
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [t, b, logoAt]);

  const sendLogo = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await upload(`/logo?brand=${b}`, file);
      setLogoAt(Date.now());
      setProblem('');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The logo did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const use = async () => {
    setBusy(true);
    try {
      const r = await post(`/ads/template?brand=${b}`, { template: t });
      const x = (await r.json().catch(() => ({}))) as { ad?: Ad; error?: string };
      if (!r.ok || !x.ad) throw new Error(x.error ?? 'Could not keep it. Try again.');
      onMade(x.ad);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not keep it. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const set = (p: Partial<typeof t>) => setT({ ...t, ...p });
  return (
    <section className="rc-card stack" aria-label="Make an ad">
      <h2>No ad? Make one</h2>
      <label className="rc-field">
        <span className="rc-field__label">
          Your logo (PNG or JPEG, up to 2 MB and 2,000 pixels)
        </span>
        <input
          className="rc-input"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => void sendLogo(e.target.files?.[0])}
        />
      </label>
      <label className="rc-field">
        <span className="rc-field__label">Headline</span>
        <input
          className="rc-input"
          value={t.headline}
          maxLength={30}
          onChange={(e) => set({ headline: e.target.value })}
          placeholder="Irani Chai"
        />
        <span className="rc-field__help">{t.headline.length} of 30</span>
      </label>
      <label className="rc-field">
        <span className="rc-field__label">Offer line</span>
        <input
          className="rc-input"
          value={t.offer}
          maxLength={40}
          onChange={(e) => set({ offer: e.target.value })}
          placeholder="Two chai for ₹30 till Sunday"
        />
        <span className="rc-field__help">{t.offer.length} of 40</span>
      </label>
      <div className="fields">
        <label className="rc-field">
          <span className="rc-field__label">Code (optional)</span>
          <input
            className="rc-input mono"
            value={t.code}
            maxLength={16}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
            placeholder="CHAI30"
          />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">QR code link (optional)</span>
          <input
            className="rc-input"
            value={t.qr}
            onChange={(e) => set({ qr: e.target.value })}
            placeholder="https://"
          />
        </label>
      </div>
      <div className="row" role="group" aria-label="Your colour">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            className="swatch"
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            aria-pressed={t.colour.toUpperCase() === c}
            onClick={() => set({ colour: c })}
          />
        ))}
        <label className="row">
          <input
            type="color"
            value={t.colour}
            aria-label="Another colour"
            onChange={(e) => set({ colour: e.target.value.toUpperCase() })}
          />
          Another colour
        </label>
      </div>
      <div className="row" role="radiogroup" aria-label="Theme">
        {THEMES.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="radio"
            className="rc-chip"
            aria-checked={t.theme === k}
            aria-pressed={t.theme === k}
            onClick={() => set({ theme: k })}
          >
            {label}
          </button>
        ))}
      </div>
      {picture && t.headline.trim().length >= 2 && (
        <img className="ad-preview" src={picture} alt="Your ad as it will look" />
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="rc-button rc-button--secondary"
          disabled={busy || t.headline.trim().length < 2}
          onClick={() => set({ layout: (t.layout + 1) % 3 })}
        >
          Make another version
        </button>
        <button
          type="button"
          className="rc-button rc-button--primary"
          disabled={busy || !picture || t.headline.trim().length < 2 || problem !== ''}
          onClick={() => void use()}
        >
          Use this ad
        </button>
      </div>
      <p className="muted">
        Light words on a dark ground read best at night. Your colour is yours: we show it as you
        pick it.
      </p>
    </section>
  );
}
