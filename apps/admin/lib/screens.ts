// The Screens page's words (the API decides every state; these only show them).

export type ScreenLife = 'on-bike' | 'in-stock' | 'in-repair' | 'retired';

export const LIFE_NAMES: Record<ScreenLife, string> = {
  'on-bike': 'On a bike',
  'in-stock': 'In stock',
  'in-repair': 'In repair',
  retired: 'Retired',
};

export const LIFE_CHIP: Record<ScreenLife, string> = {
  'on-bike': 'rc-chip--go',
  'in-stock': 'rc-chip--offline',
  'in-repair': 'rc-chip--paused',
  retired: 'rc-chip--stop',
};

/** Does a screen match the search box? Spaces, dashes and small letters do not count ("scr 7k3m",
 * "TS 09-EA"). */
export function screenMatches(
  r: { readonly screenId: string; readonly bike: string | null; readonly serial: string },
  search: string,
): boolean {
  const bare = (t: string) => t.toUpperCase().replace(/[\s-]/g, '');
  const q = bare(search);
  return !q || [r.screenId, r.bike ?? '', r.serial].some((x) => bare(x).includes(q));
}

/** The rollout's stage in words: 1% → 10% → all screens (P2.13). */
export function stageText(state: string, stage: number): string {
  const share = ['1% of screens', '10% of screens', 'all screens'][stage] ?? 'all screens';
  switch (state) {
    case 'finished':
      return 'on all screens';
    case 'paused':
      return `paused at ${share}`;
    case 'rolled-back':
      return `rolled back (was at ${share})`;
    default:
      return `going to ${share}`;
  }
}

/** A certificate running out within 30 days needs renewing (a screen without one cannot connect). */
export function certificateSoon(until: number | null, now: number): boolean {
  return until === null || until - now < 30 * 86_400;
}

/** What staff may do with a screen in each part of its life. */
export function actionsFor(
  life: ScreenLife,
): readonly ('swap' | 'unfit' | 'to-repair' | 'repaired' | 'retired' | 'lost')[] {
  switch (life) {
    case 'on-bike':
      return ['swap', 'unfit', 'lost'];
    case 'in-stock':
      return ['to-repair', 'retired', 'lost'];
    case 'in-repair':
      return ['repaired', 'retired', 'lost'];
    default:
      return [];
  }
}

export const ACTION_NAMES = {
  swap: 'Swap for a spare',
  unfit: 'Take off the bike',
  'to-repair': 'Send to repair',
  repaired: 'Back from repair',
  retired: 'Retire for good',
  lost: 'Report lost or stolen',
} as const;
