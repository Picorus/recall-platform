# Load test (P7.2)

Proves the cloud keeps up with the whole fleet: 15,500 screens each sending every 30 seconds, and
the Monday payout run for 15,500 riders. Each runs on its own fresh database (dropped afterwards).

## Screens

```sh
DATABASE_URL=postgres://recall:recall@localhost:5432/recall \
  pnpm --filter @recall/gateway load -- --screens 15500 --rounds 4
```

Each screen sends what it sends every 30 seconds (its position, the 2 plays it made, signed with
its own key, and every other time its minute summary) through the gateway's own handling, 16 at
once as one gateway does. It prints messages handled a second against the 517 a second that
15,500 screens send, how long each took, and how many were refused (must be 0).

On a laptop with Docker, connect to the database container's own address (`docker inspect
recall-db-1`), not localhost: Docker's port relay otherwise takes most of a core and halves the
result. `--at-once 32` tries more at a time; `LOAD_KEEP=1` keeps the database to look into.

## Payout run

```sh
DATABASE_URL=… npx tsx packages/db/test/load/payout-run.ts --riders 15500
```

Sets up the riders (each with a screen for the month and a checked UPI account), then times
preparing, approving and sending the Monday run through the fake payouts provider.

## Results so far (27 Oct 2026, one 4-core machine running everything)

| What | Result |
| --- | --- |
| Screens: 15,500 × 4 rounds, 62,000 messages, 124,000 plays | 506 a second with one gateway (517 arrive); half under 30 ms, 99% under 68 ms; none refused |
| Payout run, 15,500 riders | prepared in 66 s, all paid in 85 s, no problems |

**For the POC and launch:** run two gateways (the broker shares the screens between them) on
their own machine, and the database on at least 4 cores: about twice what the fleet needs.
