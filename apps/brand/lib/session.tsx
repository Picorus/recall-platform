'use client';
// The signed-in person for a page, or a move to the sign-in page. The API checks every request
// itself; this only decides what to show.
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';

export function useMe(): Me | undefined {
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    api<Me>('/me')
      .then(setMe)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) router.replace('/sign-in');
      });
  }, [router]);
  return me;
}

export function Shell({ me, children }: { readonly me: Me; readonly children: ReactNode }) {
  const router = useRouter();
  const signOut = async () => {
    await api('/sign-out', {}).catch(() => undefined);
    router.replace('/sign-in');
  };
  return (
    <div className="shell">
      <header className="top">
        <span className="brand">RECALL</span>
        <nav>
          <span className="muted">{me.shown}</span>
          <button type="button" className="link-button" onClick={() => void signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main className="stack">{children}</main>
    </div>
  );
}
