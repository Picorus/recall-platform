// P5.5: a ready-made ad for a brand with none of its own: its logo, a headline (up to 30
// characters), an offer line (up to 40), an optional code and QR code, in the brand's own colour on
// one of three themes. Drawn as a 1280 × 640 picture (the screen's shape) and then checked and
// reviewed like any ad. "Make another version" moves things around (the layout), keeping the words.
// Legibility (contrast, size) is advice, never enforced (Prateek, 22 Oct 2026); the drawing keeps
// text large and on a ground it reads on.

export const AD_THEMES = [
  { key: 'midnight', label: 'Your colour on midnight' },
  { key: 'colour', label: 'Your colour as the background' },
  { key: 'band', label: 'Paper on midnight with a colour band' },
] as const;
export type AdTheme = (typeof AD_THEMES)[number]['key'];

/** How many layouts "make another version" cycles through. */
export const AD_LAYOUTS = 3;

export interface AdTemplate {
  readonly headline: string;
  readonly offer: string;
  /** A short code to show (e.g. "CHAI50"), or "". */
  readonly code: string;
  /** A link for the QR code (https), or "". */
  readonly qr: string;
  /** The brand's colour, "#RRGGBB". */
  readonly colour: string;
  readonly theme: AdTheme;
  /** 0 … AD_LAYOUTS − 1. */
  readonly layout: number;
}

/** Characters the drawing draws right: Latin, Latin-1, ₹, typographic quotes and dashes, Telugu
 * (with its joiners). Hindi is not drawn correctly by the renderer yet (its letters do not join):
 * brands upload a Hindi ad as a file. */
const DRAWABLE = /^[ -~ -ÿ₹–—‘-”…ఀ-౿‌‍]*$/;

/** The Anek font for a line: Telugu's own (it also has Latin letters and digits), else Latin. */
export const familyOf = (text: string): string =>
  /[ఀ-౿]/.test(text) ? 'Anek Telugu' : 'Anek Latin';

const MIDNIGHT = '#0E121B';
const PAPER = '#F4F4EF';
const W = 1280;
const H = 640;

/** What is wrong with a template, in words for the brand; empty when it can be drawn. */
export function templateProblems(t: AdTemplate): string[] {
  const out: string[] = [];
  const headline = t.headline.trim();
  if (headline.length < 2 || headline.length > 30) out.push('Headline: 2 to 30 characters');
  if (t.offer.trim().length > 40) out.push('Offer line: up to 40 characters');
  if (t.code !== '' && !/^[A-Z0-9-]{2,16}$/.test(t.code))
    out.push('Code: 2 to 16 capital letters, digits or dashes');
  if (t.qr !== '') {
    let ok: boolean;
    try {
      const u = new URL(t.qr);
      ok = u.protocol === 'https:' && t.qr.length <= 200;
    } catch {
      ok = false;
    }
    if (!ok) out.push('QR link: a web address starting https://, up to 200 characters');
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(t.colour)) out.push('Colour: pick one');
  if (!AD_THEMES.some((x) => x.key === t.theme)) out.push('Pick a theme');
  if (!Number.isInteger(t.layout) || t.layout < 0 || t.layout >= AD_LAYOUTS)
    out.push('Pick a layout');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>&]/.test(`${t.headline}${t.offer}`))
    out.push('Headline and offer: letters, digits and punctuation only (no < > &)');
  // Only what the drawing draws right (English, Telugu, ₹): nothing silently missing or broken.
  else if (!DRAWABLE.test(`${t.headline}${t.offer}`))
    out.push(
      'Headline and offer: English or Telugu letters, digits and punctuation (for Hindi or emoji, upload your own ad)',
    );
  return out;
}

/** Relative brightness of "#RRGGBB" (WCAG). */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Midnight or paper, whichever reads better on `ground`. */
const inkOn = (ground: string) =>
  contrast(ground, MIDNIGHT) >= contrast(ground, PAPER) ? MIDNIGHT : PAPER;

