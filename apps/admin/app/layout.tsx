import { googleFontsUrl } from '@recall/design';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'RECALL admin',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Reading the request makes every page render per request, so each gets its own script code.
  await headers();
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href={googleFontsUrl} />
      </head>
      <body>{children}</body>
    </html>
  );
}
