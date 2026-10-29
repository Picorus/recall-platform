// The base map style setting (BRAND_MAP_STYLE_URL, the same tile source as the admin map), read on
// the server: the map pages read it per request. Not browser code.

/** The style URL when it is a proper https address; anything else is ignored (plain map). */
export function styleUrlOf(value: string | undefined): string {
  try {
    const u = new URL(value ?? '');
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}
