# Work log

Newest first. Each entry: date · step id · what changed · tests · open issues · next.

## 22 Oct 2026 · P0.3.4 · Batch 2b: rider app complete (for approval)
- Batch 2a approved by Prateek.
- Canvas version 45: five more rider screens (top row, right): R06 Founding rider pay (POC; model v5.2: ₹2,000/₹4,000/₹6,000 base + ₹6,000 bonus, full at 150+ verified hours inside Hyderabad, part at 100–150, none under 100; day-90 ₹3,000 into the loan), R07 Your screen (status, care, report a problem with photo, repair or swap), R08 Help (WhatsApp, call, requests, plain answers), R09 Alerts (silent while moving), R10 Profile and settings (language, documents, bank re-check with ₹1, leave RECALL).
- Navigation wired: Device and Help tabs, alerts bell and profile from Today, founding pay from Earnings. All 11 plan screens (P4.1–P4.11) now drawn.
- Open question for Prateek: POC bonus "pro rata 100–150" — (a) 0 at 100 h rising to ₹6,000 at 150 h, or (b) hours ÷ 150 × ₹6,000? No part amount shown until decided.
- Placeholders: charging steps (screen maker), support hours and number, rules for returning a loan-bought screen.
- **Next: batch 3** — admin screens, starting with "Live operations" (still uses pre-v5.4 plays-per-brand), for approval.

