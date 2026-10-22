# Architecture

How RECALL is put together. The *why* behind each choice is in `docs/BUILD_PLAN.md` (Architecture section) and `docs/DECISIONS.md`. Update this file every phase.

Status: **P0.2** — the repository, checks and laptop services exist. No service has real code yet.

## The rule that shapes everything

The screen decides what to play on its own, from a plan the cloud sends ahead of time. It signs and logs every play, even with no signal, and uploads when it reconnects. Billing and reports only ever use those records (hard rules 1 and 7).

## Pieces

```
 Screen unit (Android, Kotlin)  ──MQTT over TLS──▶  Device gateway ─┐
        │ downloads ad files                                       │
        ▼                                                          ▼
 File storage (S3 + CDN)          Brand / Admin / Rider apps ──▶  API ──▶ PostgreSQL (PostGIS, TimescaleDB, H3)
                                                                   │            ▲
                                                                   ▼            │
                                                          Redis (BullMQ) ──▶ Scheduler · Ledger · Workers
```

| Folder | What it is | Built in |
|---|---|---|
| `apps/player` | Screen player (Android, Kotlin, Gradle — outside the pnpm workspace) | P2 |
| `apps/admin` | Admin portal (Next.js) | P3 |
| `apps/rider` | Rider app (React Native, Expo) | P4 |
| `apps/brand` | Brand portal (Next.js) | P5 |
| `services/api` | Every app's front door | P1 |
| `services/gateway` | Holds the MQTT line to every screen | P1 |
| `services/scheduler` | Hour plans, rebalancing, make-ups | P1 |
| `services/ledger` | Double-entry ledger in paise, invoices, rider pay, payouts | P1 |
| `services/workers` | Slow jobs: reports, heat maps, PDFs, messages | P1 |
| `packages/domain` | Shared rules and types (today: paise money, India time and business day) | P0.2 → P1 |
| `packages/design` | Night Signal tokens, chart/map colours and component styles: `@recall/design` (TypeScript), `tokens.css` + `components.css` (web). Also generates the RECALL design system's tokens and component cards (`docs/RUNBOOKS/design-system.md`), and holds the logo and every app icon (`brand/README.md`) | P0.3 |
| `packages/adapters` | Every outside service behind an adapter with a working fake (hard rule 4) | P1 → P6 |
| `tools/simulator` | Fleet simulator: fake bikes on Hyderabad roads | P1.10 |
| `tools/repo-checks` | Checks on the repository itself: secrets, `.env.example`, commit messages | P0.2 |
| `infra/` | `docker-compose.yml` for the laptop; cloud files later | P0.2 → P1 |

## Shared rules already in code (`packages/domain`)

- **Money** is a whole number of paise (`Paise`). `parseRupees` reads typed text without floats; `formatRupees` shows Indian grouping (₹1,23,456.78).
- **Time** is stored in UTC and shown in India time (UTC+05:30, no daylight saving). `businessDayOf` gives the business day: 08:00–02:00, with 23:00–02:00 counting for the day it started; 02:00–08:00 belongs to none. The hours are a parameter today and move to versioned settings in P1 (hard rule 8).

## Laptop services (`infra/docker-compose.yml`)

| Service | Image | Port | Use |
|---|---|---|---|
| `db` | `timescale/timescaledb-ha` (PostgreSQL 16.15, PostGIS 3.6, TimescaleDB 2.31, H3 4.2) | 5432 | Main database |
| `redis` | `redis` 7.4 | 6379 | Job queue (BullMQ) |
| `mqtt` | `emqx/emqx` 5.8 | 1883, dashboard 18083 | Line to the screens |
| `s3` | `chrislusf/seaweedfs` 4.48 | 8333 | S3-compatible file storage (stand-in for AWS S3) |

## Checks (`.github/workflows/ci.yml`)

Every pull request and every push to `main` runs:
1. Format, lint, type check and all tests (`pnpm check` locally).
2. The laptop services start and answer (`pnpm services:up && pnpm services:check`).
3. Gitleaks scans the full git history for secrets.
4. Every commit message starts with a step id (`P1.1.2: …`).
