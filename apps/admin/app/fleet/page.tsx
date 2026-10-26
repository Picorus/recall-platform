// P3.3 Fleet map. The base map style comes from the server's settings at request time
// (ADMIN_MAP_STYLE_URL, an open map style); without one the map shows our areas and bikes on a plain
// ground, so it works on a laptop with no keys or network (hard rule 4).
import FleetMap from './fleet-map';

export default function FleetPage() {
  return <FleetMap styleUrl={process.env.ADMIN_MAP_STYLE_URL ?? ''} />;
}
