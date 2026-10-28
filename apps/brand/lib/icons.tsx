// The portal's icons: one set, drawn on a 24px grid with a 1.75 stroke and round ends (the
// Design 2.0 board). Always beside a word, except where a button names itself (aria-label).
const PATHS = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'm14.5 6-6 6 6 6',
  bike: 'M5.5 19.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18.5 19.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5.5 16.5h6.5l3.2-7.5H18l.5 7.5M8.5 7h3l2 2',
  calendar:
    'M6.5 5h11a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM3.5 10h17M8 3v4M16 3v4',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  chevron: 'm6 9.5 6 6 6-6',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  help: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4M12 16.8v.01',
  image:
    'M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM9 11.1a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM4 17l4.5-4.5 4 4 2.5-2.5 5 5',
  map: 'M9 4.5 3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2zM9 4.5v13M15 6.5v13',
  megaphone: 'M4 10v4l10.5 5V5zM14.5 9a3 3 0 0 1 0 6M7 15l1.4 5h2.8l-1-4.2',
  play: 'M7 4.5v15l12-7.5z',
  plus: 'M12 5v14M5 12h14',
  receipt: 'M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8zM9 8.5h6M9 12h6M9 15.5h3',
  share: 'M4.5 19.5 6 15.6A7.5 7.5 0 1 1 9.2 18.6z',
  shield: 'M12 3.5 19.5 6v6c0 4.6-3.2 7.6-7.5 8.5-4.3-.9-7.5-3.9-7.5-8.5V6zM9 12l2 2 4-4',
  signout: 'M14.5 4h4a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-4M10 8l-4 4 4 4M6 12h10',
  users:
    'M9 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c1-3.3 3.6-5 6.5-5s5.5 1.7 6.5 5M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 15.3c2 .6 3.3 2.2 4 4.7',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg className="rc-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
