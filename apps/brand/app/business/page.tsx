'use client';
// P5.2: a business's details as RECALL has them (on its invoices), and its free week while it can
// still have it. Changing details comes with Help and account (P5.9).
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, type Business, type BusinessForm } from '../../lib/api';
import { Shell, useMe } from '../../lib/session';

export default function BusinessPage() {
  const me = useMe();
  const [b, setB] = useState<Business>();
  const [types, setTypes] = useState<BusinessForm['types']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const brand = new URLSearchParams(window.location.search).get('brand') ?? '';
    api<Business>(`/business?brand=${encodeURIComponent(brand)}`)
      .then(setB)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
    api<BusinessForm>('/business-form')
      .then((f) => setTypes(f.types))
      .catch(() => undefined);
  }, []);

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  return (
    <Shell me={me}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {b && (
        <>
          {b.freeWeek && (
            <section className="rc-card stack" aria-label="Your free week">
              <h2>Your free week</h2>
              <p>
                New businesses get one free week: {b.freeWeek.days} days in one area, up to{' '}
                {b.freeWeek.bikeHours} bike-hours, from screen time not yet sold. Nothing to pay,
                and you get the same final report.
              </p>
            </section>
          )}
          <section className="rc-card stack" aria-label="Business details">
            <h1>{b.name}</h1>
            <dl className="facts">
              <dt>You are</dt>
              <dd>{b.kind === 'agency' ? 'An agency' : 'A brand'}</dd>
              <dt>Kind of business</dt>
              <dd>{types.find((t) => t.key === b.businessType)?.label ?? '—'}</dd>
              <dt>Legal name</dt>
              <dd>{b.legalName ?? '—'}</dd>
              <dt>GST number</dt>
              <dd className="mono">{b.gstin ?? 'None'}</dd>
              <dt>State</dt>
              <dd>{b.stateName ?? '—'}</dd>
              <dt>Address</dt>
              <dd>{b.address || '—'}</dd>
              <dt>Invoices to</dt>
              <dd>{b.invoiceEmail ?? '—'}</dd>
              <dt>WhatsApp messages to</dt>
              <dd>{b.phone ? b.phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2') : '—'}</dd>
            </dl>
            <p className="muted">To change these, ask us from Help (coming soon).</p>
            <Link href={`/campaigns?brand=${encodeURIComponent(b.brandId)}`}>Your campaigns</Link>
          </section>
        </>
      )}
    </Shell>
  );
}
