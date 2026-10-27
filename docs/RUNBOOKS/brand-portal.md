# Brand portal

The brand portal (`apps/brand`) is a Next.js site where brands and agencies book, pay, add their ads
and get their reports (P5). It reaches the API only through its own `/api/...` path, which goes to the
API's `/portal/...` routes and nothing else: a page on the portal can never reach a staff route.

## Run it on a laptop

1. Start the laptop services and the API (see [laptop-setup.md](laptop-setup.md)).
2. `pnpm --filter @recall/brand dev` opens the portal at http://localhost:3000 (the API takes its
   changes from this origin on a laptop; elsewhere set `BRAND_ORIGINS`, which production must name).
3. Sign in with any mobile number or email. On a laptop the API prints each message it would send on
   its console ("laptop message, not sent: whatsapp to +91…: sign_in_code: 123456"): read your code
   there. Nothing leaves the laptop.

## Sign-in (P5.1)

- A mobile number gets a 6-digit code on WhatsApp (or by SMS); an email address gets it by email
  (agencies mostly use email). A code works 10 minutes and 5 wrong tries; only the newest one counts.
- Limits (codes per number or email, per connection, per day, for everyone together; days before an
  unused session ends) are a setting: Settings → Brand portal limits (super admin).
- The session is a cookie scripts cannot read, sent only to the portal itself.
- A new number or email starts a new business (P5.2). To let someone from an existing brand or agency
  in, a Sales admin opens the account on the admin Brands page → Brand portal access → their number
  or email, Owner or Booker, why → Give access. Remove access the same way; it ends at once.

## Your business (P5.2)

- After signing in, a new person sets up their business: GST number → Find my business (the legal
  name, state and address come from the GST records), then the name shown on campaigns, brand or
  agency, kind of business, invoice email and WhatsApp number. No GST number: tick the box and type
  the legal name and state.
- On a laptop the GST lookup is a fake: any well-formed GSTIN is "found" as a test business; one
  whose PAN part starts ZZZZZ is not found, YYYYY is cancelled, XXXXX makes the service fail (then the
  details are typed). Production has no lookup until a GST provider is signed (P6, `GST_PROVIDER`).
- A GST number already with RECALL is refused: its owner adds the person (Brand portal access in the
  admin, or the team page in P5.9).

## Tests

- `pnpm --filter @recall/brand test`: the sign-in page's checks.
- `pnpm --filter @recall/brand build && pnpm --filter @recall/brand test:e2e`: the portal in
  Chromium against a real API and database (needs `DATABASE_URL`). `SCREENSHOT_DIR=/some/folder`
  saves screenshots.
