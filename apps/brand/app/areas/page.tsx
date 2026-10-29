// P5.4.1 Our areas: the areas we sell, on an animated map. The base map style comes from the
// server's settings at request time (BRAND_MAP_STYLE_URL, the admin map's tile source); without one
// the map shows our areas on plain ground.
import { styleUrlOf } from '../../lib/map-style';
import OurAreas from './our-areas';

export default function AreasPage() {
  return <OurAreas styleUrl={styleUrlOf(process.env.BRAND_MAP_STYLE_URL)} />;
}
