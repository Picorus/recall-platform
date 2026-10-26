// Content rules (CSP) for every page, with a fresh random code (nonce) each time: only scripts the
// site itself put on the page, carrying that code, may run. Injected scripts cannot, so they cannot
// act as the signed-in member.
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
    `connect-src 'self'${map}`,
    // The map draws in workers it makes from blobs.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
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
 * Where the base map style and its tiles come from (P3.3): the origins in ADMIN_MAP_ORIGINS, else
 * the origin of ADMIN_MAP_STYLE_URL. Empty: the plain map, nothing from outside.
 */
function mapOrigins(): string {
  const listed = (process.env.ADMIN_MAP_ORIGINS ?? '').split(',').map((x) => x.trim());
  const style = process.env.ADMIN_MAP_STYLE_URL ?? '';
  const all = [...listed, ...(style ? [new URL(style).origin] : [])].filter((x) =>
    /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x),
  );
  return [...new Set(all)].map((x) => ` ${x}`).join('');
}

export const config = {
  matcher: [{ source: '/((?!api|_next/static|_next/image|favicon.ico).*)' }],
};
