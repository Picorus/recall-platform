// The base map style setting, read on the server (not browser code: the map pages read it per request).

/** The style URL when it is a proper https address; anything else is ignored (plain map). */
export function styleUrlOf(value: string | undefined): string {
  try {
    const u = new URL(value ?? '');
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}
