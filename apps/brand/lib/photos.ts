// The night pictures of Hyderabad (drawn for RECALL, packages/design/brand/photos): one for each
// launch area, and the lit screen for sign-in. Served from this site, so the content rules stay
// 'self'. Areas the list does not know yet take one of the general street pictures.
import avenue from '@recall/design/photos/avenue-s.webp';
import avenue2 from '@recall/design/photos/avenue2-s.webp';
import bridge from '@recall/design/photos/bridge-s.webp';
import flyover from '@recall/design/photos/flyover-s.webp';
import heroLarge from '@recall/design/photos/hero.webp';
import towers from '@recall/design/photos/towers-s.webp';
import towers2 from '@recall/design/photos/towers2-s.webp';

export const heroPhoto = heroLarge.src;

const BY_AREA: readonly (readonly [RegExp, string])[] = [
  [/hitech|hitec|cyber/i, towers.src],
  [/madhapur|durgam/i, bridge.src],
  [/gachibowli|financial/i, flyover.src],
  [/jubilee/i, avenue.src],
  [/banjara/i, avenue2.src],
  [/kondapur/i, towers2.src],
];
const OTHERS = [avenue.src, towers.src, bridge.src, flyover.src, avenue2.src, towers2.src];

/** The picture for an area, by its name; the same area always gets the same picture. */
export function areaPhoto(name: string): string {
  const known = BY_AREA.find(([match]) => match.test(name));
  if (known) return known[1];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return OTHERS[h % OTHERS.length] ?? avenue.src;
}
