'use client';
// The portal's first page after sign-in. A new person sets up their business next (P5.2); someone
// RECALL's team gave access sees the brands and agencies they act for, each opening its campaigns
// (P5.3); with only one, it opens straight away. P5.2: a link to set up a business.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Shell, useMe } from '../lib/session';

export default function Home() {
  const me = useMe();
  const router = useRouter();
  const only = me?.accounts.length === 1 ? me.accounts[0]?.brandId : undefined;
  useEffect(() => {
    if (only) router.replace(`/campaigns?brand=${encodeURIComponent(only)}`);
  }, [only, router]);
  if (!me || only)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  return (
    <Shell me={me}>
      {me.accounts.length === 0 ? (
        <section className="rc-card stack" aria-label="Your business">
          <h1>Welcome to RECALL</h1>
          <p>
            First, tell us about your business: its GST number, name and the email for invoices. New
            businesses get one free week.
          </p>
          <Link className="rc-button rc-button--primary" href="/business/new">
            Set up your business
          </Link>
          <p className="muted">
            Already booking with RECALL? Ask your account manager to add this number or email to
            your business.
          </p>
        </section>
      ) : (
        <section className="rc-card stack" aria-label="Your accounts">
          <h1>Your accounts</h1>
          <ul className="plain">
            {me.accounts.map((a) => (
              <li key={a.brandId}>
                <Link href={`/campaigns?brand=${encodeURIComponent(a.brandId)}`}>
                  <b>{a.name}</b>
                </Link>{' '}
                <span className="muted">
                  · {a.kind === 'agency' ? 'Agency' : 'Brand'} ·{' '}
                  {a.role === 'owner' ? 'Owner' : 'Can book'}
                </span>
              </li>
            ))}
          </ul>
          <Link href="/business/new">Set up another business</Link>
        </section>
      )}
    </Shell>
  );
}
