// P5.4 Book. The map's base style comes from the server's settings at request time
// (BRAND_MAP_STYLE_URL, the admin map's tile source); without one our areas show on plain ground.
import { styleUrlOf } from '../../lib/map-style';
import BookPage from './book-page';

export default function Book() {
  return <BookPage styleUrl={styleUrlOf(process.env.BRAND_MAP_STYLE_URL)} />;
}