/** A font size (px) at which `text` fits `width` in Anek Latin bold (about 0.56 em a character). */
export function fitSize(text: string, width: number, max: number, min = 36): number {
  const n = Math.max(1, [...text].length);
  return Math.max(min, Math.min(max, Math.floor(width / (n * 0.56))));
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** A QR code as SVG squares inside a `size` box at (x, y), on white with its quiet zone. */
function qrSvg(
  modules: readonly (readonly boolean[])[],
  x: number,
  y: number,
  size: number,
): string {
  const n = modules.length;
  const cell = size / (n + 4);
  let out = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="12" fill="#FFFFFF"/>`;
  modules.forEach((row, r) =>
    row.forEach((on, c) => {
      if (on)
        out += `<rect x="${(x + (c + 2) * cell).toFixed(2)}" y="${(y + (r + 2) * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" fill="#000000"/>`;
    }),
  );
  return out;
}

export interface TemplateLogo {
  /** "data:image/png;base64,…" */
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The ad as an SVG picture of 1280 × 640. `qrModules` is the QR code's squares (made by the caller
 * from `t.qr`), or null. Text is drawn in Anek Latin or Telugu (the renderer is given the fonts).
 */
export function templateSvg(
  t: AdTemplate,
  logo: TemplateLogo | null,
  qrModules: readonly (readonly boolean[])[] | null,
): string {
  const ground = t.theme === 'colour' ? t.colour : MIDNIGHT;
  const ink = t.theme === 'colour' ? inkOn(t.colour) : PAPER;
  // The headline in the brand's colour on midnight when it reads well enough, else paper.
  const head = t.theme === 'midnight' && contrast(t.colour, MIDNIGHT) >= 4.5 ? t.colour : ink;
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${ground}"/>`];
  if (t.theme === 'band')
    parts.push(`<rect x="0" y="${H - 72}" width="${W}" height="72" fill="${t.colour}"/>`);
  if (t.theme === 'midnight')
    parts.push(`<rect x="0" y="0" width="16" height="${H}" fill="${t.colour}"/>`);

  const hasQr = qrModules !== null && qrModules.length > 0;
  const qrSize = 260;
  // Layouts: 0 logo left, words right; 1 all centred; 2 words left, logo top right.
  const layout = t.layout;
  // The words never run under the QR code: they keep to its left.
  const textRight = hasQr ? W - qrSize - 96 : W - 72;
  let textLeft = 72;
  let centre = false;
  const logoBox = { x: 72, y: 72, w: 300, h: 300 };
  if (layout === 0 && logo) textLeft = 72 + 300 + 56;
  if (layout === 1) {
    centre = true;
    logoBox.x = (72 + textRight) / 2 - 110;
    logoBox.y = 48;
    logoBox.w = 220;
    logoBox.h = 140;
  }
  if (layout === 2) {
    logoBox.w = 220;
    logoBox.h = 140;
    logoBox.x = (hasQr ? W - qrSize - 96 : W - 72) - 220;
    logoBox.y = 56;
  }
  if (logo) {
    const s = Math.min(logoBox.w / logo.width, logoBox.h / logo.height);
    const w = logo.width * s;
    const h = logo.height * s;
    parts.push(
      `<image href="${logo.dataUri}" x="${(logoBox.x + (logoBox.w - w) / 2).toFixed(1)}" y="${(logoBox.y + (logoBox.h - h) / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`,
    );
  }
  const width = textRight - textLeft;
  const x = centre ? (textLeft + textRight) / 2 : textLeft;
  const anchor = centre ? 'middle' : 'start';
  const headline = t.headline.trim();
  const offer = t.offer.trim();
  const hs = fitSize(headline, width, 132);
  const os = fitSize(offer, width, 72, 30);
  const top = centre ? (logo ? 300 : 230) : layout === 2 ? 290 : 250;
  parts.push(
    `<text x="${x}" y="${top}" font-family="${familyOf(headline)}" font-weight="800" font-size="${hs}" fill="${head}" text-anchor="${anchor}">${esc(headline)}</text>`,
  );
  if (offer)
    parts.push(
      `<text x="${x}" y="${top + os + 36}" font-family="${familyOf(offer)}" font-weight="600" font-size="${os}" fill="${ink}" text-anchor="${anchor}">${esc(offer)}</text>`,
    );
  if (t.code) {
    const cy = top + (offer ? os + 36 : 0) + 120;
    const cs = 52;
    const cw = [...t.code].length * cs * 0.62 + 64;
    const cx = centre ? x - cw / 2 : textLeft;
    const codeGround = t.theme === 'colour' ? ink : t.colour;
    parts.push(
      `<rect x="${cx}" y="${cy - cs - 14}" width="${cw}" height="${cs + 36}" rx="14" fill="${codeGround}"/>`,
      `<text x="${cx + cw / 2}" y="${cy}" font-family="Anek Latin" font-weight="800" font-size="${cs}" fill="${inkOn(codeGround)}" text-anchor="middle">${esc(t.code)}</text>`,
    );
  }
  if (hasQr) {
    const qx = W - qrSize - 72;
    const qy = (H - qrSize - (t.theme === 'band' ? 72 : 0)) / 2;
    parts.push(qrSvg(qrModules, qx, qy, qrSize));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}
