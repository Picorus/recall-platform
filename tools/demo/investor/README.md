# Investor page: RECALL at scale

`index.html` is the page published for investors. It shows fake bikes on the real roads of west Hyderabad at 200, 2,000 and 15,500 bikes, with what each simulator run proved.

The bike pictures (`frames-<bikes>.json`, about 3 MB for 15,500 bikes) are not kept in git. To make them again:

```
pnpm --filter @recall/simulator frames -- --bikes 200   --out frames-200.json
pnpm --filter @recall/simulator frames -- --bikes 2000  --out frames-2000.json
pnpm --filter @recall/simulator frames -- --bikes 15500 --out frames-15500.json
```

Each run takes about 1 minute at most.

The numbers in the table (`RESULTS` in the page) come from two commands:
- `pnpm --filter @recall/simulator schedule -- --bikes <n>`
- `pnpm --filter @recall/simulator start -- --bikes <n> --minutes 60`

The load-test figures come from `docs/RUNBOOKS/load-test.md`.

Publish the page with the three frame files beside it.
