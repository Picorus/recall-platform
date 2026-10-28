// Draws the night-street pictures (brand/photos/*.webp) from scripts/night-scenes.html in a headless
// browser. Every picture is drawn twice at its own size (2560 × 1600 and 1280 × 800 for cards), never
// resized, so edges stay sharp. Run: node packages/design/scripts/photos.mjs   (needs Playwright's Chromium)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
// name: [seed, scene]. The seed fixes every random choice, so a picture comes out the same each time.
const PICTURES = {
  hero: [11, 'hero'],
  avenue: [5, 'avenue'],
  avenue2: [21, 'avenue'],
  towers: [3, 'towers'],
  towers2: [7, 'towers'],
  bridge: [8, 'bridge'],
  flyover: [4, 'flyover'],
};
const SIZES = [
  ['', 1.6, 0.88],
  ['-s', 0.8, 0.86],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`file://${here('./night-scenes.html')}`);
  for (const [name, [seed, scene]] of Object.entries(PICTURES)) {
    for (const [suffix, scale, quality] of SIZES) {
      const url = await page.evaluate(
        // Runs inside the page, where night-scenes.html defines render().
        ([s, n, k, q]) => globalThis.render(s, 1600, 1000, n, k, 'image/webp', q),
        [scene, seed, scale, quality],
      );
      writeFileSync(
        here(`../brand/photos/${name}${suffix}.webp`),
        Buffer.from(url.split(',')[1], 'base64'),
      );
      console.log(`${name}${suffix}.webp`);
    }
  }
} finally {
  await browser.close();
}
