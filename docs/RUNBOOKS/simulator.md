# Run the fleet simulator

The simulator (P1.10) rides fake bikes over west Hyderabad and runs them through the real screen logic and the real upload path. It answers: does the moving-hour clock count right, does each screen pick the right area, and does every report reach the cloud exactly once?

## Run it

```sh
pnpm --filter @recall/simulator start -- --scenario normal --bikes 200 --minutes 60 --seed 1
```

- `--scenario`: `normal`, `rain` (60% of bikes out, slower, worse GPS), `cricket` (half the trips go to the Gachibowli stadium), `outage` (no network from minute 20 to minute 50).
- `--bikes`, `--minutes`: fleet size and length. 1,000 bikes for 30 minutes takes about 20 seconds on a laptop.
- `--seed`: the same seed always gives the same run.
- `--roads`: `osm` (default: the real OpenStreetMap roads of west Hyderabad, from `tools/simulator/data/`) or `grid` (version 1, streets every 250 m). Without the road file, `osm` falls back to the grid.

## Read the result

| Line | Good looks like |
|---|---|
| Moving-hour clock | 95–100% of the true time, never above (the clock waits about 10 s to be sure a bike has started, so it is slightly cautious) |
| Area agreement | Above 95% (the 15-second hold makes the screen a little late when a bike crosses a border) |
| Reports | "stored once" equals "made"; "lost" is 0. "Sent again" is normal after a lost reply or an outage |
| Odd minutes | A few; a person looks at them in the daily check |

## The road map

The real roads (about 1,14,000 road points) live in `tools/simulator/data/west-hyderabad-roads.json.gz`, © OpenStreetMap contributors (ODbL). To refresh them: GitHub → Actions → **OSM roads** → Run workflow; it downloads the roads and commits the file. The cloud sandboxes cannot reach OpenStreetMap, GitHub can.

Bikes take the shortest way by road, stop at signals only where roads meet, and start and end trips at real road points.

## Limits (version 2)

- One-way streets are ignored (two-wheelers often ride both ways in practice).
- Trips go anywhere in the box, evenly by road points; real delivery bikes crowd around restaurants and dark stores. Tune with POC rides.
- The scheduler proofs (P1.4.7) run on the grid, a fixed even world; the real roads have their own runs.
