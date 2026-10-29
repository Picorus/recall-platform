'use client';
// The signed-in member for a page, or a move to the sign-in page. The API checks every request
// itself; this only decides what to show.
import { type GlyphName } from '@recall/design';
import lockupDark from '@recall/design/logo/recall-lockup-horizontal-dark.svg';
import lockup from '@recall/design/logo/recall-lockup-horizontal-light.svg';
import { ThemeSwitch } from '@recall/web-ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Member } from './api';
import { Icon } from './icons';
import { accessText } from './staff';

export function useMember(): Member | undefined {
  const router = useRouter();
  const [member, setMember] = useState<Member>();
  useEffect(() => {
    api<{ member: Member; alerts?: Member['alerts'] }>('/staff/me')
      .then((r) => setMember({ ...r.member, alerts: r.alerts ?? [] }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) router.replace('/sign-in');
      });
  }, [router]);
  return member;
}

type Area = Member['areas'][number];
interface Item {
  readonly href: string;
  readonly label: string;
  readonly icon: GlyphName;
  /** Who sees it: super admins always; otherwise anyone with one of these areas (none = everyone). */
  readonly areas?: readonly Area[];
  readonly superOnly?: boolean;
}

/** The menu, grouped by job (Design 2.0, like Stripe's). The role rules are the same as before. */
const MENU: readonly (readonly [string, readonly Item[]])[] = [
  [
    '',
    [
      { href: '/', label: 'Today', icon: 'clock' },
      { href: '/dashboard', label: 'Dashboard', icon: 'bars', areas: ['sales', 'finance'] },
    ],
  ],
  [
    'Sales',
    [
      {
        href: '/brands',
        label: 'Brands',
        icon: 'megaphone',
        areas: ['sales', 'finance', 'support'],
      },
      { href: '/poc', label: 'POC', icon: 'users', areas: ['sales', 'finance'] },
      { href: '/calendar', label: 'Calendar', icon: 'calendar', areas: ['operations', 'sales'] },
      { href: '/prices', label: 'Prices', icon: 'receipt', areas: ['sales', 'finance'] },
      { href: '/areas', label: 'Areas', icon: 'map', areas: ['operations', 'sales'] },
    ],
  ],
  [
    'Fleet',
    [
      { href: '/fleet', label: 'Fleet map', icon: 'pin', areas: ['operations'] },
      { href: '/screens', label: 'Screens', icon: 'screen', areas: ['operations'] },
      { href: '/riders', label: 'Riders', icon: 'bike', areas: ['operations', 'support'] },
    ],
  ],
  [
    'Work',
    [
      { href: '/reviews', label: 'Ad review', icon: 'image', areas: ['ad-review', 'sales'] },
      {
        href: '/delivery',
        label: 'Delivery',
        icon: 'check',
        areas: ['operations', 'sales', 'support', 'finance'],
      },
      { href: '/support', label: 'Support', icon: 'chat', areas: ['support'] },
      {
        href: '/reports',
        label: 'Reports',
        icon: 'download',
        areas: ['sales', 'support', 'finance'],
      },
    ],
  ],
  [
    'Money',
    [
      { href: '/payouts', label: 'Payouts', icon: 'bank', areas: ['finance'] },
      { href: '/money', label: 'Money', icon: 'wallet', areas: ['finance'] },
    ],
  ],
  [
    'Admin',
    [
      { href: '/staff', label: 'Staff', icon: 'users', superOnly: true },
      { href: '/audit', label: 'Audit log', icon: 'shield', superOnly: true },
      { href: '/settings', label: 'Settings', icon: 'sliders' },
    ],
  ],
];

const sees = (member: Member, item: Item) =>
  member.role === 'super-admin' ||
  (!item.superOnly && (!item.areas || item.areas.some((a) => member.areas.includes(a))));

const isOn = (path: string, href: string) =>
  href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);

