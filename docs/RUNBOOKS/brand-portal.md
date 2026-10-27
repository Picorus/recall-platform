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
- A GST number never blocks a second account (anyone can know a business's number). When two
  accounts carry one number, both show a red note on the admin Brands page: ask for the GST
  certificate, then close the wrong account or correct its tax details. Tax details a business typed
  (no GST record) show "not checked": check them before the first invoice.

## Campaigns and booking (P5.3–P5.4)

- After sign-in, a person with one business lands on its campaigns: Scheduled (and To pay), Running,
  Done. "Book" (or "Book again" on a campaign) opens the booking page.
- Booking: tap areas on the map, pick hours (or a ready-made pick), days, start date, weeks, bikes,
  and optionally a monthly repeat. The summary prices it live with the same rules as admin bookings.
  Continue saves it as "To pay"; it holds no bikes until it is paid (P5.6).
- Limits (most bikes each hour, most weeks, bookings a person may make a day) are in Settings →
  Brand portal limits; the minimum, lead days, bands and offers are in the price book.

## Your ads (P5.5)

- From a campaign, "Your ads": upload a 15-second MP4 or pictures (1280 × 640), each checked at once
  (size, shape, length); or make one from the template (logo, headline, offer, code, QR, colour,
  theme; "Make another version" changes the layout). Choose 2 to 5 for the campaign and save.
- Every ad is still reviewed by the Ad review team in the admin portal before it runs.
- Uploads per person per day: Settings → Brand portal limits.

## Review and pay (P5.6)

- From a campaign "To pay" (or after Book → Your ads): the booking line by line, GST, total and the
  five rules; tick the box and Pay. The brand goes to the payment provider's page; on a laptop the
  fake payment page does not exist (tests mark links paid themselves).
- The rules' words are `packages/domain/src/booking-terms.ts`; changing them means a new
  `TERMS_VERSION` (brands with a page open are asked to read them again).

## Final report (P5.7)

- When a campaign's report is built, "See the report" shows on it under Done; the "Done" message
  links to `/campaigns/<booking>/report` (signed out: sign in, then straight back to it).
- Download PDF and Share (on a phone the PDF goes to WhatsApp or any app). PDFs per person per
  hour: 30 (reports and invoices together).

## Invoices (P5.8)

- "Invoices" on the campaigns page: a year's tax invoices and credit notes; one or all as a PDF.
- RECALL's legal name, GSTIN and address: Settings → Company details on invoices (super admin).
  Until all three are filled in, every invoice PDF says it is not a valid tax invoice yet.
- A brand's GST number is held back from its invoice when it was typed (not checked) or is on two
  accounts. Money → GST summary lists those invoices: check the GST certificate, set the brand's
  tax details on its Brands page (staff-set numbers are printed), and correct an issued invoice
  with a credit note and a new invoice.

## Tests

- `pnpm --filter @recall/brand test`: the sign-in page's checks.
- `pnpm --filter @recall/brand build && pnpm --filter @recall/brand test:e2e`: the portal in
  Chromium against a real API and database (needs `DATABASE_URL`). `SCREENSHOT_DIR=/some/folder`
  saves screenshots.
