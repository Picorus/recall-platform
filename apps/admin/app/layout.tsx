import { googleFontsUrl } from '@recall/design';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'RECALL admin',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href={googleFontsUrl} />
      </head>
      <body>{children}</body>
    </html>
  );
}
