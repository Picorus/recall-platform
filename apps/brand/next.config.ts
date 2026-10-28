// The brand portal. It reaches the cloud only through the API: /api/... is passed to the API's
// /portal/... routes (app/api/[...path]/route.ts), so the session cookie stays on this site
// (SameSite=Strict) and no page here can reach a staff route. The content rules (CSP), with a
// fresh script code for each page, are set in proxy.ts.
import type { NextConfig } from 'next';

const production = process.env.NODE_ENV === 'production';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No page uses next/image: its image service stays off (P7.1).
  images: { unoptimized: true },
  transpilePackages: ['@recall/design', '@recall/web-ui'],
  // The site's own code only; the tests (which reach into the API) are checked by `pnpm typecheck`.
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
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
