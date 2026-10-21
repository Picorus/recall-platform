# RECALL platform

Moving LED screens on two-wheelers in Hyderabad, sold to brands by the bike-hour.

This repository holds everything: the screen player (Android), the cloud services, the rider app, the brand portal and the admin portal.

## Run it on a laptop

Needs Node 22.18+, pnpm 10 and Docker. No keys.

```sh
pnpm install
pnpm services:up      # database, Redis, MQTT broker, file storage
pnpm check            # format, lint, type check, all tests
```

Details and troubleshooting: `docs/RUNBOOKS/laptop-setup.md`.

## Where things are

- The plan: `docs/BUILD_PLAN.md`
- How it fits together: `docs/ARCHITECTURE.md`
- How Claude works here: `CLAUDE.md`
- What was done and what is next: `docs/WORKLOG.md`
- Decisions: `docs/DECISIONS.md`
- How-to guides: `docs/RUNBOOKS/`

Status: P0.2 done; P0.3.1 design tokens in review. Next: P0.3.2 design system.