export function Shell({
  member,
  children,
}: {
  readonly member: Member;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const path = usePathname();
  const signOut = async () => {
    await api('/staff/sign-out', {}).catch(() => undefined);
    router.replace('/sign-in');
  };
  const menu = MENU.map(
    ([group, items]) => [group, items.filter((i) => sees(member, i))] as const,
  ).filter(([, items]) => items.length > 0);
  const all = menu.flatMap(([, items]) => items);
  const here = all.find((i) => isOn(path, i.href));
  // Ctrl K (or ⌘K): jump to any page you can see.
  const [jump, setJump] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setJump((j) => !j);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div className="frame">
      <aside className="side">
        <div className="side__org">
          <img className="rc-logo--light" src={lockup.src} alt="RECALL" width={112} height={13} />
          <img
            className="rc-logo--dark"
            src={lockupDark.src}
            alt="RECALL"
            width={112}
            height={13}
          />
          <span>Staff</span>
        </div>
        <button type="button" className="side__jump" onClick={() => setJump(true)}>
          <Icon name="search" size={16} />
          Jump to…
          <kbd>Ctrl K</kbd>
        </button>
        <nav aria-label="Menu" className="side__nav">
          {menu.map(([group, items]) => (
            <div key={group || 'top'} className="side__group">
              {group && <p className="side__label">{group}</p>}
              {items.map((i) => (
                <Link
                  key={i.href}
                  href={i.href}
                  aria-current={here?.href === i.href ? 'page' : undefined}
                >
                  <Icon name={i.icon} size={18} />
                  {i.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="side__theme">
          <ThemeSwitch />
        </div>
        <div className="side__me">
          <span className="side__badge" aria-hidden="true">
            {member.name
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase())
              .join('')}
          </span>
          <span className="side__who">
            {member.name} · {accessText(member.role, member.areas)}
          </span>
          <button
            className="rc-button rc-button--quiet rc-button--small"
            onClick={signOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </aside>
      <div className="frame__main">
        <header className="crumbs">
          <span>RECALL</span>
          <Icon name="forward" size={14} />
          <b>{here?.label ?? 'Staff'}</b>
        </header>
        <main className="frame__page rc-enter">
          {/* P7.8: the POC's alerts for super admins, on every page but Settings (its own card). */}
          {(member.alerts?.length ?? 0) > 0 && path !== '/settings' && (
            <div className="side-banners" aria-label="POC alerts">
              {member.alerts?.map((a) => (
                <p
                  key={a.kind}
                  className={`banner${a.kind === 'months-over' ? ' banner--warn' : ''}`}
                  role="status"
                >
                  {a.text} <Link href="/settings">Settings</Link>
                </p>
              ))}
            </div>
          )}
          {children}
        </main>
      </div>
      {jump && <Jump items={all} onClose={() => setJump(false)} />}
    </div>
  );
}

/** The jump box: type a few letters of a page, arrows to move, Enter to go, Esc to close. */
function Jump({
  items,
  onClose,
}: {
  readonly items: readonly Item[];
  readonly onClose: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const found = items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase()));
  const go = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    router.push(i.href);
  };
  return (
    <div
      className="jump"
      role="dialog"
      aria-modal="true"
      aria-label="Jump to a page"
      onClick={onClose}
    >
      <div className="jump__box" onClick={(e) => e.stopPropagation()}>
        <div className="jump__q">
          <Icon name="search" size={18} />
          <input
            autoFocus
            aria-label="Page"
            placeholder="Type a page…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAt((a) => Math.min(found.length - 1, a + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAt((a) => Math.max(0, a - 1));
              }
              if (e.key === 'Enter') go(found[at]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="jump__list">
          {found.map((i, k) => (
            <li key={i.href}>
              <button
                type="button"
                className={k === at ? 'on' : ''}
                onMouseEnter={() => setAt(k)}
                onClick={() => go(i)}
              >
                <Icon name={i.icon} size={18} />
                {i.label}
              </button>
            </li>
          ))}
          {found.length === 0 && <li className="jump__none">No page by that name.</li>}
        </ul>
      </div>
    </div>
  );
}
