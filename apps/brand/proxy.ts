// Content rules (CSP) for every page, with a fresh random code (nonce) each time: only scripts the
// site itself put on the page, carrying that code, may run. Injected scripts cannot, so they cannot
// act as the signed-in brand.
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === 'development';
  const map = mapOrigins();
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: blob:${map}`,
    "media-src 'self' blob:",
    `connect-src 'self'${map}`,
    // P5.4.1: our areas map's worker comes from this site (copied at build), as on the admin site.
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

/**
 * Where the base map style and its tiles come from (P5.4.1): the same tile source as the admin
 * site, set here as BRAND_MAP_STYLE_URL (its origin is allowed) and BRAND_MAP_ORIGINS (the tile,
 * font and icon hosts when they differ). Empty: the plain map, nothing from outside.
 */
function mapOrigins(): string {
  const listed = (process.env.BRAND_MAP_ORIGINS ?? '').split(',').map((x) => x.trim());
  const style = process.env.BRAND_MAP_STYLE_URL ?? '';
  let own: string[] = [];
  try {
    own = style ? [new URL(style).origin] : [];
  } catch {
    // A mistyped setting must never take the whole site down: the map is just plain.
  }
  const all = [...listed, ...own].filter((x) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x));
  return [...new Set(all)].map((x) => ` ${x}`).join('');
}

export const config = {
  matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)' }],
};
