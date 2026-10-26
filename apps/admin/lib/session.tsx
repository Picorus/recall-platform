'use client';
// The signed-in member for a page, or a move to the sign-in page. The API checks every request
// itself; this only decides what to show.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Member } from './api';
import { accessText } from './staff';

export function useMember(): Member | undefined {
  const router = useRouter();
  const [member, setMember] = useState<Member>();
  useEffect(() => {
    api<{ member: Member }>('/staff/me')
      .then((r) => setMember(r.member))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) router.replace('/sign-in');
      });
  }, [router]);
  return member;
}

export function Shell({
  member,
  children,
}: {
  readonly member: Member;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const signOut = async () => {
    await api('/staff/sign-out', {}).catch(() => undefined);
    router.replace('/sign-in');
  };
  return (
    <div className="shell">
      <header className="top">
        <span className="brand">RECALL admin</span>
        <nav>
          <Link href="/">Today</Link>
          {(member.role === 'super-admin' || member.areas.includes('operations')) && (
            <Link href="/fleet">Fleet map</Link>
          )}
          {(member.role === 'super-admin' || member.areas.includes('operations')) && (
            <Link href="/screens">Screens</Link>
          )}
          {(member.role === 'super-admin' ||
            member.areas.includes('operations') ||
            member.areas.includes('sales')) && <Link href="/areas">Areas</Link>}
          {(member.role === 'super-admin' ||
            member.areas.includes('operations') ||
            member.areas.includes('sales')) && <Link href="/calendar">Calendar</Link>}
          {(member.role === 'super-admin' ||
            member.areas.includes('sales') ||
            member.areas.includes('finance') ||
            member.areas.includes('support')) && <Link href="/brands">Brands</Link>}
          {(member.role === 'super-admin' ||
            member.areas.includes('sales') ||
            member.areas.includes('finance')) && <Link href="/prices">Prices</Link>}
          {(member.role === 'super-admin' ||
            member.areas.includes('ad-review') ||
            member.areas.includes('sales')) && <Link href="/reviews">Ad review</Link>}
          {member.role === 'super-admin' && <Link href="/staff">Staff</Link>}
          <span className="muted">
            {member.name} · {accessText(member.role, member.areas)}
          </span>
          <button className="rc-button rc-button--quiet" onClick={signOut} type="button">
            Sign out
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
