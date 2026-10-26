// P3.5 Areas. The base map style comes from the server's settings at request time (see the fleet
// map); without one the map shows our areas on plain ground.
import { styleUrlOf } from '../../lib/map-style';
import AreasEditor from './areas-editor';

export default function AreasPage() {
  return <AreasEditor styleUrl={styleUrlOf(process.env.ADMIN_MAP_STYLE_URL)} />;
}
