# Run RECALL on a laptop

Needs: Node 22.18 or newer (see `.nvmrc`), pnpm 10 (`corepack enable` sets it up from `package.json`), Docker with Compose. No keys needed (hard rule 4: every outside service has a fake).

```sh
pnpm install            # once
cp .env.example .env    # once; real keys are never needed on a laptop
pnpm services:up        # database, Redis, MQTT broker, file storage
pnpm services:check     # proves each one answers
pnpm check              # format, lint, type check, all tests
pnpm services:down      # stop (data is kept; add -v to the compose command to wipe it)
```

## If something goes wrong

- **Port already in use** (5432, 6379, 1883, 18083, 8333): another copy of Postgres/Redis is running. Stop it, or change the left-hand port in `infra/docker-compose.yml` on your machine only.
- **Database extensions missing** after changing `infra/db/init.sql`: the script runs only when the database is first created. Wipe and restart: `docker compose -f infra/docker-compose.yml down -v && pnpm services:up`.
- **Docker Hub "too many requests"**: log in with `docker login`, or wait an hour.
