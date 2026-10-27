# Security: what to do, and what is in place

From the security review (P7.1, 28 Oct 2026). Four reviews: staff sign-in and roles; brand and rider data; screens and signed plays; the websites, secrets and outside services. Nobody found a way to forge a play, read another account's data, or take over an account.

## A screen is lost or stolen

1. Admin → Screens → find the screen → **Report lost or stolen**. Needs an Operations admin.
2. Say how many hours ago it went missing (0 = now, at most 7 days back), and what happened (at least 5 characters).
3. One step does all of it, logged with who and why:
   - nothing it shows from that moment on counts, for any brand or rider;
   - its line to us closes at once (its certificate is revoked);
   - it comes off its bike and rider.
4. Plays from before that moment still count, but only those that reached us before you pressed the button.

It cannot be undone. A screen found again is enrolled as a new screen.

A retired screen (Screens → Retire for good) gets 7 days to send in what it still holds, then can no longer connect.

## Limits that protect sign-in and uploads

| What | Limit |
|---|---|
| Sign-in codes (brands, riders) | Per number or email, per connection, per day (Settings). An IPv6 /48 gets 5 times one connection's limit. The shared hourly brake counts only codes sent to numbers and emails with no account, so a flood can never stop real people signing in. Past it, a number or email with no account gets the usual answer but no code, so the answer never shows whether an account exists. |
| Staff sign-in | 5 wrong tries per email and connection, then 15 minutes. 30 wrong tries per connection, 150 per IPv6 /48. 10 wrong two-step codes stop the account until a reset. |
| Staff password checks | 4 at a time, 100 waiting; 2 places per connection, 20 per IPv6 /48. |
| Brand ad uploads | 4 at a time, one per business. Any upload slower than 8 KB a second after 10 seconds is stopped. |
| Screen messages at the gateway | 8 waiting per screen, 10,000 and 256 MB in all. Reports more than 5,000 numbers ahead of a gap are left for later. |
| Plays | Count only for an ad the booking runs (its final choice), inside its area and hour, signed by a key of that screen that was not given up. |

## Before going live (P6 and the POC)

- **Screen certificates last 2 years.** Renewal is not built yet. Plan it before the first ones run out (the oldest from the POC, about mid-2029).
- **Check that each screen's keys were made inside its secure chip** (Android key attestation) when it is enrolled, before using the real certificate authority. Until then, enrolment is trusted to the warehouse staff.
- **Payment and payout callbacks.** The real providers (P6) must also check the time on each callback (refuse anything older than 5 minutes), not only its signature.
- **The API key.** Set `STAFF_SECRET_KEY` to 32 random bytes on every server. The API refuses to start with the laptop key anywhere it can be reached from another machine.
- **Updates.** Run `pnpm audit --prod` before each release and fix anything critical or high in code that ships (Next.js was updated to 16.4.1 for this).

## Accepted, not changed

- **One screen's plays are not capped per line below the spot rule** (one play per 15 seconds, at most 240 an hour). A cap at the plays per bike-hour (200) would change refunds when other bikes are short. That is a pricing decision for Prateek, not a security fix. Forged plays need a tampered box, and its plays still count only for its own booking's ads, inside the area and hour.
- **Plays from a screen in stock (not fitted) still count** if it is driven through a sold area-hour with the booking's ads. That needs an insider with a box. No rider is paid for them. Revisit when the fleet is live.
- **The GSTIN on invoices** is taken from the GST records, and anyone can type a public GSTIN. This was Prateek's decision on 27 Oct 2026. Still waiting on the accountant's OK.
