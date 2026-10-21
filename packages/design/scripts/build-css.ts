// Writes tokens.css for the web portals. Run: pnpm --filter @recall/design build
import { writeFileSync } from 'node:fs';
import { tokensCss } from '../src/css.ts';

writeFileSync(new URL('../tokens.css', import.meta.url), tokensCss());
console.log('Wrote packages/design/tokens.css');
