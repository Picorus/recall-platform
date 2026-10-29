// Copies MapLibre's worker into public/ so the browser can load it from this site (the bundler does
// not carry it over; MapLibre 6 loads it as a separate file). Run before `next build` and `next dev`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.css'));
mkdirSync(join(here, '..', 'public'), { recursive: true });
copyFileSync(
  join(dist, 'maplibre-gl-worker.mjs'),
  join(here, '..', 'public', 'maplibre-gl-worker.mjs'),
);
