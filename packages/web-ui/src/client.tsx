'use client';
// Parts the brand and staff portals share (Design 2.0, P7.7.6). Styles are in
// packages/design/components.css (classes rc-info, rc-fold, rc-theme, rc-pointer).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { THEME_COOKIE, type ThemeChoice } from './theme';

/* ───── Information that is there when wanted ───── */

/**
 * A short explanation folded behind a small (i) and a few words: the page stays calm, nothing is
 * lost. Opens and closes by click, keyboard or screen reader (a native <details>).
 */
export function Info({
  label = 'How this works',
  children,
  open,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly open?: boolean;
}) {
  return (
    <details className="rc-info" open={open}>
      <summary>
        <span className="rc-info__i" aria-hidden="true">
          i
        </span>
        {label}
      </summary>
      <div className="rc-info__body">{children}</div>
    </details>
  );
}

/** A titled section that opens on a click (rules, tips, long lists). */
export function Fold({
  title,
  hint,
  children,
  open,
}: {
  readonly title: string;
  /** A few words under the title saying what is inside. */
  readonly hint?: string;
  readonly children: ReactNode;
  readonly open?: boolean;
}) {
  return (
    <details className="rc-fold" open={open}>
      <summary>
        <span className="rc-fold__title">
          <b>{title}</b>
          {hint && <span>{hint}</span>}
        </span>
        <svg
          className="rc-fold__chev"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <path d="m6 9.5 6 6 6-6" />
        </svg>
      </summary>
      <div className="rc-fold__body">{children}</div>
    </details>
  );
}

/* ───── Light and dark ───── */

const CHOICES: readonly (readonly [ThemeChoice, string, string])[] = [
  [
    'system',
    'Auto',
    'M5.5 4h13A2.5 2.5 0 0 1 21 6.5V14a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 14V6.5A2.5 2.5 0 0 1 5.5 4zM8.5 20h7M12 16.5V20',
  ],
  [
    'light',
    'Light',
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  ],
  ['dark', 'Dark', 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z'],
];

/** Auto (the device's setting), Light or Dark; kept for a year in a cookie the server reads. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  useEffect(() => {
    const m = new RegExp(`(?:^|; )${THEME_COOKIE}=(light|dark)`).exec(document.cookie);
    setChoice((m?.[1] as ThemeChoice | undefined) ?? 'system');
  }, []);
  const pick = (c: ThemeChoice) => {
    setChoice(c);
    const root = document.documentElement;
    if (c === 'system') {
      delete root.dataset.theme;
      document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    } else {
      root.dataset.theme = c;
      document.cookie = `${THEME_COOKIE}=${c}; path=/; max-age=31536000; SameSite=Lax`;
    }
  };
  return (
    <div className="rc-theme" role="group" aria-label="Look">
      {CHOICES.map(([c, label, d]) => (
        <button key={c} type="button" aria-pressed={choice === c} onClick={() => pick(c)}>
          <svg className="rc-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d={d} />
          </svg>
          {label}
        </button>
      ))}
    </div>
  );
}

/* ───── The pointer ───── */

const CLICKABLE =
  'a[href], button:not(:disabled), summary, label, select, [role="button"], [role="checkbox"], [role="tab"], [role="radio"], input[type="checkbox"], input[type="radio"]';

/**
 * A soft ring that follows the mouse and swells over anything you can click, then dips when you
 * press: the page answers before the click. Mouse and trackpad only (never on touch), and nothing
 * moves when the device asks for reduced motion. The normal cursor stays.
 */
export function Pointer() {
  const ring = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    const fine = matchMedia('(pointer: fine)').matches;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!fine || still) return;
    let x = -100;
    let y = -100;
    let rx = x;
    let ry = y;
    let raf = 0;
    const loop = () => {
      rx += (x - rx) * 0.24;
      ry += (y - ry) * 0.24;
      el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      raf = Math.abs(x - rx) + Math.abs(y - ry) > 0.2 ? requestAnimationFrame(loop) : 0;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      x = e.clientX;
      y = e.clientY;
      el.dataset.on = 'true';
      const target = e.target instanceof Element ? e.target.closest(CLICKABLE) : null;
      el.dataset.hover = target ? 'true' : 'false';
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const down = () => (el.dataset.press = 'true');
    const up = () => (el.dataset.press = 'false');
    const leave = () => (el.dataset.on = 'false');
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, []);
  return <div ref={ring} className="rc-pointer" aria-hidden="true" />;
}
