// Writes every generated file from src/tokens.ts and components.css. Run: pnpm --filter @recall/design build
//   tokens.css                                        → web apps
//   design-system/project/tokens.json                 → the RECALL design system (artifact)
//   design-system/project/components/bundle.css       → the same component styles, for its previews
import { readFileSync, writeFileSync } from 'node:fs';
import { tokensCss } from '../src/css.ts';
import { designSystemTokensJson } from '../src/design-system.ts';

const here = (path: string) => new URL(`../${path}`, import.meta.url);

writeFileSync(here('tokens.css'), tokensCss());
writeFileSync(here('design-system/project/tokens.json'), designSystemTokensJson());
writeFileSync(
  here('design-system/project/components/bundle.css'),
  `/* RECALL — copied from packages/design/components.css by the build. Edit that file, not this one. */\n${readFileSync(here('components.css'), 'utf8')}`,
);
console.log(
  'Wrote tokens.css, design-system/project/tokens.json, design-system/project/components/bundle.css',
);
