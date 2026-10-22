// Writes every generated file from the sources. Run: pnpm --filter @recall/design build
//   tokens.css                                        → web apps
//   design-system/project/tokens.json                 → the RECALL design system (artifact)
//   design-system/project/components/bundle.css       → the same component styles, for its previews
//   brand/icons/**                                    → app icons from brand/logo/recall-app-icon.svg
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { tokensCss } from '../src/css.ts';
import { designSystemTokensJson } from '../src/design-system.ts';
import { iconPngs, iconVariants } from '../src/icons.ts';

const here = (path: string) => new URL(`../${path}`, import.meta.url);
const write = (path: string, data: string | Uint8Array) => {
  mkdirSync(dirname(fileURLToPath(here(path))), { recursive: true });
  writeFileSync(here(path), data);
};

write('tokens.css', tokensCss());
write('design-system/project/tokens.json', designSystemTokensJson());
write(
  'design-system/project/components/bundle.css',
  `/* RECALL — copied from packages/design/components.css by the build. Edit that file, not this one. */\n${readFileSync(here('components.css'), 'utf8')}`,
);

const appIcon = readFileSync(here('brand/logo/recall-app-icon.svg'), 'utf8');
const svgs: Record<string, string> = { 'recall-app-icon.svg': appIcon, ...iconVariants(appIcon) };
for (const [name, text] of Object.entries(svgs)) {
  if (name !== 'recall-app-icon.svg') write(`brand/icons/${name}`, text);
}
copyFileSync(here('brand/logo/recall-app-icon.svg'), here('brand/icons/web/favicon.svg'));
for (const [file, source, size] of iconPngs) {
  const png = new Resvg(svgs[source] ?? '', { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng();
  write(`brand/icons/${file}`, png);
}
console.log('Wrote tokens.css, design-system files and brand/icons');
