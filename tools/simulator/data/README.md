# Simulator road map

`west-hyderabad-roads.json.gz`: the roads a delivery bike uses in west Hyderabad (Gachibowli to Banjara Hills, 17.38–17.50 N, 78.31–78.48 E), as points and the road pieces between them. Only the largest connected part is kept, so every trip has a way.

- Source: OpenStreetMap, through the Overpass API.
- Licence: © OpenStreetMap contributors, [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). Used only to test the platform; not shown to brands.
- Refresh: run the GitHub job "OSM roads" (Actions tab → OSM roads → Run workflow), or on a laptop: `pnpm --filter @recall/simulator exec tsx scripts/fetch-osm-roads.ts`.
