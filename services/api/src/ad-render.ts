// P5.5: draws a ready-made ad (packages/domain/src/ad-template.ts) as a 1280 × 640 PNG, with the
// brand's logo and a QR code, in Anek (the brand's font; Latin and Telugu, bundled:
// nothing is fetched). The
// picture then goes through the same checks and review as any uploaded ad.
import { Resvg } from '@resvg/resvg-js';
import { templateSvg, type AdTemplate, type TemplateLogo } from '@recall/domain';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
/** Anek Latin and Telugu, semibold and extrabold: English and Telugu words. */
const FONTS = [
  ['anek-latin', 'AnekLatin'],
  ['anek-telugu', 'AnekTelugu'],
].flatMap(([pkg, name]) =>
  ['600SemiBold', '800ExtraBold'].map((w) =>
    require.resolve(`@expo-google-fonts/${pkg}/${w}/${name}_${w}.ttf`),
  ),
);

/** The QR code's squares for a link. */
export function qrModules(link: string): boolean[][] {
  const code = QRCode.create(link, { errorCorrectionLevel: 'M' });
  const n = code.modules.size;
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => code.modules.get(r, c) === 1),
  );
}

export function renderAd(
  t: AdTemplate,
  logo: {
    readonly data: Uint8Array;
    readonly contentType: string;
    readonly width: number;
    readonly height: number;
  } | null,
): Uint8Array {
  const l: TemplateLogo | null = logo
    ? {
        dataUri: `data:${logo.contentType};base64,${Buffer.from(logo.data).toString('base64')}`,
        width: logo.width,
        height: logo.height,
      }
    : null;
  const svg = templateSvg(t, l, t.qr ? qrModules(t.qr) : null);
  const png = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Anek Latin' },
  })
    .render()
    .asPng();
  return new Uint8Array(png);
}
