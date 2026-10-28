// The portal's icons: the shared set (packages/design glyphs), drawn on a 24px grid with a 1.75
// stroke and round ends. Always beside a word, except where a button names itself (aria-label).
import { glyphs, type GlyphName } from '@recall/design';

export type IconName = GlyphName;

export function Icon({ name, size = 20 }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg className="rc-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={glyphs[name]} />
    </svg>
  );
}
