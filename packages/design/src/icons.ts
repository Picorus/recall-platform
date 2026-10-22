// App icons for every platform, derived from the brand's own app icon (brand/logo/recall-app-icon.svg).
// Nothing is redrawn: the Afterimage rects are copied and only scaled or moved as each platform needs.

export const ICON_SIZE = 512;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  fill: string;
}

/** Reads the volt symbol rects and the ground colour out of the app icon SVG. */
export function parseAppIcon(svg: string): { ground: string; corner: number; symbol: Rect[] } {
  const rects = [...svg.matchAll(/<rect\b([^>]*)>/g)].map((m) => {
    const attrs = Object.fromEntries(
      [...(m[1] ?? '').matchAll(/([a-z]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    );
    return {
      x: Number(attrs.x ?? 0),
      y: Number(attrs.y ?? 0),
      width: Number(attrs.width),
      height: Number(attrs.height),
      rx: Number(attrs.rx ?? 0),
      fill: String(attrs.fill),
    };
  });
  const [ground, ...symbol] = rects;
  if (!ground || ground.width !== ICON_SIZE || symbol.length !== 3) {
    throw new Error('recall-app-icon.svg is not the expected 512 ground + 3-part Afterimage');
  }
  return { ground: ground.fill, corner: ground.rx, symbol };
}

function rectsSvg(symbol: readonly Rect[], scale: number): string {
  const c = ICON_SIZE / 2;
  const n = (v: number) => Number(v.toFixed(2));
  return symbol
    .map(
      (r) =>
        `<rect x="${n(c + (r.x - c) * scale)}" y="${n(c + (r.y - c) * scale)}" width="${n(r.width * scale)}" height="${n(r.height * scale)}" rx="${n(r.rx * scale)}" fill="${r.fill}"/>`,
    )
    .join('');
}

function svg(label: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" width="${ICON_SIZE}" height="${ICON_SIZE}" role="img" aria-label="${label}">${body}</svg>\n`;
}

/**
 * Android shows the middle 72 of an adaptive icon's 108 units, so the symbol is scaled by 72/108 to look
 * the same size as on the rounded icon, and stays inside the 66-unit safe circle.
 */
export const ADAPTIVE_SCALE = 72 / 108;

export function iconVariants(appIconSvg: string): Record<string, string> {
  const { ground, symbol } = parseAppIcon(appIconSvg);
  const full = `<rect width="${ICON_SIZE}" height="${ICON_SIZE}" fill="${ground}"/>`;
  return {
    // Platforms that cut their own corners (iOS, Play Store, PWA "maskable"): full-bleed square.
    'recall-app-icon-square.svg': svg('RECALL app icon', full + rectsSvg(symbol, 1)),
    // Android adaptive icon foreground: symbol only, on transparent; the ground is the background colour.
    'recall-app-icon-foreground.svg': svg('RECALL app icon', rectsSvg(symbol, ADAPTIVE_SCALE)),
  };
}

/** Every PNG the apps need: [file, source svg, size in px]. */
export const iconPngs: readonly [file: string, source: string, size: number][] = [
  ['web/favicon-32.png', 'recall-app-icon.svg', 32],
  ['web/apple-touch-icon.png', 'recall-app-icon-square.svg', 180],
  ['web/icon-192.png', 'recall-app-icon.svg', 192],
  ['web/icon-512.png', 'recall-app-icon.svg', 512],
  ['web/icon-maskable-512.png', 'recall-app-icon-square.svg', 512],
  ['android/play-store-512.png', 'recall-app-icon-square.svg', 512],
  ['android/adaptive-foreground-1024.png', 'recall-app-icon-foreground.svg', 1024],
  ['app/icon-1024.png', 'recall-app-icon-square.svg', 1024],
];
