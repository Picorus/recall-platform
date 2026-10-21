# Change a colour, size or component style

All design values live in one place: `packages/design`.

| What | Where |
|---|---|
| Colours, fonts, text styles, spacing, corners, shadow (with usage notes) | `packages/design/src/tokens.ts` |
| Chart and map colours (they name tokens, never new hex values) | `packages/design/src/dataviz.ts` |
| Component styles (buttons, fields, chips, cards, stat tiles, tables) | `packages/design/components.css` |
| Component cards for the design system (preview + guideline) | `packages/design/design-system/project/components/<Name>/` |

## Steps

1. Edit the file above. For a colour, change `docs/NIGHT_SIGNAL.md` too.
2. `pnpm --filter @recall/design build` rewrites the generated files: `tokens.css` (web apps), `design-system/project/tokens.json` and `design-system/project/components/bundle.css` (the RECALL design system).
3. `pnpm check`. The contrast tests fail if a colour drops below its promise (text 4.5:1, borders and chart marks 3:1).
4. Commit with the step id, open a PR, merge when green.
5. Republish the design system (Claude does this): publish the changed files under `packages/design/design-system/project/` to the "RECALL" design-system artifact (https://claude.ai/artifact/BjjWMHaUHHX5o2VkTPMfWY), with `packages/design/design-system` as the root.

## Edits made on the design-system page

The brand book text (README and sections 01–10) and the logo files live only on the page. Token values edited on the page are overwritten by the next republish, so make token changes here instead, or copy a page edit back into `tokens.ts` first.
