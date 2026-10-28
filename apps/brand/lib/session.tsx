'use client';
// The signed-in person for a page, or a move to the sign-in page. The API checks every request
// itself; this only decides what to show.
import lockup from '@recall/design/logo/recall-lockup-horizontal-light.svg';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';
import { Icon } from './icons';

export function useMe(): Me | undefined {
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          // Back to this page after signing in (the report link in a message, P5.7).
          const here = window.location.pathname + window.location.search;
          router.replace(here === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(here)}`);
        }
      });
  }, [router]);
  return me;
}

/** The pages a business moves between, in the top bar (Design 2.0: like a booking site, few and plain). */
const NAV = [
  ['/campaigns', 'Campaigns'],
  ['/invoices', 'Invoices'],
  ['/team', 'Team'],
  ['/statement', 'Statement'],
  ['/help', 'Help'],
] as const;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');

export function Shell({ me, children }: { readonly me: Me; readonly children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  // The business this page is for (every page carries ?brand=); read once the page is open.
  const [brand, setBrand] = useState('');
  useEffect(() => setBrand(new URLSearchParams(window.location.search).get('brand') ?? ''), []);
  const account = me.accounts.find((a) => a.brandId === brand);
  const q = `brand=${encodeURIComponent(brand)}`;
  const signOut = async () => {
    await api('/sign-out', {}).catch(() => undefined);
    router.replace('/sign-in');
  };
  const others = me.accounts.filter((a) => a.brandId !== brand);
  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__in">
          <Link className="wordmark" href={account ? `/campaigns?${q}` : '/'}>
            <img src={lockup.src} alt="RECALL" width={128} height={15} />
          </Link>
          {account && (
            <nav className="appnav" aria-label="Main">
              {NAV.filter(([href]) => href !== '/statement' || account.kind === 'agency').map(
                ([href, label]) => (
                  <Link
                    key={href}
                    href={`${href}?${q}`}
                    aria-current={path.startsWith(href) ? 'page' : undefined}
                  >
                    {label}
                  </Link>
                ),
              )}
            </nav>
          )}
          <div className="appbar__end">
            {account && (
              <Link className="rc-button rc-button--primary rc-button--small" href={`/book?${q}`}>
                Book
              </Link>
            )}
            <details className="acct">
              <summary aria-label="Your account">
                <span className="acct__who">{account?.name ?? me.shown}</span>
                <span className="acct__badge" aria-hidden="true">
                  {initials(account?.name ?? me.shown) || 'R'}
                </span>
              </summary>
              <div className="acct__menu rc-enter">
                {account && <Link href={`/business?${q}`}>Business details</Link>}
                {others.length > 0 && <p className="acct__group">Switch to</p>}
                {others.map((a) => (
                  // A full load: each page reads its business once, when it opens.
                  <a key={a.brandId} href={`/campaigns?brand=${encodeURIComponent(a.brandId)}`}>
                    {a.name}
                  </a>
                ))}
                <Link href="/business/new">Set up another business</Link>
                <button type="button" onClick={() => void signOut()}>
                  <Icon name="signout" size={16} />
                  Sign out
                </button>
              </div>
            </details>
          </div>
        </div>
      </header>
      <main className="page stack rc-enter">{children}</main>
    </div>
  );
}
