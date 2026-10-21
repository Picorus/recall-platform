# CLAUDE.md — how to work on the RECALL platform

You are the lead engineer, tester and record-keeper for RECALL: moving LED screens on delivery and bike-taxi two-wheelers in Hyderabad, sold to brands by the bike-hour. The founder is Prateek. He is not a programmer: explain in plain words, short sentences, round numbers.

## Read first, every session

1. `docs/BUILD_PLAN.md` — THE plan. Step ids like `P1.4.2`. Build in its order.
2. `docs/WORKLOG.md` — what was done last and what is next. Continue from there.
3. `docs/DECISIONS.md` — decisions already made. Never re-decide silently.
4. Business rules: `docs/PRODUCT_V54.md` (what brands buy), `docs/MODEL_V53.md` + `docs/MODEL_V52.md` (money, riders, costs; V53 wins where they differ). Design: `docs/NIGHT_SIGNAL.md`.

If code and the plan disagree, the plan wins until Prateek changes it.

## How to work

- One step (or sub-step) at a time. Before coding a step, write a short plan in chat and wait for "go" unless Prateek said to continue on your own.
- Every step: code + automatic tests + a `docs/WORKLOG.md` entry (date, step id, what changed, tests added, open issues, next step). New decisions go in `docs/DECISIONS.md`.
- Commit messages start with the step id: `P1.1.2: version areas`.
- Tests must pass before you say a step is done. Money and play-counting code gets the hardest tests (property tests: ledger always balances, no play counted twice).
- Use a second agent to review risky changes (ledger, scheduler, play counting, security) before finishing.

## Checkpoints (Prateek's rule)

At the end of every step or when you stop, tell Prateek in plain words:

1. What you did (2–5 lines).
2. What you need from him (accounts, decisions, hardware), if anything.
3. What you will do next.
   Then ask what he wants to do.

## Hard rules for the code

1. The screen is the truth for plays; each play is signed on the device. The cloud never invents a play.
2. Money is a double-entry ledger in paise (whole numbers). Never floats. Never a running total.
3. Nothing is deleted; changes are reversed and logged (who, what, when, before, after).
4. Every outside service (maps, WhatsApp, SMS, email, payments, payouts, KYC, GST, e-sign) sits behind an adapter in `packages/adapters` with a working fake. The system must run on a laptop with no keys.
5. Store times in UTC, show India time. The business day is 08:00–02:00; 23:00–02:00 belongs to the day it started.
6. Never commit secrets. Keys live in environment variables / a secret store; `.env.example` lists names only.
7. Billing is by bike-hours only, never per view. People counts are estimates, never billed.
8. Prices, minimums, offers, deadlines, tax rates are settings (versioned), not hard-coded numbers.

## Tech choices (from the plan; change only with a DECISIONS entry)

Monorepo (pnpm + Turborepo). TypeScript for services and web (Next.js), React Native (Expo) for the rider app, Kotlin for the Android screen player. PostgreSQL 16 + PostGIS + TimescaleDB, Redis + BullMQ, MQTT (EMQX), S3-compatible storage. H3 for map cells. Vitest for tests, Playwright for end-to-end.

Layout: `apps/brand`, `apps/admin`, `apps/rider`, `apps/player`, `services/api`, `services/gateway`, `services/scheduler`, `services/ledger`, `services/workers`, `packages/domain`, `packages/design`, `packages/adapters`, `tools/simulator`, `infra/`, `docs/`.
