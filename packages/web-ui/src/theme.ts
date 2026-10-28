// The theme cookie, readable on the server (a page's <html data-theme> is set before it is drawn).
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_COOKIE = 'recall-theme';

/** What the page's <html data-theme> should be for a cookie value (none: follow the device). */
export function themeAttr(cookie: string | undefined): 'light' | 'dark' | undefined {
  return cookie === 'light' || cookie === 'dark' ? cookie : undefined;
}