## 22 Oct 2026 · P0.3.4 · Batch 2a: rider app (for approval)
- Canvas version 44 (https://claude.ai/artifact/MsppEXdv7UShL6FjJBvNBQ), rider rows at the top.
- Fixed Today (P4.4) and Earnings (P4.5) against plan P4 and model v5.3: "this hour sold ₹210" (share-hour leftover) → a sold peak hour is ₹300, ₹264 after agency cuts, rider ₹25 + ₹66; unsold hours pay ₹25. Payouts every Monday (plan), not Friday. Weekly pay no longer subtracts the screen EMI (the bank takes it; RECALL never does, P4.7): payout ₹3,302. Removed an unverified tax threshold. Menu labels 4.3:1 → 5.6:1 (#8A909C). Sample dates moved to March 2028 (after the EMI holiday); loan figures recomputed (2 of 36 paid, ₹46,580 to go).
- New: R01 Sign in and language (Telugu, Hindi, English; WhatsApp code, SMS fallback), R02 Join RECALL (6 steps with status, the camera line), R03 Fitting (slot, QR link, fitting check), R04 Payouts (every Monday, history, tax certificate), R05 Screen loan (bank's data, EMI holiday, day-90 bonus, "RECALL never takes your EMI").
- Placeholders: [Partner bank], [Warehouse address]. No invented durations or rules.
- Open: Prateek to approve batch 2a.
- **Next: batch 2b** — Screen care (P4.8), Help (P4.9), Alerts (P4.10), Profile and settings (P4.11), POC earnings with the 150-hour bonus (P4.5); then batch 3, admin.

## 22 Oct 2026 · P0.3.4 · Batch 1 approved by Prateek, with one change
- Prateek approved the 9 brand screens, with one correction: brands upload their own 15 s video or picture carousel; we run it if it passes the rule check; best practices only at the side. My batch-1 change (template only) was wrong; plan step P5.5 already said "template or own file".
- 5 · Your ads redrawn (canvas version 43): upload first (video, or 2–5 pictures as a carousel; 1280 × 640, no sound, ≤30 MB), each file shows its rule check (✓ ready / fix: too long, wrong shape / checking); template is an optional fold-out for brands with no ad (own colour on midnight, night-readability hint, "make another version"); 2–5 ads; best-practice list extended from the brand book.
- Records: DECISIONS (Prateek's upload rule; old row struck through), PRODUCT_V54 ads line amended, BUILD_PLAN P5.5 + change log 1.2, brand book Screen creative (only the must rules are checked for brand files; the rest is advice).
- Clock rule: 10 minutes everywhere (fixed earlier today in the brand book and code).
- **Next:** batch 2, rider app screens (fix "this hour sold ₹210", then the rest of P4's screens), for approval.

## 22 Oct 2026 · P0.3.4 · Screens redrawn for approval — batch 1: brand portal (in progress)
- The 9 brand screens were already in Night Signal on the design canvas (https://claude.ai/artifact/MsppEXdv7UShL6FjJBvNBQ). Checked each against rulebook v5.4, model v5.3 and the design system, and fixed what was wrong (canvas version 41):
  - 5 · Your ads: removed "upload your own video or image" (rulebook + brand book: every ad is made in RECALL's templates). Colour themes used volt, which the brand book keeps for RECALL's own ads, and two broke screen rules (a light field at night; 6.2:1 text). Now: the brand picks its own colour; layouts "your colour on midnight" and "paper on midnight with a colour band"; a live check refuses colours under 7:1 on midnight.
  - 4 · Book and 9 · Help: ₹220 band named Lite (decision 22 Oct), with its hours.
  - 7 · Report: people estimate as a ±15% range (2.0–2.8 lakh), as P1.8.3 says.
  - All brand screens: control borders #5B6272 → #606777.
- Checked and correct: prices and peak windows, 5-bike and ₹15,000 minimums, GST, 6/12-month offers, every invoice total, free week (rulebook allows it), make-up rule, ads due 7 days before.
- Design system: type sample corrected to "the clock pauses after 10 minutes standing still" (model's 10-minute stop rule; it said 5).
- Found for later batches: rider "Today" says "this hour sold ₹210" (share-hour leftover; v5.4 sells whole hours: ₹300 peak → ₹264 after cuts → rider ₹25 + ₹66). Admin "Live operations" still counts plays per brand per hour (5) and RECALL's 6th slot (pre-v5.4) and needs a redraw.
- Open: Prateek to approve batch 1 on the canvas.
- **Next:** batch 2 (rider app screens), then batch 3 (admin), each for approval.

## 22 Oct 2026 · P0.3.3 · Logo and app icons in the code
- The Night Signal logo was already finished in Cowork (decision: keep the Afterimage, recolour it). This step brings it into the code instead of redrawing: the 11 brand-book SVGs copied exactly to `packages/design/brand/logo/`.
- App icons for every platform generated from `recall-app-icon.svg` by `pnpm --filter @recall/design build` (`src/icons.ts`, renderer `@resvg/resvg-js`): browser tab, iPhone home screen, installed web app (incl. maskable), rider app (Expo 1024), Android adaptive foreground (symbol scaled 72/108 so it looks the same size and stays in the safe circle), Play Store 512. Guide: `packages/design/brand/README.md`.
- Tests: 25 new (111 in `packages/design`): logos use only volt/midnight/paper and load nothing; echo heights 78% / 56%; adaptive symbol inside the 66/108 safe circle; every PNG at its size; derived SVGs in sync.
- Open: none.
- **Next: P0.3.4** — redraw the 9 brand screens, then rider and admin screens, page by page, for Prateek's approval before code.

## 22 Oct 2026 · P0.3.2 · RECALL design system (components, chart and map colours)
- Found the RECALL brand book (design-system artifact made in Cowork) already set token names, an 8-point spacing scale, 12 type styles, corners 4/6/14/20/pill and a lift shadow. `packages/design/src/tokens.ts` now copies them exactly, with their usage notes (replaces the P0.3.1 4 px grid and 12–56 px sizes; DECISIONS). Code is the one source: `pnpm --filter @recall/design build` writes `tokens.css` and the design system's `tokens.json` + `bundle.css`.
- `components.css` (`rc-*` classes): button, field (input/select, help, error), status chip, filter chip, card, stat tile, table. `src/dataviz.ts`: chart series, map roles, heat-map ramp, all naming tokens.
- Design system https://claude.ai/artifact/BjjWMHaUHHX5o2VkTPMfWY updated (version 9): tokens from code (dark `line-strong` #606777, flag removed), component stylesheet, 6 new cards (TextField, FilterChip, Card, DataTable, ChartColours, MapStyle), Button/StatusChip/StatTile now use the shared styles, Colour section updated. Card sources live in `packages/design/design-system/`. How to change things: `docs/RUNBOOKS/design-system.md`.
- Tests: 86 in `packages/design` — every contrast promise (text, borders, chips, charts, maps), heat-map steps, tokens.css and tokens.json in sync, every card has a marker, a guideline and only real classes. All 9 cards rendered in Chromium, light and dark, desktop and 360 px phone: no errors, no sideways scroll.
- Open: in light, chart series 1 (olive) and 2 (blue) differ by hue, not lightness (1.1:1). Rule added: always name series on the chart. A colour change would fix it properly; for Prateek when charts are built (P1.9 reports).
- **Next: P0.3.3** — new logo mark and app icon in Night Signal.

## 22 Oct 2026 · P0.3.1 · Night Signal tokens as code
- P0.2 merged to `main` (PR #1, all checks green). SeaweedFS confirmed by Prateek.
- `packages/design`: core colours, light/dark theme tokens exactly as `docs/NIGHT_SIGNAL.md`, fonts (Anek Latin/Telugu/Devanagari, IBM Plex Mono) and Google Fonts link, font roles, text sizes, 4 px spacing, corners 6/14/20/pill, 1 px lines. `tokens.css` generated for the web portals (`pnpm --filter @recall/design build`); light by default, dark from the system setting or `data-theme="dark"`.
- Tests: 41 — every contrast promise in NIGHT_SIGNAL.md, same tokens in both themes, no Inter/Space Grotesk, corners, 4 px grid, `tokens.css` up to date.
- Prateek's answers: dark control border changed #5B6272 → #606777 (now ≥3 : 1 on every surface, both themes; also in NIGHT_SIGNAL.md); spacing and text sizes confirmed; Claude merges its own PRs once checks are green.
- Open: none.
- **Next: P0.3.2** — RECALL design system (buttons, inputs, chips, tables, cards, map styles, chart colours).

## 22 Oct 2026 · P0.2 · Repository, automatic checks, record files (Claude Code)
Branch `claude/festive-meitner-kb0teg`, draft PR https://github.com/Picorus/recall-platform/pull/1. One commit per part:
- **P0.2.1** Monorepo: pnpm 10 + Turborepo; every folder from the plan with a placeholder package (`apps/player` is Kotlin, outside the workspace).
- **P0.2.2** Checks: strict TypeScript 6.0, ESLint, Prettier (code only; `.md` files left as written), Vitest, fast-check. `packages/domain`: money in whole paise (`parseRupees`, `formatRupees` with Indian grouping) and India time / `businessDayOf` (08:00–02:00; 23:00–02:00 counts for the day it started). `tools/repo-checks`: secret patterns, `.env.example` names-only rule, commit-message rule.
- **P0.2.3** Laptop services: `pnpm services:up` / `services:check` / `services:down` — Postgres 16.15 + PostGIS 3.6 + TimescaleDB 2.31 + H3 4.2, Redis 7.4, EMQX 5.8, SeaweedFS 4.48 (S3 stand-in; MinIO no longer ships a free image).
- **P0.2.4** CI (GitHub Actions): format/lint/types/tests, laptop services start, gitleaks over full history, step-id commit messages. All 4 green on GitHub.
- **P0.2.5** Records: `docs/ARCHITECTURE.md`, `docs/RUNBOOKS/` (laptop set-up), README, 5 decisions.
- Review by a second agent found 6 defects, all fixed with tests: test cache hid the secret scan on laptops; `parseRupees` accepted mis-grouped amounts ("1,50,00" read as ₹15,000); `.env.example` rule could be bypassed; services check failed on macOS; quick pushes to main could skip the commit check; force-push broke it. Plus nits (mid-sum overflow, fake "Merge" subjects, Node ≥22.18).
- Tests: 49 domain tests (2 property tests, thousands of random cases each), 26 repo-check tests; planted secrets, bad commit names and a missing DB extension each proven to fail.
- Open: Prateek to confirm SeaweedFS instead of MinIO. Docker Hub rate-limits the cloud sandbox; images were pulled via mirror.gcr.io here (not needed on a laptop or in CI).
- **Next: P0.3.1** — Night Signal colours, type, spacing and corners as code tokens in `packages/design` (light and dark).

## 22 Oct 2026 · P0.1 · Build plan done (Cowork)
- Wrote docs/BUILD_PLAN.md (copy of the "RECALL Build Plan" doc in Claude), CLAUDE.md, DECISIONS.md.
- Night Signal colours applied to the design system, investor deck and design canvas (outside this repo).
- Tests: none yet (no code).
- Open: GitHub repo created by Prateek; company accounts (AWS, payments, WhatsApp, KYC) come after incorporation; screen vendor sample unit needed before P2.9.
- **Next: P0.2** — set up the monorepo (pnpm + Turborepo), lint/format/test tooling, CI on GitHub Actions, `.env.example`, docker-compose for Postgres+PostGIS+Timescale, Redis, EMQX; then P0.3.1 design tokens in `packages/design`; then P1.10 simulator skeleton and P1.1 areas.
