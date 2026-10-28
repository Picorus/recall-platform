import { googleFontsUrl } from '@recall/design';
import type { Metadata } from 'next';
import { Pointer, THEME_COOKIE, themeAttr } from '@recall/web-ui';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'RECALL for brands',
  description: 'Book moving screens on bikes across Hyderabad, by the hour.',
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  // Reading the request makes every page render per request, so each gets its own script code.
  await headers();
  // Light, dark or the device's choice (P7.7.6), set on the page before it is drawn: no flash.
  const theme = themeAttr((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href={googleFontsUrl} />
      </head>
      <body>
        {children}
        <Pointer />
      </body>
    </html>
  );
}
