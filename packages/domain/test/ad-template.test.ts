import { describe, expect, it } from 'vitest';
import {
  contrast,
  fitSize,
  templateProblems,
  templateSvg,
  type AdTemplate,
} from '../src/ad-template.js';

const t: AdTemplate = {
  headline: 'Irani Chai',
  offer: 'Two chai for ₹30 till Sunday',
  code: 'CHAI30',
  qr: 'https://iranichai.in/offer',
  colour: '#C9F24B',
  theme: 'midnight',
  layout: 0,
};

describe('ad template (P5.5)', () => {
  it('checks the words, code, link, colour and theme', () => {
    expect(templateProblems(t)).toEqual([]);
    expect(templateProblems({ ...t, headline: 'x'.repeat(31) })).toEqual([
      'Headline: 2 to 30 characters',
    ]);
    expect(templateProblems({ ...t, offer: 'y'.repeat(41) })).toEqual([
      'Offer line: up to 40 characters',
    ]);
    expect(templateProblems({ ...t, code: 'chai 30' })).toHaveLength(1);
    expect(templateProblems({ ...t, qr: 'http://x.in' })).toHaveLength(1);
    expect(templateProblems({ ...t, qr: 'javascript:alert(1)' })).toHaveLength(1);
    expect(templateProblems({ ...t, headline: '<b>Chai</b>' })).toContain(
      'Headline and offer: letters, digits and punctuation only (no < > &)',
    );
    expect(templateProblems({ ...t, layout: 3 })).toEqual(['Pick a layout']);
    expect(templateProblems({ ...t, headline: 'ఇరానీ చాయ్', offer: 'రెండు చాయ్ ₹30' })).toEqual([]);
    for (const headline of ['Chai ☕', 'दो चाय'])
      expect(templateProblems({ ...t, headline })).toEqual([
        'Headline and offer: English or Telugu letters, digits and punctuation (for Hindi or emoji, upload your own ad)',
      ]);
  });

  it('draws 1280 × 640 in every theme and layout, the words in it, a QR when asked', () => {
    for (const theme of ['midnight', 'colour', 'band'] as const)
      for (const layout of [0, 1, 2]) {
        const svg = templateSvg({ ...t, theme, layout }, null, [
          [true, false],
          [false, true],
        ]);
        expect(svg).toMatch(/^<svg [^>]*width="1280" height="640"/);
        expect(svg).toContain('>Irani Chai</text>');
        expect(svg).toContain('>CHAI30</text>');
        expect(svg).toContain('fill="#FFFFFF"');
      }
    expect(templateSvg({ ...t, qr: '' }, null, null)).not.toContain('fill="#FFFFFF"');
  });

  it('text on the brand colour is midnight or paper, whichever reads better', () => {
    const light = templateSvg({ ...t, theme: 'colour', colour: '#FFE600' }, null, null);
    expect(light).toContain('fill="#0E121B" text-anchor="start">Irani Chai');
    const dark = templateSvg({ ...t, theme: 'colour', colour: '#1A237E' }, null, null);
    expect(dark).toContain('fill="#F4F4EF" text-anchor="start">Irani Chai');
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  it('a long headline gets smaller to fit', () => {
    expect(fitSize('Chai', 1000, 132)).toBe(132);
    expect(fitSize('A much longer headline here!!', 1000, 132)).toBeLessThan(132);
  });
});
