'use client';
// P5.4.1 Our areas: every area that is on now, in the exact shapes our team draws, on a map that
// draws them in one by one, with their names and sizes beside it; a link to book them.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AreasMap, useOurAreas } from '../../lib/areas-map';
import { Shell, useMe } from '../../lib/session';

export default function OurAreas({ styleUrl }: { readonly styleUrl: string }) {
  const me = useMe();
  const { areas, error } = useOurAreas();
  const [brand, setBrand] = useState('');
  useEffect(() => setBrand(new URLSearchParams(window.location.search).get('brand') ?? ''), []);
  const mine = me?.accounts.some((a) => a.brandId === brand) ?? false;

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  return (
    <Shell me={me}>
      <header className="page-head">
        <p className="eyebrow">Where the bikes ride</p>
        <h1>Our areas</h1>
      </header>
      <p className="muted">
        Your ads play while the bikes ride inside these areas. Tap an area, or its name, to see how
        big it is.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {areas && areas.length === 0 && <p>No areas are open for booking right now.</p>}
      {areas && areas.length > 0 && (
        <section className="rc-card stack" aria-label="Map of our areas">
          <AreasMap areas={areas} styleUrl={styleUrl} />
        </section>
      )}
      {mine && (
        <p>
          <Link
            className="rc-button rc-button--primary"
            href={`/book?brand=${encodeURIComponent(brand)}`}
          >
            Book these areas
          </Link>
        </p>
      )}
    </Shell>
  );
}
