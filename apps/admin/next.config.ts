// The admin site. It reaches the cloud only through the API: /api/... is passed to the API service
// (app/api/[...path]/route.ts), so the session cookie stays on this site (SameSite=Strict).
import type { NextConfig } from 'next';

const production = process.env.NODE_ENV === 'production';

const csp = [
  "default-src 'self'",
  // Next.js puts small inline scripts on each page; development also needs eval.
  `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@recall/design'],
  // The site's own code only; the tests (which reach into the API) are checked by `pnpm typecheck`.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Invite links carry their token: never pass the address on to another site.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(production
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
        ],
      },
    ];
  },
};

export default config;
