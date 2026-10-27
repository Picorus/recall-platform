# Work log

Newest first. Each entry: date · step id · what changed · tests · open issues · next.

## 27 Oct 2026 · P4.5 · Rider app: Earnings
- **Earnings page** (`packages/db/src/rider-earnings.ts`, route `GET /rider/earnings?month=`): a month at a time (this month first, up to 12 back from his first screen). The total before tax and its parts: moving hours × ₹25 (capped at 260 a month), the test-period daily pay, his share of sales as of the pay run's last update (with its date), and bonuses given. Each week (Monday to Sunday) and each day with hours. In the POC: his hours toward the founding bonus (a bar to 150; it starts at 100) and what it comes to so far. A closed month shows what the pay run posted, never a late upload it did not pay. The days come from the same code as Today, so the two pages always agree.
- **What each pay posting was made of** (migration 0050, `rider_pay_lines`): the ledger keeps only amounts; each time the pay run posts a change for a rider and month, the month's parts (hours, POC base, hourly, sales share, total, TDS) are kept beside that entry, never changed.
- **Monthly statement**: "Download my statement" opens a printable page in the phone's browser (save as PDF) through a signed link that works for 15 minutes, his and that month only; a changed link is refused. In English (a document for a bank or the tax office).
- **App**: tabs at the bottom for a rider on the road (Today, Earnings); month chips; every word in Telugu, Hindi and English.
- **Prateek's questions, recorded**: "delete my account" for riders is added to P4.11 in the plan (Google Play also requires it): the request is logged, staff settle the screen, money and loan, then his personal details are erased or blanked; only pay and tax records the law requires stay, for the time open question 18 sets.
- Tests: database 2 (a month so far, its weeks, a pay update's parts kept and never deleted, a closed month as posted, a late upload not shown, his months; the POC base and bonus progress); API 1 (the routes, a month not his refused, the statement link and page, a changed link refused); browser 1 (Earnings tab, the statement opens in a new page); the pay-run tests still pass with the new parts table.
- **Second review, fixed with tests:** a closed month the pay run never posted for (or one before this change) showed today's figures, a late upload included; a closed month's days could add up to more than its total; a founding bonus already given could show a figure worked out again later. Now a closed month's total is what the pay run posted (the ledger), with one line "adjusted as paid" so the days, parts and total always add up; a given bonus shows what was given. The hours line shows the hours paid (up to the cap). A pay-run retry never fails on the parts table. The statement link refuses any changed or odd token; the statement page runs no script at all.
- Next: P4.6, Payouts.

## 27 Oct 2026 · P4.4 · Rider app: Today
- PR #68 (fitting) merged with all checks green.
- **Today page** (`packages/db/src/rider-today.ts`, rules in `packages/domain/src/rider-today.ts`, route `GET /rider/today`): for a rider on the road (riding or paused). His screen now: "On and playing", "On. Bike stopped" or "Off or no signal", with battery (and charging) and signal bars. His counted moving hours today and this week (Monday to today), counted exactly as his pay counts them: minutes of the screens he rode while he rode them, inside the pay zone and business hours. What they earned before tax, by the same rules as the pay run: ₹25 a moving hour in regular business (the same paise, a test holds it), or in the test period (POC) the month's base for each day he had a screen. His sales share comes later and the 260-hour monthly cap applies over the month: the page says so. A reminder of the 10-minute stop rule. The page looks again every minute.
- **App**: the Today screen (in Telugu, Hindi and English) replaces the plain status page for riders on the road; riders who left or were turned down still see the plain page.
- Tests: domain 3 (hourly pay identical to the pay run for many lengths, POC days add up to the month's base, nothing before the POC or on a day without a screen, signal bars, days of a week); database 3 (only the hours while he rode, last week left out, a Monday 01:00 still Sunday's, another rider's day; the screen moving with battery and signal, then off; POC days); API 1 (the route); browser 1 (a rider on the road sees "On and playing", 1 h 30 min and ₹37.50 today and this week).
- **Second review, fixed with tests:** the page could show more than the pay run gives: past the 260-hour month cap it still showed ₹25 an hour, it priced every day by today's price book (the pay run uses the one in force when each month starts), and it rounded each day (seven days of one second showed 7 paise, the month pays 5). Now each day earns what the month's running pay grew by that day, by that month's rules, capped and rounded as the pay run does: a property test over hundreds of random months proves the days add up exactly to the pay run's figure. With no price book in force nothing is shown as earned. Lighter queries for the screen on his bike (the rider app asks every minute). A slow answer never overwrites a newer one; after a failed refresh the page says when it was last updated; a rider in an unexpected state gets the plain page, never a blank one.
- Open: in the first two days of a month, last month's days of this week can still show a late upload the closed month will not pay (rare; P4.5's month view will show the paid figure for closed months).
- Next: P4.5, Earnings (day, week and month; the POC's progress to 150 hours; monthly statement).

## 27 Oct 2026 · P4.3 · Rider app: fitting
- PR #67 (joining) merged with all checks green.
- **Booking** (`packages/db/src/rider-app-fitting.ts`, routes `/rider/fitting*` in `services/api/src/rider-app-api.ts`): once approved, the app shows the fitting times open at centres that are on (Settings), with the address and places left (never who else is booked). He books one, changes it or cancels it; the same booking rules as staff (P3.11.3).
- **Fitting at his slot**: the technician uses the rider's phone, scans the QR code on the screen box (or types the id printed under it), and the screen goes on his bike and on him by the same rules staff use (enrolled, certificate good, not lost, not in repair, his own number plate, one screen per bike). The app fits only from 30 minutes before his slot to 2 hours after it ends (settings), so a QR seen elsewhere is no use, and at most 20 tries an hour.
- **The fitting check** (P2.14): the technician taps "Start the fitting check"; the screen lights up every part and checks its location, 4G, camera and battery; the app shows each part as it comes in and asks "Did every part of the screen light up?" (migration 0049 keeps that answer, once per check, with who, in the audit log). Ready only when every part passed and the lights were seen; a box that never answers counts as "no answer", never as passed. At most 10 checks a day per rider (setting). Staff see the latest check on the admin rider page and then switch him on (riding), as before.
- Settings saved before a new limit existed now get it at its default (no limit is ever missing).
- **App**: the Fitting screen (times, your fitting, at the centre: scan or type, the check with each part, Yes/No for the lights, ready), the camera QR scanner (expo-camera), every word in Telugu, Hindi and English.
- Tests: database 3 (book at a centre that is on, full and switched-off refused, fit only at his slot, the typed id, one screen per bike, the check and the lights making it ready, answered once, his own screen only, a box that never answers, a failed part, a few checks a day, cancel and book again, old settings get new limits); API 1 (the routes over HTTP); browser 1 (an approved rider books, a wrong code refused, the screen fitted by its typed id, the check started, the lights answered, the box's report arrives and the app shows "Ready" by itself).
- **Second review, fixed with tests:** a check from before a screen was taken off and fitted again (another bike or rider) could show the new fitting as ready: now only checks since this fitting count, for the rider, the admin page and the daily limit. A booking could vanish once more than 200 slots had been opened: slots are now looked up by their id. Two taps at once could start two checks: one at a time per screen; a check the box refused no longer counts as running. A refused scan jammed the camera: it closes and starts afresh. A screen on someone else's bike no longer shows that bike's plate to the technician. The lights question is answered only for a check of this fitting, while it runs or just after. An old error clears once the app loads again; a booked rider's screen opens the fitting by itself when his time comes.
- **Open, for Prateek:** the app cannot yet prove the technician holds the screen: anyone who saw a box's id could, at his own slot, link it to his bike. Until the screen shows a short code on its panel during fitting (a small change to the screen player, P2), staff must confirm with the technician before switching a rider on (runbook). Also open: staff ending a rider's sessions and giving a fresh allowance of codes (admin rider page); the real QR scan needs a phone (the browser test types the id).
- Next: P4.4, Today (screen status, moving hours and earnings today and this week, the 10-minute stop rule).

## 27 Oct 2026 · P4.2 · Rider app: joining RECALL
- PR #66 (rider sign-in) merged with all checks green, its browser test running in CI.
- **Sign-up** (migration 0048, `packages/db/src/rider-app.ts`): a new number gives his name, where he rides and the apps he rides for; his record is made ("rider app", applied) and his signed-in session now opens it. If staff had already added him at the warehouse, his session finds that record instead (no second one). Once only; the phone is always the one he signed in with.
- **The six steps** (approved screen R02), each with where it stands for him (to do, checking, done, do again): 1 profile and photo, 2 number plate, RC and insurance photos, 3 ID check (the provider's DigiLocker page opens; back in the app he says he has finished and the app asks the provider), 4 bank or UPI checked with ₹1 in his own name, 5 the agreement with the camera line ("This screen counts people. It records nothing."), signed on the provider's page, 6 the screen loan from the bank in Settings (the bank's form comes when Dhanlaxmi gives its link, open question 20). The states come from the same approval checklist staff use, so the app and the admin portal never disagree. He can change things while his application is open; once decided, the app shows it and sends him to support.
- **Server** (`services/api/src/rider-app-api.ts`): `/rider/join`, `/rider/profile`, `/rider/documents` (a picture, at most 10 MB, checked by its first bytes), `/rider/identity`, `/rider/agreement`, `/rider/bank`, `/rider/checks`: always his own record, from his session; staff review his papers in the admin portal as before.
- **App**: sign-up form, the steps list and each step's screen; pictures from the camera or gallery (expo-image-picker); every word in Telugu, Hindi and English.
- Tests: database 5 (sign-up and his session, a walk-in found by his number, every step from to do to done, details only while open, a number given out again, the check limits and the hidden bank name); API 1 (the routes, his own record only, a PDF refused as a photo, a waiting check opened again, the bank's name never told, closed once decided); browser 1 (a new rider signs up and goes through all six steps with his photos, plate, ID, UPI and agreement) and the sign-in tests updated (an applying rider now lands on his steps).
- **Second review, fixed with tests:** each ID, agreement or bank check costs RECALL money, and a bank check told whose name an account was in: now a check still waiting opens again (never a second one paid for), at most 3 of each a day per rider and 500 a day for everyone (Settings → Rider app limits), and the app is only told "the name on the account is not yours" (staff still see the bank's name). Pictures from the app have their own upload slots (a slow phone never holds up staff), one at a time per rider and 20 a day. A number the phone company gave out again no longer opens the old rider's record: sign-in finds only riders still with RECALL, and the new owner signs up afresh. Joining from the app shows in the audit log. "Do again" always says why; "Open it again" when the provider's page was closed too soon; a picture waiting for a look can be replaced; a session ended elsewhere goes back to sign-in.
- Open: the bank's loan hand-off (20); staff ending a rider's sessions and giving a fresh allowance of codes (admin rider page, with P4.3); the Telugu and Hindi words to be checked (22).
- Next: P4.3, fitting (book a slot, scan the screen's QR, the fitting check).

## 27 Oct 2026 · P4.1 · Rider app: language and sign-in
- PR #65 (settings) merged with all checks green; the admin portal (P3) is done.
- **Open questions recorded** (Prateek will answer later): providers for messages, maps, KYC, e-sign, bank check, payments and payouts (16, 17), how long rider records are kept (18), the lawyer's agreement text (19), the bank's loan hand-off (20), a Play Store account (21), someone to check the Telugu and Hindi words (22), the WhatsApp sign-in template and SMS registration (23). The plan's progress table brought up to date.
- **Sign-in, server side** (migration 0047, `packages/db/src/rider-sign-in.ts`, rules in `packages/domain/src/rider-sign-in.ts`, routes in `services/api/src/rider-app-api.ts`): a code on WhatsApp or by SMS in his language; it works 10 minutes and 5 wrong tries, only the newest counts; limits per number (3 in 15 minutes from one connection, 20 a day, 15 wrong a day), per connection (30 codes, 50 wrong tries an hour) and for everyone (2,000 an hour). Codes and tokens are kept only as fingerprints. A session lasts until he signs out (or staff end it, or 90 days unused); its end is in the audit log. A new number signs in the same way and starts the sign-up. Errors come with a fixed reason code so the app says them in his language. The messages adapter can now send SMS and pick a WhatsApp template's language. On a laptop the API prints each message it would send on its console, so a person trying the app can read the code.
- **The rider app** (`apps/rider`, Expo SDK 58): language picker (Telugu, Hindi, English, kept on the phone), mobile number, code on WhatsApp or SMS, the code screen (wrong tries left, a new code after 30 seconds, change number), then signed in: a known rider sees his name and where his application stands; a new number is welcomed to the sign-up (its steps are P4.2). Stays signed in after the app is closed (token in the phone's secure store); sign out. The approved R01 design, in Night Signal, with the Anek fonts bundled so Telugu shows correctly on any phone.
- Tests: domain via the app's words test (every word in all three languages, in its own script, same blanks); database 6 (a code and its language, right once, nothing in clear, wrong tries counting down, the newest code only, expiry, limits per number, per day and per connection, a failed send, sessions idle and signed out, nothing edited); API 2 (the routes, bearer only, the web build's origin only, 429 with its reason); app unit 3; browser 2 (a known rider signs in by WhatsApp after a wrong code, stays signed in after a reload, no signal shows "Try again", signs out; a new number by SMS in Hindi). CI runs the app's browser test.
- **Second review, fixed with tests:** a session followed the phone number, so a recycled SIM (common in India) or a staff fix to a number could hand an old session to a different rider: now a session belongs to the rider who signed in, and ends when that rider's number changes; a number shared over time prefers the rider still with RECALL. A stranger asking for a rider's codes could lock him out for the day: the 15-minute limit now counts per number and connection, the day's limit is 20 from anywhere. Slow guessing across many connections: at most 15 wrong codes per number a day. Weak signal when the app opened sent the rider back to sign in (costing a new code): now "Try again", still signed in. A provider that never answers counts as not sent after 10 seconds, and a code that failed to go never replaces one that did. A brake on codes for everyone together (2,000 an hour) against message-cost abuse. Two connections' checks are locked in one order. The limits are now a setting a super admin changes (Settings → Rider sign-in limits; hard rule 8).
- Open: staff ending a rider's sessions from the admin rider page, and giving a rider a fresh allowance of codes (with P4.2's admin changes); an alert when a number hits its daily limit (P7); the real WhatsApp/SMS provider (P6).
- Next: P4.2, joining (profile, vehicle papers, ID check, bank or UPI, agreement, screen loan).

## 27 Oct 2026 · P3.17 · Settings
- PR #64 (audit log) merged with all checks green.
- **Settings store** (migration 0046, `packages/db/src/settings.ts`, rules in `packages/domain/src/settings.ts`): one row per saved version of one setting, with who and why; the newest is in force, the starting values until one is saved. Append-only, versions 1, 2, 3… with no gaps. A save from an old screen (someone saved meanwhile) is refused: reload. The audit log now has a "settings" part.
- **Settings page** (everyone sees it; a super admin changes it): staff and roles (what each role may do; members on the Staff page); cities (never removed; a new area picks one); fitting centres with address, on or off (never removed; fitting slots open only at a centre that is on); support numbers (+91, WhatsApp or not), days and hours in India time, and whether support is open now; message wording for a support reply and "campaign report ready" (WhatsApp: the approved template's name; email: subject and text with {placeholders}, unknown ones and a missing {reply}/{link} refused); the rider pay zone (a circle or chosen areas); the screen-loan bank; which outside services are on (no keys shown).
- Support replies and report emails now use the wording in force.
- Tests: domain 8 (each setting's checks, never removing, hidden characters, India-time hours, wording); database 5 (versions with who and why, refusals, a stale save, two saves at once, the reply's wording, the audit log); API 1 (who sees and changes, 409 on a stale save, a city from the list) + config 1 (outside services, no key shown); browser 1 (a centre added, a wrong number refused then saved) and the fitting slot now picks its centre.
- **Second review:** nothing serious. Fixed: a draft-only area could join the pay zone; the "Saved" message vanished on reload; invisible characters (zero-width, right-to-left) were let through. The page now says plainly that the pay zone is not sent to screens yet, the bank name is used from P4.2.6, and report wording is the email's subject and plain text (the report itself keeps its design).
- The API sign-in test that failed under load: found the cause. 30 slow password checks took over 5 seconds when other test files ran at the same time. Its time limit is now 30 seconds; the code was fine.
- Open: no fitting centre is set yet, so no fitting slot can be opened until Prateek (or a super admin) adds one with its address. Support numbers to be added when the lines exist. The pay zone reaches screens with the step that sends settings to screens.
- Next: the admin portal steps (P3) are done. Next in the plan: P4, the rider app.

## 27 Oct 2026 · P3.16 · Audit log
- PR #63 (reports, dashboard, support, cheaper checks) merged with all checks green, after the repository went public.
- **One log of everything** (migration 0045, view `audit_log`): every record of who did what (staff and access, areas, prices, business modes, calendar holds, brands, bookings and their notes, ads and reviews, refunds, money paid back, partners, payout runs and holds, riders and their documents and checks, fittings, screen loans, screens, keys and certificates, player releases, support steps and replies) in one timeline with when, who, part of the business, what, about what and why. It is a view over records that are never edited or deleted, so the log cannot be edited either. No message bodies, phones, emails, bank or document numbers in it.
- **Nothing left out:** a test lists every table with a "who did it" column and fails if one is missing from the log. A new table added later must join the log.
- **Audit log page** (super admin only): find by words (who, what, booking, rider…), pick a part, between two India dates; newest first; "Show older" pages on without skipping or repeating; download as a file (India times, up to 10,000 rows).
- Tests: database 4 (nothing left out; search, part, "%" as a letter, dates; pages and the file; entries alike in the same second, no empty values, nothing personal); API 1 (super admin only, dates checked, the file); browser 1 (search by a rider's reason, filter by part).
- **Second review, all fixed with tests:** some entries had an empty "why" (an approved ad, a hold without a reason, a limit lifted), which broke "Show older" and the download: never empty now. Two entries alike in the same second (two support notes) could be skipped between pages: each entry now pages by its own record's key. A refused sign-in for an unknown address showed whatever was typed (could be a password): now "not a member". Staff emails and the text of notes and support subjects are left out (only that a note was added). Rupee amounts and partner rates shown properly (₹1234.50, 2.50%). A download over 10,000 entries says so.
- Open: one API sign-in test (30 wrong tries) failed once while another agent was using the same laptop database; it passed 4 times after. Watch it.
- Next: P3.17, Settings (the last admin step).

## 27 Oct 2026 · P0.2 (CI) · Cheaper checks; repository to be public
- GitHub Actions minutes ran out on 26 Oct (every job refused at once). Prateek chose to make the repository public (free minutes) and may make it private later.
- Checked before: the whole history has no secrets or key files.
- `.github/workflows/ci.yml`: the long jobs (format/lint/types/tests, laptop services, database and browser tests) run on pull requests only; a push to main runs the secret scan and the commit-message check. `.github/workflows/player.yml`: the screen player's Android job, only when `apps/player/`, the shared test vectors or this file change.
- Next: merge PR #63 once its checks run.

## 27 Oct 2026 · P3.15 · Support inbox
- **Messages coming in** (`packages/adapters/src/inbound.ts`, with a working fake): the WhatsApp and email provider posts each message to `POST /support/inbound`, signed; a forged post is refused; a message posted twice is kept once. `SUPPORT_INBOUND_PROVIDER`: the fake on a laptop only; none in production until P6.
- **Conversations** (migration 0044, `packages/db/src/support.ts`): a message joins the person's conversation on that channel, or starts one, matched to the rider (by phone) or brand (by its contact) it came from; a conversation marked done opens again when they write. Staff start one for a call or a visit (or to write first). Support admins reply on WhatsApp or by email (each reply its own message, sent once), add notes only staff see, take a conversation, and mark it waiting or done, with why. Every message, note and step kept in the order it happened.
- **Support page**: the inbox (longest waiting first, with how long), a conversation's whole history, reply, note, take it, waiting, done, open again; a new conversation for a call or visit. Support looks (read-only members see phones masked) and Support admins act; a super admin too.
- Tests: adapters 1 (only a signed, sound post is trusted); database 4 (matching a rider and a brand, kept once, waiting first, reply sent once, done and opened again, a call, nothing edited); API 1 (+ config); browser (a rider's WhatsApp message answered, noted, done).
- **Second review, all fixed with tests:** two replies at the same moment could share a key (the second never delivered but shown as sent): now each reply is written down first and its own number is its key, and how it went is kept beside it; a reply with no answer (30 seconds, or the system stopping) shows as "not confirmed", never as sent or failed. Read-only members saw full phones in the history: masked there too, and emails masked. A message coming in and a staff action on the same conversation now take the same lock. Messages with a NUL or a line break in the subject (an email header risk) are refused. The provider's message id is kept per channel. "I'll take it" hides when you already have it.
- Open: the real WhatsApp and email provider (P6); WhatsApp replies use an approved "support_reply" template until free text inside the 24-hour window is set up with the provider; support hours and auto-replies come with Settings (P3.17).
- Next: P3.16, audit log.

## 27 Oct 2026 · P3.14.2 · Business dashboard
- **Dashboard** (`packages/db/src/dashboard.ts`, `services/api/src/dashboard-api.ts`, `apps/admin/app/dashboard`): the business month by month (India time, the last 6 months): bookings paid, bike-hours sold, the screens' on-time and moving bike-hours (from their minute summaries), screen time sold (bike-hours sold for days already over, as a share of the screens' on-time), money in (with GST), revenue earned as plays were delivered, refunds approved (how many, how much, share of revenue). This month's numbers as tiles. Sales and Finance look (and a super admin). Read-only; billing stays by bike-hours only.
- Tests: database 1 (a paid booking, an unpaid draft left out, revenue, a refund, screen time; screen time sold counts only days already over); API 1; browser (the page).
- Open: GitHub Actions stopped starting jobs on 26 Oct at 23:18 UTC (likely the account's Actions minutes): PR #63 waits for checks; Prateek to look at GitHub billing.
- Next: P3.15, support inbox.

## 27 Oct 2026 · P3.14.1 · Final reports in admin
- P3.13 merged (PR #62).
- P3.14 is done in two parts: **.1** final reports (this), **.2** business dashboards (fill, revenue, refunds, moving hours).
- **Reports run for real now**: the API builds each due final report (P1.9.1) and sends it to the brand (P1.9.2) every 5 minutes, when maps and messages are set up: the fakes on a laptop nobody else can reach (`REPORTS_PROVIDER`), none in production until the real providers (P6). Where brands open a report: `BRAND_PORTAL_URL`.
- **Reports page** (`packages/db/src/report-desk.ts`, `services/api/src/reports-desk-api.ts`, `apps/admin/app/reports`): every campaign that has ended, with where its report stands (waiting for its last checks, built and being sent, sent, no contact, could not be delivered), plays delivered, and each channel's last try. A report opens as the brand sees it (in a sandboxed frame), downloads as its PDF, and Sales or Support admins send it again on WhatsApp or email to the brand's contact now: its own message (never the first replayed), recorded with who asked, not twice within two minutes, never while the automatic sender runs. Sales, Support and Finance look.
- Tests: database 1 (the list and a staff re-send); API 1 (who looks and opens, who re-sends, refusals, nothing without messages set up) + config; browser (an ended campaign, its report, sent again by email).
- Open: the real maps and messages providers (P6).
- Next: P3.14.2, business dashboard.

## 27 Oct 2026 · P3.13.3 · Agencies and aggregators: statements and payments
- Prateek confirmed (27 Oct): the automatic Monday pay run needs one approver; only a super admin records a refund the provider never answered about (DECISIONS).
- **Cuts** (existing P1.7.4 logic, now in admin): a super admin gives a cut on a paid booking to an agency or an aggregator (rate from the price book unless set, the partner's GST, why); once per kind per booking. Cuts are earned as plays are delivered.
- **Statements** (`packages/db/src/partners.ts`): each partner with a cut and what it is owed now; its monthly statement (owed at the start, cuts by booking with GST and TDS held back, payments, its invoices dated in the month, owed at the end), downloaded as CSV to send.
- **Payments** (migration 0043): finance records a bank transfer to a partner with its bank reference, never more than it is owed; the ledger moves it out of what is owed and out of the bank. Its invoices are recorded too (GST claimed only against them; one per number).
- **API**: `GET /money/partners`, `GET /money/partners/statement`, `POST /money/partners/pay`, `/invoice`, `/cut`. **Money page**: an "Agencies and aggregators" card.
- Tests: database 3 (a cut once, by a super admin; the statement with GST and TDS; paid never more than owed, the next month opens with what is left; invoices once; append-only; ledger balances); API 1; browser (a cut given, the statement, an invoice recorded, a payment over what is owed refused).
- **Second review, all fixed with tests:** the same bank transfer could be recorded twice (a lost reply, a second press): now one reference per partner, refused again; an invoice for a mistyped partner or an impossible date (30 Feb) is refused; the statement file now lists the partner's invoices; an open statement reloads after a cut. Checked and sound: never paid more than owed (one lock with the cut accruals), TDS stays with the government, balances add up month to month, negative cuts after refunds.
- Open: partners are paid by bank transfer recorded by hand until a payout provider is contracted (P6). A partner's invoices are kept per partner, not per kind (an agency that is also an aggregator shares them; DECISIONS).
- Next: P3.14, reports.

## 27 Oct 2026 · P3.13.2 · Money owed back to brands
- **Payments adapter** gets a refund call (money sent back against the payment it came from; the same key every try, so never twice) with a working fake.
- **Owed back** (migration 0042, `packages/db/src/money-back.ts`): each amount owed back is the ledger entry that put it on the books (an approved refund with its credit note, or a payment after a cancellation or of a wrong amount). Finance sends it back through the payment provider against the brand's payment: a passing failure is tried again (3 tries, then given up), a pending or lost answer is asked again with the same key. When the provider cannot (no payment on record, given up), finance records the bank transfer they made, with its bank reference. Never by hand while the provider may still send it. Each try is kept; the books move once (`paid-back:<entry>`: out of the gateway account, or out of the bank).
- **API**: `GET /money/owed-back`; `POST /money/owed-back/send` and `/by-hand` (finance admins and super admins; read-only members look).
- **Money page**: an "Owed back to brands" card: each amount, why, where it stands, its history; Send back / Send again; Record bank transfer.
- Tests: adapters 1 (refund once per key, never more than is left of the payment); database 4 (the list with the payment each goes back against; sent once; a passing failure and a pending answer; given up and paid by bank transfer; ledger balances; append-only); API 1 (who sends, refusals, both ways); browser (a refund sent back, a stray payment paid by transfer).
- **Second review, all fixed with tests:** if the provider sent the money back but its answer was lost (a crash, a dropped connection), the item still looked unsent and could also be paid by hand: now "asked the provider" is saved before asking, so it shows as waiting and is only asked again with the same key. A provider that never answers could leave an amount stuck: a super admin may then record the bank transfer, saying in the note that the provider confirmed nothing was sent. The provider gets 30 seconds to answer; one slow item no longer blocks the others (one lock per amount); a short key for the provider, a new one only after a failure (providers replay failures under their key). Money owed back with no known brand now counts in the total ("brand not known"); the list says when it is cut at 500; the card shows even if a month fails to load and refreshes after a refusal.
- Open: the real payment provider (P6).
- Next: P3.13.3, agencies and aggregators.

## 27 Oct 2026 · P3.13.1 · Money page (read-only)
- P3.12 merged (PR #61).
- P3.13 is done in three parts: **.1** see the money (this), **.2** pay refunds back to brands, **.3** agency and aggregator statements and their payments.
- **Money page** (`packages/db/src/money.ts`, `services/api/src/money-api.ts`, `apps/admin/app/money`): where money stands now from the ledger (held for campaigns, owed back to each brand, owed to riders and to partners, TDS to deposit, GST not yet paid); a month's payments received (paid, or paid after a cancellation or of a wrong amount: owed back); its tax invoices and credit notes; the GST summary (invoices, credit notes, input credit, GST to pay, TDS, the year's turnover and the e-invoice check, invoices missing a brand's tax details); provider messages about links we have no record of; and the accountant's five files (invoices, credit notes, partner invoices, journal, summary) downloaded as CSV. Finance looks (read-only members too); nothing here moves money.
- Tests: database 4 (India months, payments with late money, the invoice, the money position and unknown messages; ledger balances); API 1 (who looks, a month, the files); browser (the page and a download).
- Open: none.
- Next: P3.13.2, money owed back to brands.

## 27 Oct 2026 · P3.12 · Payouts
- P3.11.3 merged (PR #60).
- **The Monday run in admin** (migration 0041, `packages/db/src/payouts.ts`): prepared by itself on Monday from 10:00 India time (or by hand), approved by someone other than who prepared it, then sent through the payout provider. What preparing found (riders with no checked account, pay not brought up to date, changes in closed months) is kept with the run.
- **Finance can** hold one rider's line (never sent until released), drop it (his money goes in the next run) or cancel the rest of a run, each with why; nothing changes while a run is being sent. Failures are sent again (3 tries, then given up and owed next run).
- **API** (`services/api/src/payouts-api.ts`): runs, one run, prepare, approve, send, hold/release, drop, cancel. Finance looks; finance admins and super admins act; read-only members see UPI ids masked. Payout provider: the fake on a laptop only; production cannot send until a real one (P6).
- **Admin site**: a Payouts page (runs, where each stands, each line with its history and actions).
- Tests: database 5 (auto-prepare timing, findings kept, hold/release, drop, nothing during a send, run list and page, append-only, ledger balances); API 1 routes test + config; browser (approve, hold, release, paid).
- **Second review, all fixed with tests:** money held or left in an older run could drop out of sight (now listed at the top of the page, whatever its age, and any run can still be opened and acted on); any past Monday could be prepared by hand (now this Monday or last week's only); every page loaded every payout line ever made (now only the runs shown); hold reasons and provider messages could show a UPI id to read-only members (masked everywhere); the Approve button showed for whoever prepared the run, and "Cancel the rest" when nothing could be cancelled; wrong answers for a missing line (now 404) and approving your own run (now 403). A run the system prepared needs one approver (DECISIONS). Checked and sound: nothing can be paid twice, paid more than owed, or paid while held.
- Open: the real payout provider (P6); a large run is sent inside one request for now.
- Next: P3.13, money (payments, invoices, credit notes, refunds, statements, GST, exports).

## 27 Oct 2026 · P3.11.3 · Fitting slots, a rider's money, leaving
- P3.11.1–2 merged (PR #59).
- **Fitting slots** (migration 0040, `packages/db/src/rider-fitting.ts`): Operations open a slot at a fitting centre (a start in India time, up to 90 days ahead; how long; how many bikes) and book an approved rider into it. One booking per rider (booking again moves it, the old one cancelled with why); a slot never takes more bikes than it has room for (one lock for slots and bookings); a booking is cancelled with why. Each booking and cancellation is an event. Fitting centres become a setting in P3.17.
- **His money**: what he is owed now (rider pay in the ledger, less what was paid) and his recent payouts with how each went.
- **If he leaves**: the screen returned (leaving needs it), the final pay (owed and paid in the next Monday run to his checked account, or a warning that he has none), and any screen loan still open with the bank (tell the bank).
- **API**: fitting slots (look; open), book and cancel; the rider's page carries his booking, money and the leaving list.
- **Admin site**: a Fitting slots card on the Riders page (open a slot); in a rider's panel: Fitting (book, move, cancel), Money, If he leaves.
- Tests: database 2 (slots: approved riders only, room never exceeded, a booking moved and cancelled, a started slot refused; money and the leaving list with pay owed, a loan and a checked account); API (slots, booking, the page); browser (a slot opened and the rider booked into it).
- Open: the rider app (P4) books his own slot; fitting centres as a setting (P3.17).
- Next: P3.12, payouts.

## 27 Oct 2026 · P3.11.2 · Rider checks: identity, agreement, bank (and P3.11.1 review fixes)
- **Adapters** (`packages/adapters/src/rider-checks.ts`) with working fakes: identity (KYC: Aadhaar through DigiLocker and PAN, through a provider), e-sign of the rider agreement, and a ₹1 bank check (penny drop). Real providers come with their contracts (P4); production runs without them until then.
- **Checks** (migration 0039, `packages/db/src/rider-checks.ts`): each check started and its one result kept. Only what is needed (DPDP Act): the name on his ID and its last 4 characters, never the ID number; the bank check keeps a fingerprint of the account, and only an account that passed becomes where he is paid. Pending checks are asked about when his page opens and before an approval.
- **Approval now needs** identity verified with the name on his ID matching his (every word of the shorter name in the longer; an initial matches its word), the current agreement signed, and his bank or UPI checked (in his name, the account he has now).
- **Review of P3.11.1, all fixed with tests:**
  - Fitting a screen did not check the rider at all (an unknown, unapproved or rejected rider, or someone else's plate, could get a screen and be paid): now the rider must be on record, approved (or riding or paused), and the plate must be his. Fitting, steps and detail changes take the same locks in the same order; a plate cannot change while a screen is on the bike.
  - Riding again re-checks his documents (insurance in date); an insurance already ended cannot be accepted; rejecting, like leaving, needs the screen off.
  - Phones and plates come free when a rider leaves or is turned down (numbers are given out again, bikes sold); coming back checks them again.
  - Personal documents: previews only for Operations admins (who look at them), never the file's fingerprint; read-only members see phones masked.
  - Pressing Enter in the step reason no longer moves the rider; document buttons cannot be pressed twice.
  - Phone search with a 0 in front, plates with dashes; uploads checked (which document, whose) before the file is read; ads and documents each have their own upload slots; timeline ties in a fixed order; an index for screens by rider.
- Tests: adapters 2; domain 6 (names, the new checklist items, back on the road); database 4 riders (the whole check flow with the fakes, a mismatched name and a closed account refused; fitting rules; phones and plates freed and re-checked); screens tests now fit real approved riders; API 1 (checks, privacy, early refusals); browser (identity, agreement and a UPI id checked from the panel before approval; Enter does not move him).
- **Second review of P3.11.2, all fixed with tests:**
  - A passed ₹1 check made any account his payout account, even in another name: now the name the bank holds must match his, or the check fails and nothing changes; once he is approved with a checked account, only a super admin moves his pay.
  - The weekly payout run paid the newest account written, checked or not: now it pays only an account that passed a ₹1 check in his name (the old unchecked way of setting one is gone); anything else is listed for finance as "no account".
  - A pass with no name (or no ID digits) ticked the box: now it counts as failed; the agreement records who signed and that name must match too.
  - Names matched too easily ("R" matched "Ravi Kumar"): each word must pair with a different word, a one-word name only with the same word, and initials alone never match.
  - Once approved, his name cannot change away from the name on his ID and bank.
  - The fake checks would have run on any server not marked production: now only on a laptop nobody else can reach (as for payments); production has none until the real providers (P4), so no rider can be approved there before then.
  - Check links go only to Operations (who send them to him); the panel no longer says they were sent; read-only members see only the last 4 digits of a phone and cannot search by phone.
- Tests for database code now get 20 seconds each (as the other packages): the final report's PDF ran close to 5 s in a full run.
- Open for Prateek: (1) how long rider records and documents are kept after he leaves (DPDP: erasure path), and (2) the agreement text from the lawyer (version rider-v1 is a placeholder). The real KYC, e-sign and bank-check providers need contracts.
- Next: P3.11.3, fitting slots, earnings and leaving.

## 27 Oct 2026 · P3.11.1 · Rider records
- P3.10 merged (PR #58). P3.11 is built in two parts: P3.11.1 rider records (this), P3.11.2 identity (KYC), agreement, bank check, fitting slots, earnings and leaving.
- **Rules** (`packages/domain/src/riders.ts`): rider ids "RD-000123" in order; phones put in one form (+91 and 10 digits) and number plates too (as screens' fittings store them); steps applied → approved or rejected → riding → paused → left (a rejected or departed rider may apply again), each with why. Approval needs the plate and the photo, registration and insurance accepted, the insurance still in date; riding needs a screen fitted to him; leaving needs it taken off first.
- **Records** (migration 0038, `packages/db/src/riders.ts`): riders, details as versions (one phone and one plate per rider), steps, documents (read from their own bytes: a picture or a PDF, up to 10 MB; stored by fingerprint, read through short-lived links), one final look at each (insurance with the last day it covers), notes, and a rider's page with his timeline.
- **API** (`services/api/src/riders-api.ts`): Operations and Support look; an Operations admin adds and changes riders, looks at documents and moves steps; Operations and Support admins add notes. Uploads (ads and documents) share one limit of 2 at a time.
- **Admin site**: a Riders page (find by name, phone, id or plate, or by step; add a walk-in rider) and a rider panel (details, what approval needs, steps, documents with previews and accept/reject, notes, timeline). The pass-through lets a search with a space through.
- Tests: domain 4 (phones and plates in one form, property tests; the checklist; the steps); database 3 (one phone and plate per rider, documents and their looks, approve/riding/leaving with a real screen fitted and taken off); API 1 (who does what); browser (a walk-in rider added, documents sent and accepted, approved, a note, found again).
- Open: KYC, the agreement and the bank check join the approval checklist in P3.11.2; fitting a screen does not yet check that the rider is approved (P3.11.2, with fitting slots).
- Next: P3.11.2.

## 26 Oct 2026 · P3.10 · Delivery and make-ups
- P3.9.2 merged (PR #57).
- **Where a line stands** (`packages/domain/src/delivery.ts`): from its booking's step, its hour, plays counted, the make-up and refund decisions: not paid, waiting for ads, ads missing, upcoming, live, counting late uploads, delivered (extra plays free), short with a make-up booked or running, short waiting for the next decision, refund due / approved / rejected.
- **Delivery data** (`packages/db/src/delivery.ts`): each line's plays counted exactly as the money counts them (the play rules of the price book it was sold on), bikes seen, make-ups with the plays counted for each, the refund and its decision; a booking's lines or a business day's sold lines (up to 300).
- **The make-up and refund rules can run**: with `SETTLE_MAKE_UPS=on` the API makes the due decisions every minute (P1.6 `settleDue`: each decision once). Off by default: the screens' plans do not include make-ups until the scheduler service, and a make-up no screen plays would only end in a refund (and on the first run every old short line would be decided at once).
- **API** (`services/api/src/delivery-api.ts`): a day's lines (default today, India time), a booking's lines; Operations, Sales, Support and Finance look. A super admin approves or rejects a proposed refund, with why (the ledger and credit note follow, P1.7).
- **Admin site**: a Delivery page (pick a business day; each line's hour, brand and booking, area, bikes seen, plays, status in a word and in a sentence; refund decisions for a super admin) and a Delivery section in each booking's panel.
- Tests: domain 4 (each status; missing never below 0 or above promised, a property test); database 2 (real signed plays: live, counting, short with a make-up whose plays make up the rest; a day's lines); API 1 (who looks, the day, refunds only by a super admin); admin unit 1 (the words); browser (an approved booking's hours on the Delivery page).
- Review by a second agent, all fixed with tests:
  - Refunds for a paid booking cancelled early were invisible (the status said "cancelled", the day page left cancelled bookings out): a refund now shows first, the day page includes cancelled lines that have one, a "Refunds waiting" list (any day) sits at the top of the Delivery page, and cancelled bookings show their Delivery section.
  - Running the make-up rules before the screens play make-ups: off by default (above), each loop on its own.
  - A short line said "waiting for the next make-up" forever when nothing more would happen (a trial, under a paisa) or when the refund came next: now "nothing to refund" or "a refund is worked out a day after the last make-up"; a decision more than 5 minutes late shows as late.
  - The make-up rules shown came from the defaults, not the price book the line was sold on: now the line's own.
  - A day over 300 lines was cut silently: now says so. Play counts read a few at a time (not one after another), make-ups found by line (an index).
  - Impossible dates (30 Feb) refused; refund errors as "not found" / "already decided"; approved refunds show what was credited (with any top-up); later lines of a paid booking wait for ads only until its first hour; a line's next-day make-up shows on that day too.
- Open: the screens' plans do not yet include make-ups (the scheduler service, P1.4 wiring); then turn `SETTLE_MAKE_UPS` on. Bikes seen counts screens that played the line's own hour.
- Next: P3.11, riders.

## 26 Oct 2026 · P3.9.2 · Ad review queue
- P3.9.1 merged (PR #56).
- **Review rules** (`packages/domain/src/ad-review.ts`): to approve, the reviewer ticks every rule (no flashing; nothing like a road sign; not a banned category; any warnings from the automatic checks looked at); an ad that failed the automatic checks can only be rejected; a rejection says why (10 to 500 letters, so Sales can tell the brand what to fix).
- **Decisions** (migration 0036, `packages/db/src/ad-reviews.ts`): one per ad, final, never edited. Approving moves on every paid booking whose chosen ads are now all approved (paid → ads approved), checked again under the booking's lock in the same transaction. Past a booking's deadline (7 days before its first hour, a setting) it waits: a reviewer approves it on short notice with why (logged on the booking's step). A booking paid after its ads were approved moves on by itself (before its deadline).
- **Booking ads**: a rejected ad cannot be chosen; once a booking's ads are approved, it can switch only to other approved ads (never back to waiting).
- **API** (`services/api/src/reviews-api.ts`): the queue (Ad review and Sales look), decide (Ad review admin), short-notice approval.
- **Admin site**: an Ad review page: ads waiting, the ones bookings need soonest first (with how long until, or past, the deadline), preview, what the checks found, the checklist, approve or reject with why; bookings waiting for a short-notice approval; the latest decisions. The booking panel shows each ad's review.
- Review by a second agent, all fixed with tests:
  - The person who uploaded an ad could approve it: now someone else reviews it (a super admin may, so one person can run the POC).
  - A database failure just after a payment (or a review and a change of ads at the same moment) could leave a paid booking stuck with all its ads approved: real failures are no longer passed off as "not ready", and every minute the API moves on any paid booking whose ads are all approved (before its deadline).
  - An approval note on one ad could approve several late bookings on short notice: each late booking now needs its own reason.
  - Approved ads could be swapped right before the first hour with no reviewer: now only before the deadline, and only to approved ads.
  - The queue reads only bookings still to run (it stays fast as history grows), leaves out files that failed the automatic checks (they can never run), and lists short-notice bookings only once past their deadline. "Due in 10 minutes" instead of "1 hour".
- Tests: domain checklist matches the page's; database 3 (approve/reject rules, one decision, the booking steps, short notice, the queue's order, paid after approval); API 1 (who looks, who decides, short notice); browser (a reviewer approves two ads, approves the booking on short notice, rejects a 3-second video).
- Open: the hour plan and the screens' file lists will use a booking's approved ads when the scheduler service is built (P1.4.1 wiring); the move to "ads missing" when a booking's first hour comes without approved ads is for the scheduler too; a wrongly approved ad is taken off by choosing others (a decision is never undone).
- Next: P3.10, delivery and make-ups.

## 26 Oct 2026 · P3.9.1 · Ad files and their automatic checks
- P3.8.2 merged (PR #55). P3.9 is built in two parts: P3.9.1 ad files (this), P3.9.2 the review queue (approve or reject with why, short-notice approvals, the booking's step to ads approved).
- **Automatic checks** (`packages/domain/src/ad-checks.ts`): an ad is one file the screen plays for a whole 15-second spot: a picture (PNG, JPEG, WebP) or an MP4 video. The file's own bytes are read (never its name): kind, pixels, and for a video its length and compression (from the MP4 boxes). Each check passes, warns (a person decides) or fails (never runs): size (30 MB), shorter side at least 480 px, the screen's shape 2:1 (1280 × 640; others fail), video length 15 s ± 0.5 s, sound (a warning: screens play none), H.264 (others a warning). The limits are a price-book setting (`ads`).
- **Storage adapter** (`packages/adapters/src/storage.ts`) with a working fake: files stored under their SHA-256 (the same file once; never swapped under its name), read only through short-lived signed links. The real store (S3-compatible) comes in P6; production has none until then.
- **Ads** (migration 0035, `packages/db/src/ads.ts`): each upload belongs to a brand with its facts and checks (a failed file is kept so staff see why, but can never be chosen; a file that is not a picture or video is refused). A booking chooses 2 to 5 of its brand's ads (they take turns), as versions, until it runs.
- **API** (`services/api/src/ads-api.ts`): upload (Sales admin; the file as the body, up to 64 MB), a brand's ads with preview links, a booking's ads; on a laptop the API serves the fake store's files through signed links. The admin site passes uploads up to 64 MB and files back; its query check now allows percent-encoded values (they come after a fixed address and path).
- **Admin site**: an Ads section in the booking panel: previews, what the checks found in one line, upload, choose and save.
- Fixed on the way: the payment event on a booking's timeline used the payment company's clock; now the time we learn of it, like everything else on the timeline.
- Tests: domain 7 (real files made with ffmpeg read exactly; checks; any bytes never break the reader and what it keeps fits the database, a property test; crafted files fail; a 16 MB hostile file read in under half a second), adapter 2, database 3, API 1, admin unit 1, browser (a video and a picture uploaded and chosen, a 3-second video refused, previews through signed links).
- Review by a second agent (security of uploads), all fixed with tests:
  - The admin site held each upload (up to 64 MB) in memory before anyone was checked: now it passes the file to the API as it arrives, refuses an upload with no sign-in before reading it, and runs at most 2 at once (the API too, each with a 3-minute limit, no extra copies).
  - A tiny crafted file could claim 4 billion pixels or a length of 136 years and cause a server error, leaving a stored file with no record: sizes over 16,384 px and lengths over 1 hour are not believed (the check fails); a name with a control character is refused; the record is written first and the file stored inside the same transaction.
  - "Passes" could be shown for a header with nothing behind it: a picture must hold picture data (PNG image data, JPEG scan, WebP frame), a video a video track with frames and their data; the length must agree three ways (file header, track header, frame table); only true MP4s count (not QuickTime, AVIF or HEIC); the full PNG signature is checked; reading stops after 10,000 boxes (a hostile file cannot keep the server busy).
  - Ads can no longer change once approved (P3.9.2 will send a change back for review); the booking's step is checked under its lock; ad ids are checked; closed brands cannot upload; percent-encoded queries pass only with uploads; file links are never kept past their life or run as a page; chosen ads older than the newest 200 still show.
  - CI found two ads uploaded in the same second listed in random order: ads now keep their upload order.
  - Corrected before merging: the checks first assumed a 16:9 screen and 64 MB; Prateek's decision of 22 Oct says 1280 × 640, no sound, up to 30 MB, so the defaults are now 2:1 (a wrong shape fails), 30 MB (refused before storing), and sound is a warning. Test files remade at 1280 × 640.
  - Second round (no blockers): an upload cut off on the way is refused, not kept as a whole file (the admin site passes on the declared size; the site and the API both check it); a video marked to play turned a quarter is read upright (its shape is checked as it plays); a video whose sound runs longer than the picture, and a fragmented (streaming) MP4, fail with those words instead of "length cannot be read". Checked against real ffmpeg files: plain, fast-start, with sound, 1080p, 29.97 fps, trimmed, HEVC and VP9 (warned), QuickTime (refused).
- Prateek confirmed: a picture plays for a whole 15-second turn; a booking needs at least 2 ads (up to 5).
- Open: brands upload in their own portal (P5); the hour plan and the screens' file lists will use the approved ads (P3.9.2). A full decode of each video (a sandboxed probe) comes with the real file store (P6); until then the reviewer watches the preview. Video previews do not play in Safari on the laptop fake (no partial downloads); fine in Chrome.
- Next: P3.9.2, the review queue.

## 26 Oct 2026 · P3.8.2 · Booking for a brand
- P3.8.1 merged (PR #54).
- **Payments adapter** (`packages/adapters/src/payments.ts`) with a working fake: a link per booking attempt (asking again gives the same one), its status, stop, and the provider's signed messages (checked in constant time, and field by field: the amount paid, the payment id, the time in seconds).
- **Booking desk** (`packages/db/src/booking-desk.ts`, migration 0034): a Sales admin makes a draft for a brand (any start date; last-minute too), sends it for payment (bikes kept, limits and prices checked again) with a link that works `payLinkHours` (a new price-book setting, 24) and never past the first hour; the signed message, or "Check payment", records the payment once; a link that runs out unpaid (2 minutes' grace) is stopped and the booking cancelled, so its bikes go back on sale (a loop every minute in the API). Money that cannot be kept (paid after a cancellation, a wrong amount, a second payment) is posted at once as owed back (`moneyToReturn`: gateway money against refunds payable) for finance; messages about links we do not know are kept in an inbox. Cancel with why, notes, and the booking's timeline.
- **Rule**: the system may cancel an unpaid booking even after its first hour has started (it never ran and must not keep bikes); staff and paid bookings keep the old rule.
- **API**: `GET /bookings/<id>`; `POST /bookings`, `/bookings/<id>/send|check|cancel|notes` (Sales admin); `POST /payments/webhook` (the signature is the only key). Payments come from `PAYMENTS_PROVIDER` (empty on a laptop: the fake).
- **Admin site**: "New booking" on a brand's page (one area, a run of days, chosen hours, bikes; deal offers from the prices in force) and the booking panel (money, payment link, check, cancel, timeline, notes).
- Tests: adapter 2; domain (+1 rule); database 7 (sent and paid once; last-minute link and expiry with grace; late money owed back; checking; an expiry racing a payment five times; a wrong amount; an unknown link; too late to pay by link; no link made; one bad link not stopping the run); API 2 + config 1; admin unit 2; browser 1 (booked, link sent, paid through the fake, timeline).
- Second-agent review: signature checks, replays, permissions and the one-payment-per-booking lock were right; 9 serious findings, all fixed:
  - **critical**: an expiry (or a check) racing a payment could cancel a booking that had just been paid, keeping the money and freeing the bikes. Now every step names the step it expects, checked under the booking's lock (`expectFrom`); a race is refused, never applied; tested with all three paths at once;
  - money paid after a cancellation was only a note. Now it is on the books as owed back, with a finance line on the timeline;
  - a booking sent for payment whose link was never made (provider down, a crash) kept its bikes for ever. Now let go after 10 minutes; links must work at least 15 minutes;
  - a link id given twice by a provider could be filed under the wrong booking. Now refused; the fake's ids are random;
  - one failing link stopped the whole expiry run. Now each link on its own;
  - a payment finishing just after the link's end was lost. Now the link is stopped first, asked, then acted on, after 2 minutes' grace;
  - the amount paid was never checked, and a second payment was dropped. Now checked; a wrong amount or a second payment is owed back;
  - messages about unknown links were dropped. Now kept in an inbox;
  - the fake's public key could take "payments" on a reachable test server. Now a server reachable from outside must set its own key; production never runs the fake, and without a real provider runs without payments (pay routes say so) instead of refusing to start.
  - Also: the provider's payment time is kept within the link's life; clearer "Check payment" answers; no "send a new link" that could not work; a warning before cancelling a paid booking; the timeline in India time and in a sensible order within a second; deal offers from the prices in force.
- Second review of the fixes: no payment can be both paid and owed back, every path balances; 9 more findings, all fixed:
  - a wrong-amount payment, or an expiry whose cancel failed half-way, left the booking waiting (bikes kept) for ever. Now the expiry run picks bookings by their state and their newest link's end, and any booking still waiting after that end is let go; the cancel and the link's "ended" record are written together (`alsoWrite` on a booking step), or neither, and retried next run;
  - a booking cancelled while its link was being made could be handed a working link. Now the link is filed only under the booking's lock while it still waits, else stopped and refused;
  - the "paid" record on the link and the booking's move to paid are written together;
  - money on an unknown link is now also on the books as owed back;
  - a provider that can say nothing about a link: the booking is let go an hour after the link's end; the fake answers "ran out" for links it forgot;
  - payments are recorded at the time we learn of them (invoices stay in date order; closed months never change), the provider's time is kept on the payment record;
  - a test server behind a proxy, or serving a reachable admin site, must set its own payments key;
  - link ids have one shape everywhere; a booking that moved meanwhile is a 409, a provider not answering a 400.
- Open: a finance list of money owed back and the inbox (P3.13); sending the link to the brand on WhatsApp (messages adapter) rather than staff copying it; the real provider (P6).
- Next: P3.9, ad review.

## 26 Oct 2026 · P3.8.1 · Brands and agencies
- P3.7 merged (PR #52). Prateek: selling is dynamic; bookings and holds both use up what an area-hour can carry, spare bikes run make-ups, aggregator or RECALL ads; after the POC the aim is the most business, with nearby slots offered when an area-hour is full (DECISIONS, PR #53).
- P3.8 is built in two parts: P3.8.1 accounts (this), P3.8.2 booking for a brand with a payment link, the booking timeline, cancel and notes.
- **Accounts** (migration 0033, `packages/db/src/brands.ts`, rules in `packages/domain/src/brands.ts`): brand and agency accounts; details (name, agency, referred by, open or closed) change as versions with who and why; a stale page is told to reload, never overwrites; a brand's agency must be an open agency account; an agency with open brands cannot be closed until they move. Notes are kept for good. Contacts and tax details use the existing tables (P1.9, P1.7.9).
- **API** (`services/api/src/brands-api.ts`): list, one account's page, open, change, contact, tax details, notes. Sales, Finance and Support look; a Sales admin changes; a Sales or Finance admin sets tax details.
- **Holds now need a brand account** (closes the P3.7 open item): a typo can no longer block bikes.
- **Admin site**: the Brands page (search by name, id, phone, email or GSTIN; add; one account's details, contact, tax details, bookings, notes, history; an agency's brands).
- Tests: database 3, API 2 (+1 hold check), admin unit 2, browser 1 (an agency and a brand it handles, a contact and a note).
- Fixed on the way: after adding an account the page briefly reloaded the one open before, wiping what was being typed; answers for an account no longer open are now dropped.
- Open: bookings by agencies and their 10% shown on the agency statement (P3.13, P5.10); brand sign-in to the portal (P5).
- Next: P3.8.2, booking for a brand.

## 26 Oct 2026 · P3.7 · Inventory calendar
- P3.6 merged (PR #51) once GitHub Actions ran again (Prateek fixed billing).
- **The grid** (`packages/domain/src/calendar.ts`, `packages/db/src/calendar.ts`): one area's week, every start hour 08:00–01:00: bikes booked (awaiting payment or later; drafts keep nothing), held by live holds, the limit (a super admin's manual limit, or after the POC the forecast), free, bikes usually seen (past weeks, as the forecast reads them, before its margin), and for hours already over the bike-hours delivered (paid lines, by the share of plays counted).
- **Holds**: Sales keeps hours, days and bikes for a client until a set time (no money); releasing one early puts its bikes back on sale at once (migration 0032, `hold_ends`, with who and why); "Turn into a booking" makes one draft booking for the hold's brand with its hours still to come. Holds and limits now keep why they were set. Booking refusals come back in words (`bookingProblemText`).
- **API** (`services/api/src/calendar-api.ts`): `GET /calendar?area&from`; `POST /calendar/limit` (super admin); `POST /holds`, `/holds/<id>/end`, `/holds/<id>/book` (Sales admin). Sales and Operations look, read-only members too.
- **Admin site**: the Calendar page (area, week back and forward, the grid, an area-hour's details, the limit, the hold form, holds this week with Release and Turn into a booking).
- **Fixed on the way**: the admin site's pass-through dropped the query (`?area=…`), so choosing an area or week did nothing. It now passes a plain query (letters, digits, `_ . : = & -`, up to 300 characters). Day names are built by hand (browsers and Node wrote "Tue, 27 Oct" and "Tue 27 Oct").
- Tests: domain 5 (days, a cell's sums, delivered, usual bikes, a hold's lines), database 4 (booked vs drafts, a limit and a hold that does not fit, released early, a hold turned into a booking counted once), API 4 (who may do what, refusals, a hold booked and released, a hold below the minimum spend), admin unit 3, browser 1 (a limit and a hold in Madhapur from a cell, then released).
- Second-agent review: no double counting, races or security holes (all changes take the inventory lock; the query pass-through allows nothing that can change the address); 14 findings, fixed or recorded:
  - the limit box kept the previous cell's number (a limit could land on the wrong hour). Now a new form for each cell;
  - days ticked in another week stayed in the hold. Now only days on screen;
  - "delivered" read every paid line of the week one by one. Now only hours already over, all at once;
  - a bad start hour or unknown area on a limit gave a 500. Now refused with why;
  - holds could cover hours already started, and a partly over hold could never be booked. Now refused; booking from a hold takes its hours still to come;
  - "Turn into a booking" made a new draft each press. Now one booking per hold (409 with its id);
  - the 30-day hold length was a fixed number. Now a price-book setting (`capacity.holdMaxDays`);
  - messages show hours as 01:00, not 25.
- Open: brand ids are typed (checked only for shape) until brand accounts arrive (P3.8); the calendar reads the supply history twice in forecast mode and the price book a few times per load (fine at POC size).
- Next: P3.8, brands and bookings.

## 26 Oct 2026 · P3.6 · Prices and rules
- P3.5 merged (PR #50). Slow test groups (report PDF, scheduler property tests) now have 20 s on the CI machine.
- **The editor** (`packages/domain/src/price-editor.ts`): `applyPriceChange` makes the next price book version from the current one (or, when none was ever saved, the plan's book) with only the asked settings changed: band prices, which band each start hour sells in, deal offers, the deal spread, the floor, minimum bikes and spend, the portal lead time, the ad deadline, the trial length and bike-hours. Every other setting (plays, make-ups, rider pay, taxes, reports) is carried over. `checkPriceChange` = the price book rules plus page rules (limits against typing slips, ads due before the portal lead time, offers 2–36 months). `describePriceChange` gives each change in words (before → after).
- **Records**: each price book version keeps why it was saved (migration 0031); `priceBookRecords` gives every version with who, when and why.
- **API** (`services/api/src/prices-api.ts`): `GET /prices` (every version with what changed; the one in force; the plan's book while none is saved), `POST /prices/check` (problems and changes, nothing saved), `POST /prices` (super admin, with a reason). A change starts now; the page sends the version it showed, so a save made meanwhile by someone else means "reload", never an unseen overwrite. Unknown settings are refused, not ignored.
- **Admin site**: the Prices page (Sales, Finance and super admins see it): bands and hours, offers (add, remove), floor, booking rules, trial; Check shows the rules' verdict and a before/after table; Save with a reason; every version listed with who, when, why and what changed. Before the first version, a super admin starts with the plan's prices. Typed rupees and percents are read exactly (no float).
- Tests: domain 5 (first version is the plan's book; only asked settings change; refusals; any mix of hours keeps each hour in one band, property test; words); API 5 (who may look and save; a change checked then saved from now; refusals with why; two saves at once; a version set for later blocks, versions cannot be edited or deleted); admin unit 3; browser 1 (start with the plan's prices, a price under the floor refused by Check, a change saved and listed).
- Second-agent review: who may save, money handling, two saves at once and offers by months all correct; 6 findings, all fixed:
  - the first version started "now", so rider pay (which uses the book in force when the month starts) would fail for the whole launch month. Now the first version starts at 00:00 India time on the 1st of the month (nothing could be sold before it existed, so no sale changes);
  - every new version sends open quotes back for a new quote (Prateek's rule of 22 Oct), and the page did not say so. Now Check and Save say how many open quotes will need a new quote (`openQuotes`);
  - typed amounts with a misplaced comma ("1,50") were read as rupees. Now only correct Indian or Western grouping;
  - ads due 0 days ahead, a 0% deal spread (deals refused when hours do not split evenly) and a 0% offer could be saved. Now refused;
  - Sales and Finance were sent rider pay, cuts and tax settings with the book. Now only what the page shows;
  - the version list is read in one query.
- Tests after the review: domain 2 (first version's start; the new refusals), database 1 (open quotes), API (first version from the month's start; what Sales sees), admin unit (comma rules).
- Open: scheduling a price change for a later date (changes start when saved, like areas); GST rate, rider pay and other settings are changed in Settings (P3.17).
- Next: P3.7, inventory calendar.

## 26 Oct 2026 · P3.5 · Areas
- P3.4 merged (PR #49). Prateek: Operations admins may pause, resume and roll back the fleet's player update (DECISIONS).
- **Records**: each area version now keeps why it was saved (migration 0030); `areaRecords` gives every version with who, when and why. The area rules themselves are unchanged (P1.1).
- **API** (`services/api/src/areas-api.ts`): `GET /areas` (every area with its history), `POST /areas/check` (the rules' verdict in words, nothing saved), `POST /areas` (super admin adds), `POST /areas/<id>/versions` (Operations admin: shape, edge zone, name, draft), `POST /areas/<id>/active` (super admin: on or off). Changes start now or later, never in the past. An overlap names the other area.
- **Admin site**: the Areas page: every area on the map; open one to drag its corners, click the map to add corners, or type them (one "latitude, longitude" per line, the fallback without a map); Check before saving; edge zone, name, start time (India time), draft, reason; the version history with who and why; super admin: add an area, turn it on or off. Shared map set-up for the admin pages (`lib/map.ts`).
- Tests: API 2 (who may look, edit, add and turn on or off; an overlap refused naming Kondapur; a crossing border; never back-dated; a too-wide edge zone; an unknown area); admin unit 3 (corners read back from their text for any shape; bad lines refused; India time to UTC); browser 1 (open Madhapur, check, save a narrower edge zone with a reason, see version 2 with its reason).
- Second-agent review: 8 findings, all fixed or decided:
  - a super admin's "off" was lost when a draft was pending (it copied the draft, and drafts never take effect: plays kept counting). Now on/off builds on the published shape and takes effect at once;
  - a version scheduled for later blocked every change before it, even an urgent "off". Now changes start when saved (never ahead, never in the past, rounded up to the next second); a version set for later by a script is refused with why;
  - two edits at once, or a repeated id, gave a server error. Now one wins and the other is told to reload (409);
  - overlaps were checked against old shapes no longer in force (blocking new areas), and the database check could miss a published shape when a draft was pending. Now both check the shape in force, the newest one and any coming (`othersInForce`);
  - publishing an area for the first time puts it on sale, so it needs a super admin.
- Tests after the review: domain 2 (on/off over a pending draft; which shapes count), API 4 (off with a draft pending; first publish; an old shape not blocking; a version set for later, and two edits at once).
- Open: drawing the edge zone itself on the map (shown as metres for now); area names on a plain map (needs a font source with the base map).
- Next: P3.6, prices and rules.

## 26 Oct 2026 · P3.4 · Screens
- P3.3 merged (PR #48). Prateek: Operations read-only members and admins may both see riders and routes on the map (DECISIONS).
- **A screen's service life** (migration 0029, `packages/db/src/screens.ts`): to repair, repaired, retired, each with who and why. Screens in repair or retired cannot be fitted; a fitted screen must come off first. `swapScreen`: the old screen off and to repair, a spare on the same bike and rider, one step. Fitting and taking off now share one set of checks.
- **Pausing an update** (`packages/db/src/updates.ts`): `pauseRollout` (paused: offered to no new screen, does not move on; resumed: back at its stage), roll back still works when paused. `rolloutStatus` names the version and its rollback build; `versionsInUse` counts screens per player version.
- **The list** (`packages/db/src/screen-list.ts`): every screen with where it is in its life, bike and rider, state now, player version, battery and box temperature, open alerts, last fitting check, certificate; `stockCounts` with spares wanted (5%).
- **API** (`services/api/src/screens-api.ts`): `GET /screens`; repair / repaired / retire, take off, swap; pause / resume / roll back the update. Operations to look; an Operations admin with a reason to change. The rules' refusals come back as plain 400s with the reason.
- **Admin site**: the Screens page (stock tiles, the update with pause / resume / roll back, filters, the list with health, fitting check and certificate warnings, Manage per screen).
- Tests: database 4 (each part of a screen's life and its refusals; a swap all at once, refused whole when the spare is in repair; nothing edited; pausing and resuming an update, rolling back a paused one); API 2 (who may look and change; refusals as 400 / 409 with why); admin unit 3; browser 1 (a spare sent to repair from the page).
- Second-agent review: swaps and rider pay correct (one step, no gap, nothing half done); 8 findings, 7 fixed:
  - pausing an update switched off its automatic roll-back on rising crashes. Now a paused update never moves on but still rolls back by itself;
  - resuming started the crash count again from zero (pausing and resuming could keep a bad build forever). Now crashes are counted over the whole stage; only the 24-hour wait starts again;
  - any error without a database code came back as "400, your mistake" with internal text (a bug, a lost connection). Now only the rules' own refusals (`Refusal`) are 400s; everything else is a 500 and logged;
  - retired screens still counted in the 1% and 10% shares. Now left out;
  - spares that cannot be fitted (no valid certificate, or reported lost) were counted as stock. Now shown apart;
  - the spares share is a named setting (`DEFAULT_STOCK_RULES`); a confusing variable renamed.
  - Kept: Operations admins may pause and roll back the fleet's update (recorded in DECISIONS, from the approved Screens design: ops and tech).
- Tests after the review: database 2 more (crashes while paused roll it back; crashes before a pause still count after the resume).
- Open: renewing a screen's certificate from this page (the certificate authority adapter, with the warehouse tools); a screen reported lost or stolen (revoked key) shown as such; releases are added by the release pipeline (P7), not from this page.
- Next: P3.5, areas (draw and edit shapes, edge zone, versions, overlaps; on/off by a super admin).

## 26 Oct 2026 · P3.3 · Fleet map
- P3.2 merged (PR #47).
- **Records** (`packages/db/src/fleet.ts`, read only): `fleetScreens` (every screen: moving / stopped / offline / at hub by the Today rules, last position within 24 hours, bike and rider, player version, open alerts), `screenDetail` (route for the last 2 hours, latest health, fittings, command log), `freshCommands` (commands issued in the last few seconds and not answered).
- **Gateway**: every 5 seconds sends commands just issued to their screens, so a screen with its line open gets one within seconds, not at its next hello (up to 15 minutes).
- **API** (`services/api/src/fleet-api.ts`): `GET /fleet` (screens, areas sold now, the commands staff may send), `GET /fleet/screens/<id>`, `POST /fleet/screens/<id>/commands` (Operations admin, with a reason; logged with who before it goes; the fitting check is left to the fitter's app).
- **Admin site**: the Fleet map page (MapLibre 6): filters by state, area and plate; bikes coloured by state (moving in volt); click a bike on the map or in the list for its panel: rider, last heard, area, alerts, health in words (battery, temperatures, signal, storage), its route drawn on the map, send a command, command log, fittings. Refreshes every 30 seconds. Without a base map setting it shows plain ground with our areas and bikes; without WebGL it says so and the list still works. MapLibre's worker is served by the site (copied at build).
- Tests: database 4 (states, positions only from the screen and dropped after a day, open alerts; route and fittings; commands just issued for the gateway, within a minute; the same command twice is one); API 3 (a second click returns the first command) (who may look and who may send; refused commands, values, reasons and screens; areas and commands for the map); admin unit 4 (filters, areas from positions, health in words); browser 1 (the list, a bike's panel, a command sent and shown as waiting, no page or console errors).
- Second-agent review: no security holes found (access, forgery, inputs, page scripts all checked); 9 findings, 8 fixed:
  - a command whose request took over a second, or made on a clock a little behind, could miss the quick send (it still went at the next hello). Now the gateway looks back a whole minute and remembers which ids it already sent;
  - gateway runs could pile up when the database is slow. Now one run at a time, and none after stopping;
  - a double click sent a command twice (a screen could restart twice). Now the button waits, and the same command for the same screen within 30 seconds is the first one again (checked under a lock, so two clicks at once are one command);
  - the map and Today read every report a screen ever sent to find its latest. Now indexed (migration 0028); one screen's panel reads that screen only;
  - a mistyped map setting could take the whole admin site down. Now ignored (plain map); only https styles are used; the page rules no longer allow blob workers.
  - CI found the API and gateway would stop if the database dropped an idle connection (a restart, a failover). Now it is logged and replaced. Test databases ignore the connections cut when they are dropped.
  - Left for Prateek: Operations read-only members can see riders' ids and their last 2 hours of route. Fine for the team; to decide before outside viewers (an auditor) get Operations.
- Open: the gateway's quick send is covered by the database test and code review, not yet by the broker test; positions come only from live reports (the box sends them with its uploads); at thousands of bikes the map needs clustering and the list paging (P7 load test); area names in the list and clicking an alert on Today to open its bike (P3.4/P3.5).
- Next: P3.4, screens (stock, fitting, health, repairs, swaps, update rollouts).

## 26 Oct 2026 · P3.2 · Today
- P3.1 merged (PR #46).
- **The rules** (`packages/domain/src/today.ts`): where each screen stands now (moving, stopped, at hub, offline), which business day the page shows (between 2 and 8 am, the one that just ended), the week from Monday India time, and hours sold vs delivered (delivered never above what was promised, in tenths of a bike-hour). Limits are settings (`DEFAULT_TODAY_RULES`).
- **From the records** (`packages/db/src/today.ts`, read only): `fleetNow` (screens, fittings, latest position, last heard), `hoursSoldToday` (paid, not-cancelled lines and their counted plays by the rules they were sold on), `makeUpsOwed`, `refundsThisWeek` (waiting / approved / rejected, with GST and top-ups), `alertsNow` (open alerts with the bike each screen is on).
- **API** `GET /today` (`services/api/src/today-api.ts`): any signed-in member; each part only when their areas cover it (bikes and alerts: Operations; hours and make-ups: Sales or Operations; refunds: Finance, Sales or Operations; super admin: all).
- **Admin site**: the Today page (tiles for bikes and hours, tables for make-ups and alerts, refunds by decision), refreshed every minute, India time, rupees with Indian grouping (`lib/format.ts`).
- Tests: domain 5 (each screen state, the day shown at 1:30 am / 5 am / 8 am, Monday start, a sample day's hours; property: delivered never above due, never negative); database 5 (a sample day: 3 paid lines, a cancelled and an unpaid one left out, 900 of 1,000 plays = 4.5 bike-hours; a make-up owed until its window ends; refunds this week by decision with GST and a top-up, last week's left out; bikes moving / stopped / hello only / silent / not fitted / taken off; open alerts with the bike); API 3 (each role sees its parts; an empty business shows zeros; 401); admin unit 3 (rupees match the domain's money rules for any amount; India time); browser: Today shows every part to a super admin.
- Open: the page reads each line's plays one by one: fine for the POC (a few hundred lines a day), to be summed in one query before thousands of bikes (P7 load test). Clicking a bike or alert to open its screen (P3.3 / P3.4). Area names instead of ids once the Areas page exists (P3.5).
- Next: P3.3, the fleet map.

## 25 Oct 2026 · P3.1 · Staff sign-in and roles
- P2.13 + P2.14 merged (PR #45). P3, the admin portal, starts here.
- **Roles** (`packages/domain/src/staff.ts`): super admin (everything; the only one who manages staff), admin with ticked areas (Sales, Ad review, Operations, Finance, Support), read-only (looks at ticked areas). One table, `can()`, answers every request on the server. `moneyRole()` gives the money code its 'super-admin' / 'finance' role.
- **Records** (migration 0027, `packages/db/src/staff.ts`): staff, every access change (who, why), invites, credentials, every sign-in try, sessions and their ends. All append-only. Access changes are checked again inside the database transaction, from the stored access.
- **The API service** (`services/api`, first real code): sign in / out, who am I, invites, and the super admin's staff routes. Secrets (`secrets.ts`): scrypt passwords, TOTP codes (RFC 6238, tested on its official values), AES-256-GCM for stored two-step secrets, random tokens kept only as hashes. `staffFor(req, need)` is how every later admin route checks who is calling. `first-admin` makes the first super admin on a new server.
- **The admin site** (`apps/admin`, Next.js 16): sign-in, invite (QR code for the authenticator app), Today (placeholder for P3.2) and Staff (add, change access, reset, switch off, with reasons). Security headers (content rules, no framing, no referrer: invite links carry their token after #).
- Tests: domain 9 (roles, limits, sessions); API unit 11 (RFC codes, one use only, hashing, encryption, caller address); API database 24 (account stopped after 10 wrong codes and opened by a server reset; 2 checks at once per address; the whole journey over HTTP: first super admin, invite, sign-in, add admin, admin/read-only refused, locks per address, per-address limit, the same code twice at once, idle and 12-hour ends, sign-out, access change, reset, switch-off, invites expiring, a reset landing mid sign-in, a malformed request); admin unit 3; browser end to end 2 (invite → sign-in → add an admin → sign out, in Chromium, with the page's script code checked; the pass-through refuses large bodies and odd paths; now in CI).
- Second-agent security review: 13 findings, all fixed:
  - one malformed request could stop the whole API. Now refused, and nothing in the error path can throw;
  - a sign-in racing a reset could keep a session. Now the slow password check runs outside the database transaction and the result is recorded under the staff lock after reading everything again; sessions older than the latest access change or reset are refused;
  - password checks held database connections (10 at once could stall admin). Now outside transactions, at most 4 at a time;
  - answers were faster for real, locked accounts; anyone could keep a member out with one wrong try every 15 minutes; everyone behind one proxy shared a limit. Now locks count per email and address (unknown emails too), IPv6 by /64, and the number of our proxies must be set in production;
  - invite tokens were in the address (server logs). Now after #, sent by POST; the code that confirmed an invite cannot sign in; control characters refused; an unreadable secret counts as a wrong try; invites made before a switch-off stay dead; session reads use the app's limited database role.
- Second review of the fixes: all confirmed; 9 more found, 8 fixed:
  - with a stolen password, many addresses could share out guesses at the code. Now 10 right-password-wrong-code tries from anywhere stop the account until a super admin resets it (or `reset-staff` on the server, if no super admin can sign in);
  - a blocked address still used the shared password-check queue. Now it does no work, and one address holds at most 2 places;
  - without a load balancer the caller's address cannot be trusted. Production now refuses to start without one counted (`API_PROXY_HOPS` ≥ 1); the API stays private;
  - the admin site read a whole request before checking its size. Now refused over 16 KB as it reads;
  - an address with a port escaped the limits. Now the port is dropped;
  - pages allowed inline scripts. Now each page gets a fresh script code (nonce) and only scripts carrying it run;
  - the invite token stayed in the browser's history. Now wiped once read;
  - a try that started during a lock counted as a new wrong try. Now logged as locked.
  - Left as is: timestamps come from each server's clock. A clock difference of more than a few seconds would only make a fresh session ask to sign in again; the servers keep time by NTP.
- Open: sending invite links by WhatsApp or email (adapters, P6; for now the super admin passes the link on); the audit log page (P3.16) will read these records; Today (P3.2).
- Next: P3.2, the Today page.

## 25 Oct 2026 · P2.14 · Fitting check
- **What it checks** (`packages/domain/src/fitting.ts`, shared cases `test-vectors/fitting.json`): a technician starts it from the rider app (P4) as a `fitting-check` command (30–600 seconds). The box shows the colour bars (every part of the panel can be seen lighting up) and watches for its best GPS fix; at the end it reads the 4G line, the camera and the battery and sends a fitting report through its outbox.
- **The cloud judges each part itself** (`fittingVerdict`): GPS fix within 50 m, line up, camera answering, battery at least 50% or charging. Ready only when every part passes; a part the box cannot check (the camera, until the hardware) is "unknown" and never passes. Each check is kept with its verdict (migration 0026, `packages/db/src/fitting.ts`); the latest says whether the bike is ready (`latestFitting`).
- **On the box** (`Fitting.kt`, `Remote.kt`): the check runs on its own thread; the GPS service gives the accuracy of its latest fix; the line, battery and (later) camera are read at the end. App 0.12.0.
- Tests: TypeScript 3 (each part, unknown never passes, refusals); database 2 (a passing check makes the bike ready, a later failing one takes it back; a fitting check needs its time); Kotlin 2 (`FittingTest`: the cloud's cases, best fix rounded up, a failing probe is unknown). Kotlin core 139.
- Open: the rider app's screens to start it and confirm the pattern (P4); the camera link with the hardware (P2.9).
- Next: P2 is done apart from P2.9 (people counter, needs the hardware sample). Next phase by the plan: P3, admin.

## 25 Oct 2026 · P2.13.2–P2.13.3 · Player updates: releases, rollout, installing on the box
- **Releases and rollout in the database** (migration 0025, `packages/db/src/updates.ts`): each release is the new build and its rollback build; the rollout's life is its events (started, advanced, finished, rolled back, replaced), append-only. `updateFor` decides what a screen is offered when its line opens: the new build if it is in the current stage and older, the rollback build if it runs a release that was rolled back, else nothing. `driveRollout` (a worker every few minutes) moves the stage on or rolls back by the rules (P2.13.1), judging crashes and screen-hours per version from the health reports.
- **Health reports now carry** the player's version code and the box's crash count since it was set up (kept across restarts): that is how a rollout is judged.
- **Sent by the gateway** with the hello reply (`down/update`), like commands.
- **On the box** (`Updates.kt` core and app): takes only a version above its own; downloads over HTTPS on its own thread, carrying on after a cut; checks size and SHA-256; installs through Android's package installer as device owner (nobody taps anything); Android restarts the player. A version that keeps failing is given up after 3 tries until a newer one comes. Leftover files of older versions are removed. App 0.11.0.
- Tests: TypeScript shared update cases (`test-vectors/updates.json`); database 3 (first stage only, never to a screen on it or newer; holds then advances; rolls back on rising crashes and offers the rollback build); Kotlin 5 (`UpdatesTest`: the cloud's cases, newer only, resumed downloads, wrong files thrown away and given up after 3 tries, oversized files refused). Kotlin core 136.
- Second-agent review: nothing could install a file the cloud did not offer or that does not match its fingerprint; 14 gaps found, all fixed:
  - a version crashing before it can send health was never rolled back. Now the hello carries the version code; a version whose screens connect but send no health for 2 hours rolls back; admin can roll back by hand (`rollBack`);
  - a rolled-back build stopped being answered once a newer release came. Now a screen on any rolled-back build always gets its rollback build;
  - health from players before 0.11 (no version code or crash count) was refused. Now accepted;
  - a weak link made the box give up on a version. Now only a wrong file or a refused install counts as a failed try;
  - a failed install left its copy behind (up to 200 MB each). Now abandoned at once, and leftovers at start;
  - downloads ignored free space and old partial files stayed. Now 300 MB is always left free, and other versions' files go;
  - only crashes in Java code were counted. Now Android's own record of why the player ended counts native crashes and freezes too, written safely;
  - a minute reported twice counted twice; one faulty box could roll back a release; a small fleet could stall at 1% with nobody in the stage; two releases added at once could both run. All fixed (at least 2 screens per stage, crashes from at least 2 screens, one release added at a time);
  - an older offer still downloading is never installed once a newer one came; the install result goes to an explicit receiver.
- Tests after the review: TypeScript 10 (`updates`); database 5 (rollback still answered after a newer release, silent version rolled back, by hand); Kotlin `UpdatesTest` 6. Kotlin core 139.
- Open: the release pipeline in CI that builds each release and its rollback build and publishes both to storage (P7); a worker running `driveRollout` and admin screens to start a rollout (P3); trying an install on the real box hardware.
- Next: P2.14, the fitting check.

## 25 Oct 2026 · P2.12 · Remote commands
- **What a command is** (`packages/domain/src/screen-commands.ts`, shared cases `test-vectors/screen-commands.json`): reboot, blank, unblank, test pattern (5–600 seconds), brightness (1–100, or automatic), send logs, clear cache. Each has its own id and may be carried out for at most an hour. The box's answer (done, refused, failed, with a note; for send-logs the end of its log) is a new report kind through the outbox.
- **Logged in the database** (migration 0024, `packages/db/src/commands.ts`): `issueCommand` logs who sent it and why before it goes; `pendingCommands` (not answered, not expired); answers stored from uploads; `commandLog` gives admin the list with how each ended (done, refused, failed, waiting, expired).
- **Sent by the gateway** with every hello until answered (the box says hello when its line opens and every 15 minutes); admin will also send at once (P3).
- **On the box** (`Commands.kt` core, `Remote.kt`): each id is kept on storage before anything is done, so a command sent again (or a reboot) never repeats; expired or future-dated ones are refused; without a trusted time a command waits for its resend. Blank and test pattern cover the ads, and nothing shown under them counts; a blank stays after a restart until unblanked. A commanded brightness overrides the automatic one (P2.10) until set back. Reboot is answered first, then the box restarts as device owner. App 0.10.0.
- Tests: TypeScript (commands read back, 15 refusals shared with the box, answers checked); gateway database test (sent with every hello until answered, logged with its answer, expired ones not sent); Kotlin 6 (`CommandsTest`: the cloud's cases, once only across restarts, expired / ahead / unreadable / failed, waiting without time, reboot answered first, logs printable). Kotlin core 128.
- Second-agent review: 12 findings, all fixed:
  - a spot already showing when a blank or test pattern came still counted. Now playback asks, when each spot ends, whether the screen was covered at any moment of it (and the screen reports the spot in front at once);
  - a reboot could repeat on every reconnect if storage was full (the done list not kept). Now nothing is done unless the id is safely kept;
  - a reboot could be answered "done" and then "failed". Now the box checks it can reboot first, answers once, then restarts;
  - a commanded brightness skipped the safety limits. Now it stays within them (never over 35% at night, never under 60% by day) and changes smoothly;
  - one bad command row could stop the hello's time reply. Now the time never waits on commands, bad rows are skipped, and the database checks each command's value;
  - an old blank could undo a newer unblank on reconnect. Now only the newest of blank/unblank (and of brightness) is sent;
  - the blank was not surely on storage before "done"; a failed unblank was not noticed. Both fixed;
  - a command names its screen, and a box refuses one for another screen;
  - the done list is never pruned by a clock that could be wrong; a failing action (even out of memory) is answered "failed"; only the end of the log is read; covered spots do not count as faults in health.
- Tests after the review: Kotlin 131 (`CommandsTest` 7, `ConductorTest` blank mid-spot, `BrightnessTest` commanded limits); gateway 8 (newest blank/unblank only).
- Also in this PR, **P2.13.1, the rollout rules** for player updates (`packages/domain/src/updates.ts`): 1% → 10% → all, each stage after 24 hours with at least 20 screen-hours; rolls back by itself when the new version crashes more than 0.05 times a screen-hour, or twice the old version's rate (3 crashes or more before enough hours). Android never installs an older version, so each release comes with a rollback build: the last good code numbered above it. Tests: 7.
- Open: admin screens to send commands and read the log (P3); the panel's own controls (blank, brightness, test pattern on the LED sending card) with the hardware.
- Next: P2.13.2, the cloud's release records and rollout, then P2.13.3, installing on the box.

## 25 Oct 2026 · P2.11 · Health
- **What a health report holds** (`packages/domain/src/screen-health.ts`, a new report kind in the screen's outbox): the minute, app version, time since start, battery charge, charging and temperature, the box's temperature, free storage, mobile signal, LED fault, tamper, clocks disagreeing, and the box's counters (spots not counted, plays not stored, messages refused, GPS seconds missed, ads missing). Unknown readings travel as null. Checked strictly like every report (no extra fields, ranges).
- **Alerts** (`healthAlerts`, settings `DEFAULT_HEALTH_RULES`): overheating (box ≥ 75 °C, battery ≥ 55 °C), low battery (≤ 15%, not charging), tamper, LED fault, low storage (< 500 MB), and no contact for 30 minutes.
- **In the database** (migration 0023, `packages/db/src/health.ts`): each report stored (`screen_health`, by time); alerts as events, raised and cleared (`screen_alert_events`, append-only). A report that arrives late is kept but changes no alert. Any upload or hello clears "no contact"; `raiseSilentAlerts` (to run every minute from a worker) raises it once per silence. `openAlerts` lists what is open, for the admin health view (P3).
- **On the box** (`Health.kt`, `BoxHealth.kt`): once a minute by the trusted time: battery from Android, the processor's temperature where the system shows it, free storage, signal strength, and the player's counters (playback now counts spots not counted and ads missing). LED fault and tamper come with the panel hardware. App 0.9.0.
- Tests: TypeScript shared health cases (`test-vectors/health.json`) and refusals; database 4 (alerts raised and cleared, late reports, bad reports set aside, silence raised once and cleared); Kotlin 3 (`HealthTest`: the cloud's cases, sensors gone wrong, one report a minute). Kotlin core 122 in all.
- Open: a worker to run `raiseSilentAlerts` every minute and send alerts to the operations team (WhatsApp/SMS adapters, P6); LED fault and tamper with the panel hardware; the health view in admin (P3).
- Next: P2.12, remote commands.

## 25 Oct 2026 · P2.10 · Brightness
- P2.9 (people counter) waits for the screen hardware sample (its AI chip), so P2.10 came first.
- **Brightness** (`Brightness.kt` in `apps/player/core`, `ScreenLight.kt` on the box): once a second, from the sun's height over Hyderabad and the light sensor (where the box has one).
  - Without a sensor: 100% by day, 30% at night, smoothly between at dusk and dawn.
  - With a sensor: never under 60% by day (a covered or dirty sensor cannot hide the ad), never over 35% at night (a headlight on the sensor cannot make it blinding).
  - A passing headlight is ignored (the lower middle of the last 10 seconds); the screen changes at most 5 points a second, never a flicker. A sensor that stops is no longer followed after 10 seconds.
  - The panel is set through one call (`Panel`): today the Android display's brightness; with the hardware, the LED sending card's own control. App 0.8.0.
- Tests: Kotlin 6 new (`BrightnessTest`: the sun at noon, midnight, sunrise and sunset in Hyderabad; with and without a sensor; limits; smoothing and headlights; a stopped sensor; unsafe settings refused); 116 core tests in all.
- Open: the LED sending card's SDK (with the hardware sample); remote "set brightness" comes with P2.12.
- Next: P2.11, health.

## 25 Oct 2026 · P2.8 · GPS service
- **P2.8.1 Minute summaries and live positions** (`Minutes.kt`): the box's copy of the cloud's `addSecond` (P1.2.4): every minute, seconds at each place, seconds the moving-hour clock ran (and where, and inside the pay zone), seconds moving, distance, plays; a live position every 30 seconds. Rider pay comes from these minutes, so they match the cloud's exactly: the shared ride now also lists its 40 live positions, and the box matches all 22 minutes and 40 positions.
- **P2.8.2 The GPS loop** (`GpsLoop.kt`) and the service on the box (`Gps.kt`):
  - the GPS chip reports about once a second; each reading also sets the box's clock from GPS time (until the cloud answers);
  - once a second by the trusted clock: the reading is cleaned and smoothed (the tracker, P2.6.1: poor fixes and jumps dropped, area held 15 s, moving-hour stopwatch, 10-minute stop rule); the area goes to the local scheduler (what to play, and where each play happened); minutes and live positions go to the outbox;
  - an old reading (over 1.5 s) is no reading; seconds the box missed are stepped without a fix; a clock jump over 2 minutes starts afresh; the clock going back never does a second twice;
  - plays recorded are added to the minute they are recorded in;
  - the player gives itself location permission and turns location on, as device owner. App 0.7.0.
- Tests: Kotlin 9 new (`MinutesTest` 2, `GpsLoopTest` 4: the shared ride read like a real chip gives the cloud's minutes, missed seconds, clock back and jumps, old and missing readings, plays per minute); 110 core tests in all. TypeScript: the shared ride's live positions.
- Prateek confirmed the pay zone: 15 km around Hitech City (the cloud can still send a new zone as a setting later).
- Second-agent review of P2.8: no mismatch with the cloud found; 11 findings, fixed except where noted:
  - after a long GPS gap the smoothing mixed old and new positions, adding distance never ridden (one test minute reached 3.2 km and was refused, with its pay). Now, on the cloud and the box alike, smoothing starts afresh after a gap of over 10 seconds;
  - a clock pulled far back (a wrong GPS time corrected by the cloud) stalled areas, minutes and pay until real time caught up. Now a jump of over 2 minutes either way starts afresh at once;
  - plays saved up during a stall could get a minute refused. Now a minute holds at most 60 plays (cloud and box), and saved-up plays are dropped on a jump;
  - the minute in progress was lost at every power cut (up to a minute of pay each time the bike is switched off). Now it is kept on storage every 10 seconds and goes on or out after a restart, never twice;
  - GPS never started if location permission came after the app started. Now it tries again every 30 seconds, and a refused grant is recorded;
  - a reading delivered late was taken as fresh. Now freshness is from when the fix was taken;
  - a reading could be lost between threads. Now taken once, safely;
  - the shared ride now also tests the money paths against the cloud: a pay zone the ride leaves, plays, and the long gap; live positions are compared value by value;
  - not done: the tracker rules and pay zone are the box's own defaults until the cloud sends them as settings (open below); area ids are already capped at 48 (P2.7); plays recorded before GPS starts are not in minute counts (only an estimate, never billed).
- Tests after the review: Kotlin 119 in all (`GpsLoopTest` 6, `MinutesTest` 3).
- Open: the tracker rules and the pay zone are the box's own defaults until the cloud sends them as versioned settings (and the box reports which version it uses, P2.11); a real GPS test on the emulator (`adb emu geo fix`) and on the panel hardware; people counter (P2.9).
- Next: P2.9, the people counter (needs the hardware sample for the AI chip), or P2.10 brightness first if the sample is not here.

## 25 Oct 2026 · P2.7 · Signed play log
- **Every counted play is signed on the box and kept until the cloud has it** (`PlayLog.kt` in `apps/player/core`).
  - Which plays: only the ones playback counts (P2.5): shown by trusted time, from start to end, confirmed on screen, a real ad, never counted before.
  - The record is the one the cloud already checks (P1.5, `packages/domain/src/plays.ts`): what played (brand line, make-up, aggregator or RECALL), the ad, start and length, where the bike was (position, accuracy, area), people (0 until P2.9).
  - Signed with the box's play key, made at enrolment inside the Android Keystore (the private half never leaves it), over exactly the cloud's bytes, including the record's number in the outbox. The outbox (P2.3) keeps it on storage until the cloud confirms; if the outbox ever renumbers, the play is signed again for its new number.
  - Signing and saving run on their own thread: the next spot is never held up.
  - The latest counted spot is saved to storage before its record, and read back at start: a restart (or a clock going back) never counts a spot twice. A power cut at the wrong moment can lose one play, never add one.
  - Where the bike was: the local scheduler remembers the tracker's last 2 minutes, second by second. No GPS fix: the record says so honestly, and the cloud keeps it without counting it.
- **A gap from P2.6 fixed**: plans only allowed short line ids, but the cloud names lines `BK-0007/hyd-madhapur/2026-11-02/18` (make-ups `…#1`). Both sides now accept these, so a play names its line exactly as the cloud counts it. Shared cases updated with real ids and new refusals.
- **On the box**: the line starts the outbox and play log as soon as it has the screen id, even if the secure line cannot open yet; playback hands every spot to the play log. App 0.6.0.
- Tests: Kotlin 7 new (`PlayLogTest`: the cloud's own cases and signatures, signed for its number and re-signed on renumbering, only counted plays recorded, failures counted, bad records never signed, the mark across a restart, positions); 101 core tests in all. TypeScript: shared play cases (`test-vectors/plays.json`, generator `packages/domain/scripts/play-vectors.ts`), 4 tests. The people-count guard now lists the box's play record (it carries the signed count, never billed).
- Second-agent review: 9 findings, nothing blocking; all fixed except one test gap (below):
  - a faked GPS date years ahead, saved as the last counted spot, would have stopped every later play from counting, even after a reboot. Now the mark is brought back as soon as the cloud's own time is known;
  - a play only got a position if GPS had a fix in exactly its first second. Now the nearest good fix within 5 seconds is used;
  - renumbering the outbox could lose reports if signing failed half-way. Now everything is signed first; a failure changes nothing and is tried again;
  - a keystore hiccup lost a real play. Now it is tried 3 times before it is given up (and counted);
  - a lost play key would have quietly made a new one the cloud does not know. Now signing never makes a key: it fails loudly;
  - plays counted just after a boot, before the play log started, were dropped. Now the play log starts first, and up to an hour of early plays wait for it;
  - area ids are now at most 48 characters (database), so a line id always fits the 120 a plan and a play allow;
  - more tests: retries, the mark saved before the record, renumbering when signing fails, the nearest fix, the mark pulled back. Kotlin core now 104.
- Open: GPS service (P2.8) feeds positions, and must number seconds by the trusted clock; people counter (P2.9); health counters for spots not counted and plays not stored (P2.11). Test gap: no test yet sends a report written by the Kotlin side through the cloud's own checks (today the box's report is checked field by field against the cloud's cases).
- Next: P2.8, the GPS service.

## 25 Oct 2026 · P2.6.3 · Local scheduler: the box chooses what to play
- **The local scheduler** (`LocalScheduler.kt` in `apps/player/core`): keeps what the cloud sends (P2.6.2) and answers playback's question for any moment (P2.5): which plan, and what this bike carries.
  - The area is the one the tracker settled on (P2.6.1, with its 15-second hold): inside an area or in its edge zone. Outside every area: RECALL's own ads.
  - In an area-hour with the cloud's assignment, the bike carries that (the newest for that area-hour; a bike coming back into an area carries the same again, as in the simulator). Without one, the box's own pick (P1.4.3).
  - Plans: per area-hour the highest revision. Ended hours are dropped by the cloud's own message times, never the box's clock.
  - Everything is kept on storage: a box that starts with no signal still knows its areas, plans and assignments. Refused messages are counted for the health report (P2.11).
- **On the box** (`Schedule.kt`): starts with the line's setup (it needs the screen id), from storage at once; the line hands it the three messages; playback asks it what to play.
- Tests: 5 new (`LocalSchedulerTest`): the box's own pick in an area with a plan, the edge zone, no plan; the cloud's assignment winning (newest only) and coming back with the bike; plan revisions; everything kept across a restart and ended hours dropped; refused messages counted. All 88 core tests pass.
- Second-agent review of P2.6.2 and P2.6.3: 10 findings, all fixed:
  - a large plan message being saved could hold up playback, so a spot started late and a brand lost a counted play. Now playback reads a finished copy and never waits;
  - the edge zone: the cloud only assigns bikes inside an area, and edge plays count only up to a share. Now a bike in an edge zone carries the area's booking only if it was inside that area earlier this hour (steady along a border); a bike that just stays near an area plays RECALL's ads (DECISIONS);
  - the shared cases never tested a choice between several make-ups or aggregators for RECALL's spots, several make-ups or trials for a bike, a line with no bikes, the after-midnight hours or a re-sent plan. Now they do, with all the missing refusals; the generator is kept in the repository (`packages/domain/scripts/screen-plan-vectors.ts`);
  - the box read some odd number forms the cloud refuses (`TRUE`, `78.4f`, `.5`, a leading zero) and refused some it takes (`1.0`, `1e12`). Now both take and refuse exactly the same;
  - an area version too large for the box: now capped on both sides;
  - plans kept on storage could grow past what the box reads back after a restart. Now ended hours go by the newest cloud time seen, the count is capped and the saved file is checked when written;
  - a message dated far ahead (a cloud clock fault) could freeze every later list. Now one dated more than 5 minutes ahead of the trusted time is refused and counted;
  - an assignment naming a line the box's plan does not know (a newer revision on its way) played nothing. Now that part falls back to the box's own pick, and it is counted;
  - plans must start exactly on the India hour their date and hour name;
  - every message is capped at 1 MB on both sides.
- Tests now: TypeScript 6 (`screen-plan`), Kotlin 93 in all (the scheduler 8: also the edge zone, unknown lines, messages dated ahead).
- Open: the GPS service that feeds the tracker every second is P2.8 (until then the box counts as outside every area and plays RECALL's own ads); the cloud sending areas, plans and assignments (on every change and every hello) comes with the scheduler service.
- Next: P2.7, the signed play log.

## 25 Oct 2026 · P2.6.2 · Local scheduler: what the cloud tells the box, and the box's own pick
- **Three new messages from the cloud** (`packages/domain/src/screen-plan.ts`, Kotlin `PlanMessages.kt`, shared cases `test-vectors/screen-plan.json`), each on the screen's own down topics:
  - `areas`: the city's area shapes in force now (corners, edge zone, on/off). The whole list with its time; the newest wins.
  - `plan`: the hour plans for the next 2 hours, every area (P1.4.1), without brand names. Per area-hour the highest revision wins (a make-up opened re-sends it).
  - `assign`: the cloud's live pick for this screen in one area-hour (P1.4.2): the booking line and what fills RECALL's spots, or nothing (RECALL's own ads). Per area-hour the newest wins.
  - Hours must start on a half hour (UTC), ids are plain letters, digits, dashes; the cloud's builders refuse anything the box would refuse, so the cloud cannot send a message the box drops.
- **The box's own pick** (`Fallback.kt`, P1.4.3): the cloud's formula in Kotlin (weighted rendezvous hashing on the screen's id and the hour): paid lines by bikes sold; make-ups and trials only without paid lines; RECALL's spots to make-ups owed, else aggregator ads. Every screen picks by itself, yet over the fleet each booking gets bikes in proportion, with no network.
- Tests: TypeScript 4 (the shared cases, every refusal, the builders' refusals, the topics). Kotlin 3: the same messages read the same, the same 30 refusals for the same reasons, and the same pick as the cloud for 200 screens on 4 plans (paid, make-ups only, trial only, nothing sold). All 83 core tests pass.
- Open: the cloud sending these (plans 2 hours ahead, the live assignment every minute, all of them again on every hello) comes with the scheduler service; the box keeping and using them is P2.6.3.
- Next: P2.6.3, the local scheduler on the box.

## 25 Oct 2026 · P2.6.1 · Local scheduler: the area from GPS on the box
- P2.5.2 merged (PR #38, all checks green, the playback checks passing on the Android 11 emulator).
- P2.6 is split in three: P2.6.1 the tracker on the box (this step); P2.6.2 the messages from the cloud (hour plans, area shapes, the live assignment) and the box's own offline pick; P2.6.3 the local scheduler that tells playback which brand to show.
- **The tracker on the box** (`Tracker.kt`, `Areas.kt`, `Geo.kt` in `apps/player/core`): the cloud's reference (`screen-tracker.ts`, P1.2) in Kotlin. Every second: GPS cleaned (poor fixes and impossible jumps dropped, smoothed over 3 fixes), the area (inside, edge zone, outside; the nearer edge wins) with the 15-second hold, moving (above 5 km/h over 30 s; a 10 s window wakes it), and the 10-minute stop rule (the moving-hour clock pauses). The same rules as the simulator and the cloud's re-checks.
- Tests: the 1,300 shared seconds (`test-vectors/screen-tracker.json`: a ride through areas with GPS gaps, poor fixes, jumps and resets, stops and the 10-minute rule) match the cloud second by second: verdict, position to 1 cm, area, moving, standby, clock. Plus time order, fixes for their own second, areas that are off. All 80 core tests pass.
- Open: reading the real GPS chip and the minute summaries come with P2.8 (GPS service); the area shapes reach the box in P2.6.2.
- Next: P2.6.2.

## 25 Oct 2026 · P2.5.2 · Playback: the screen
- P2.5.1 merged (PR #37, all checks green).
- **The screen** (`Screen.kt` in the Android app): two full-screen layers. The next spot loads behind the one showing (a video is opened and its first frame drawn, a picture decoded), and at the spot's second the back layer comes to the front and the video starts, so the swap takes a frame: no gap, no black. Pictures fill the spot; videos play without sound; a video shorter than the spot holds its last frame. Each spot is confirmed only once it is really on screen (P2.5.1 counts only confirmed spots). A file the player cannot read is reported as the file's fault and downloaded again (P2.4). The slate is RECALL's wordmark on midnight.
- **Picture or video** (`MediaKinds`, core): ad files carry no name (stored by fingerprint), so the first bytes decide: PNG, JPEG, WebP are pictures, anything else goes to the video player.
- **Playback on the box** (`Playback.kt`): starts with the player's screen, spots on the trusted clock, ads from the ad store, the plan from the local scheduler when it comes (P2.6; until then RECALL's ads or the slate). Played spots are logged for now (signed log: P2.7). Video player: Media3 ExoPlayer (Google's). App version 0.5.0.
- **Proven on the Android 11 emulator in CI** (new, before the kiosk checks): video, picture, video, slate, video, each loaded 2 s ahead, each confirmed on screen within 150 ms of the swap; a broken file reported as the file's fault, and the screen carrying on.
- Second-agent review: 11 findings, all fixed:
  - (high, money) a spot whose first frame came late (a slow box) still counted. Now a spot confirmed more than half a second after its swap is reported as a late start and does not count;
  - box problems were blamed on the file, so a good file could be deleted and downloaded again over 4G, or loop forever if the box cannot play it. Now only file errors count as the file's fault, and the store checks the fingerprint again before deleting: intact files are kept and counted as unplayable on this box;
  - a layer still loading, or whose file failed, could show another brand's last frame. Now it shows the slate;
  - closing the screen while a spot was loading could crash the app. Now the screen ignores work after it is released;
  - a late "first frame" signal from a previous video could confirm the next one. Now each video spot gets its own player;
  - audio is no longer decoded at all;
  - spots are confirmed after the next screen draw, not before;
  - the main-thread check runs before anything is built;
  - the emulator check warms up the video decoder first, keeps the emulator's display awake, and reports setup failures clearly;
  - stopping playback never holds up the screen;
  - a tidy-up in the build file.
- Tests: core 2 new (picture or video by first bytes; a file the player cannot play is dropped only when really damaged); 77 core tests pass. Emulator 2 (`ScreenTest`). Test media in `app/src/androidTest/assets` (a 3-second video, a picture, a broken file; 50 KB in all).
- Open: the plan and what the bike carries (P2.6); signing and keeping plays and the "latest spot counted" mark across reboots (P2.7); the real panel and its controller when a sample comes (open question).
- Next: P2.6, the local scheduler.

## 25 Oct 2026 · P2.5.1 · Playback: what plays when
- P2.4 merged (PR #36, all checks green, the Android app built in CI).
- P2.5 is split like P2.3: P2.5.1 decides what each spot shows and when (plain Kotlin, tested on any computer); P2.5.2 puts it on the screen without gaps (Android, proven on the emulator).
- **The spot rules on the box** (`Spots.kt`): the cloud scheduler's `spotAt` in Kotlin: 240 spots an hour, one RECALL spot after every 5 brand plays (200 + 40), the brand's ads in turn, RECALL spots to the make-up or aggregator ad the bike carries, else RECALL's own. Checked against new shared cases (`test-vectors/spots.json`: every spot of an hour for 6 kinds of carry), which the cloud's code also passes.
- **What shows now** (`Playout.kt`): spots follow the trusted clock on a 15-second grid (hours start on :00 or :30 UTC, both on the grid), so the pattern holds after a restart or a slow file. Only a checked file on the box is shown. A planned ad whose file is not here: a RECALL ad that is here plays instead and the play says so (the brand is not counted; make-ups cover it), else the slate. No trusted time: RECALL ads in turn, never counted. No plan for the time: RECALL ads.
- **Keeping time** (`Conductor.kt`): the next spot is loaded 2 s before it starts and shown on its second. The trusted time is read again for every spot: a correction of a whole spot or more joins the spot of now part-way; a small step back waits for the second. A spot joined part-way is marked "not whole" and never counts. Every spot shown is handed on for the signed play log (P2.7); a problem reported by the screen marks it not ok, and a bad file goes back to the store to be downloaded again. Playback runs on its own thread and starts again after any failure.
- **When a play counts** (for the signed play log, P2.7): shown by trusted time, from its first second to its last, the screen confirmed it started and reported no problem, an ad (not the slate), and no spot at or after that time counted before.
- Second-agent review: 10 findings, all fixed:
  - (high) a clock moved back by more than one spot could count the same spot twice. Now a "latest spot counted" mark is shared across restarts of playback (P2.7 will keep it on storage);
  - (high) a spot cut short by stopping playback was counted as whole. Now it must run to its end;
  - a problem found while a spot was loading, or no word from the screen at all, still counted. Now the screen must confirm each spot;
  - the time disappearing between two reads could crash playback. Now it is read once per spot;
  - a broken plan froze the screen. Now it is treated as no plan (RECALL ads);
  - a long wait after the clock moved back held a frozen frame. Now RECALL filler plays, never counted;
  - spots after the time was lost were still marked as timed. Now they are not;
  - the cloud's and the box's spot rules differed for negative spot numbers. Both refuse them now;
  - spot lengths that do not fit half an hour, and plans off the 15-second grid, are refused;
  - the restart loop itself is guarded against failing.
- Tests: TypeScript 4 (the shared cases, the 200/40 pattern, negative spots refused, no RECALL ads). Kotlin 15: the shared cases and the 240/40 counts; a whole hour on the second (240 spots, 200 brand, 40 make-up, ads in turn, each loaded ≥ 2 s ahead, all counted); starting part-way; stopping part-way; missing files (RECALL ad, then slate; counted once); no trusted time then time arriving; clock jumps both ways; a clock moved back 40 s with no spot counted twice, also after a restart; RECALL filler during a long wait; the time flickering and going away; screen failures while showing and while loading, no confirmation, bad files; a broken or off-grid plan; no plan; the next hour's plan; the thread restarting. All 76 core tests pass.
- Open: the screen itself (P2.5.2); the plan and what the bike carries come from the local scheduler (P2.6); signed plays (P2.7); health counters (P2.11).
- Next: P2.5.2, the screen.

## 25 Oct 2026 · P2.4 · Ad storage on the box
- P2.3.3 merged (PR #35, all checks green).
- **The list** (`packages/domain/src/ad-files.ts`, Kotlin `AdFiles.kt`, shared cases `test-vectors/ad-files.json`): the cloud tells each screen which ad files to keep on a new topic `…/down/files`. Each entry: the ad, the file's SHA-256 fingerprint, its size (up to 64 MB), an HTTPS link, and keep-until (the end of the last booking using it, at most 400 days ahead). Each list is the whole list and carries the time it was made: an older list is ignored, and anything left off is no longer needed. Links must be HTTPS and plain ASCII; one file cannot be listed with two sizes. The cloud's builder refuses anything the box would refuse.
- **The store** (`AdStore.kt`): downloads ahead over HTTPS, one file at a time, into a `.part` file; a download cut short by weak 4G carries on from where it stopped (range request) and is saved every 4 MB. Only a file whose size and fingerprint match is renamed into place, so a power cut never leaves a half file that looks finished, and only such a file is ever handed to the player (never a stream). Files found at start are checked again before they are played. A wrong file is thrown away and counted; failed downloads wait 1 minute, doubling up to 1 hour (not when it got further: that is just weak signal).
- **Space**: ads use at most 4 GB and always leave 512 MB free. Ended files stay (a renewed booking needs no new download) until room is needed; then files no longer listed go first, then those that ended longest ago. A file still needed is never cleared: the new download waits and "no room" is counted. "Ended" is judged only by the cloud's time, or the last cloud time the box saw (kept across power cuts).
- **On the box**: a downloader thread (`AdDownloader.kt`) checks the files at start, downloads when a list comes, and every minute anyway. The line hands lists over (`ScreenLine` `onMessage`); `Ads.kt` holds the store for playback (P2.5). An ad-store problem never stops the line. App version 0.4.0. The safe-write helpers moved from the outbox to `DiskFiles.kt` (same behaviour).
- Second-agent review: 12 findings, all fixed:
  - a list could never shorten a booking or drop a pulled ad, and a wrong date could lock storage for good. Now: whole list with its time; keep-until at most 400 days ahead;
  - before the cloud's time arrived after power-on, ended ads were downloaded first and nothing could be cleared. Now the last cloud time is remembered;
  - a weak link that makes progress was given ever longer waits. Now progress means no wait;
  - files found at start could be played before they were checked. Now they are not;
  - a phone's automatic unzipping could spoil resumed downloads. Now the plain bytes are always asked for;
  - the TypeScript and Kotlin rules differed on rare links. Now both use plain ASCII;
  - one file with two sizes is refused;
  - an ad-store failure no longer stops the line;
  - refused lists are counted, not written to the crash log;
  - counters are safe across threads;
  - downloads are saved every 4 MB.
- Tests: TypeScript 4 (shared cases, topic rules, the builder's refusals, a property test that every list reads back exactly). Kotlin 24 new: the shared cases (3); the store (15: download and check, resume, server ignoring resume, wrong or too-big file, waits, keep-until and clearing order, never clearing a needed file, no-time rules, the last cloud time after a restart, whole-list rules, shared files, restart with damaged files, half download across a restart, player-reported damage, ended entries forgotten); real HTTPS (4: whole and resumed downloads, a server ignoring the range, refusing plain HTTP, an unknown certificate, a redirect to HTTP, an error); the downloader thread (1); the line hand-off (1). All 61 core tests pass.
- Open:
  - the cloud side that sends the list (on every change and in reply to every hello, so a box that was offline or whose links expired gets fresh ones) comes with the hour plan (P2.6), along with signed storage links;
  - health reporting of `badFiles`, `noRoom`, `cleared`, refused lists (P2.11);
  - "clear cache" command (P2.12).
- Next: P2.5, playback.

## 25 Oct 2026 · P2.3.3 · Screen line: the box's side
- P2.3.2 merged (PR #34, all checks green, including the real-broker test).
- **The line on the box** (`ScreenLine.kt` in `apps/player/core`): one thread keeps it open by itself. It connects over TLS, listens on its own topics, says hello (the cloud's answer sets the box's clock), sends the oldest unconfirmed reports from the outbox one upload at a time, forgets them on the cloud's ack, sends an unacked upload again after 30 seconds, says hello again every 15 minutes, and after a drop tries again with growing waits (P2.3.1 backoff). Reports past 7 days are given up only by the cloud's time, never by GPS alone.
- **The handshake** (`LineTls.kt`): the box shows the certificate from the warehouse and proves its key, which stays in the secure store (the handshake asks the store to sign). It trusts only RECALL's broker authority, not the public list, and speaks TLS 1.2/1.3 only. MQTT client: Eclipse Paho (plain Java, same on the box and in tests).
- **Android**: keys in the Android Keystore (`AndroidKeyVault`); the line starts with the player (`Line.kt`) from files written at the warehouse (`files/line/`: screen id, broker address, certificate, broker authority; runbook step 6). A line that cannot start never stops the screen. App version 0.3.0.
- **Proven against a real broker** (`ScreenLineBrokerTest`, in the CI player job): EMQX with the production settings in Docker, the box's code with its own key over TLS: hello and the cloud's time, five reports acked, the broker restarted, the box back by itself, three more reports acked.
- Found on the way: a broker still starting refuses its first subscriptions (as in P2.3.2), so the stand-in cloud in the test retries like the real gateway; a broker key file must name its curve (PKCS#8).
- Second-agent review: 7 findings, all fixed:
  - (high) if a box's outbox is lost while its keys survive, its numbers start again at 1; the cloud takes them as repeats and drops them, and the box re-sent in a tight loop. Now an ack beyond any number the box gave renumbers the waiting reports after it (on disk, safe across a power cut), counted for the health report;
  - the line starts in the background (a box back after days offline no longer freezes at boot);
  - the cloud's time is stamped when it arrives, and only the answer to the last hello is used;
  - an upload sent 5 times without an ack raises a "stuck" flag for the health report;
  - several authorities in the broker file are all trusted (for a change of authority), and certificate chains are sent whole;
  - nothing, not even an Error, ends the line's thread quietly;
  - a box whose key does not match its certificate says so instead of failing every handshake.
- Tests: 7 line logic (fake broker: hello, time, uploads acked, resend until acked, refused connections and drops, stop, renumbering, an old time reply ignored, the stuck flag) + 1 real broker + 1 outbox renumbering. All 37 core tests pass.
- Open: the warehouse tool that writes `files/line/` by itself comes with P2.14; GPS time with P2.8; the line on the Android emulator is not yet exercised (the core is the same code).
- Next: P2.4, ad storage.

## 25 Oct 2026 · P2.3.2 · Screen line: the broker and the gateway
- P2.3.1 merged (PR #32), and the vendor questions for ready-made screens are saved in `docs/OPEN_QUESTIONS.md` (PR #33).
- **Broker settings** (`infra/emqx/emqx.conf.template`, filled by `renderEmqxConfig`): screens connect only over TLS with a certificate from our screen authority (both sides checked, TLS 1.2/1.3). On that port the user name is the certificate's fingerprint, so a box cannot choose it. The gateway uses an internal port with a password. Every connection and every topic is decided by the gateway; anything not allowed is refused.
- **Who may connect** (`packages/db/src/screen-line.ts`, `screenMayConnect`): the certificate must be one we issued to this very screen (its name and fingerprint), in date, not revoked (`revokeCertificate`, new), and the screen not reported lost or stolen. No TLS, no line.
- **Which topics** (`services/gateway/src/hooks.ts`): a screen only its own topics (P2.3.1 rule); the gateway reads every screen's up topics and writes their down topics. The broker must show a secret token to ask; a wrong token, bad request or error is a refusal.
- **What the gateway does** (`line.ts`, `gateway.ts`): a hello is answered with the cloud's time and kept as the last contact; an upload is stored with `storeUpload` (P1.2.5, unchanged) and answered with "stored up to N"; an upload refused whole is recorded and not answered (the box keeps it). Several gateways can share the work.
- Migration 0021: certificate revocations, hellos, refused uploads (append-only).
- **End to end on a real broker** (new CI step in the database job): EMQX 5.8 in Docker with these settings, the gateway, and enrolled boxes. Proven: a box gets the time, uploads, every report stored once even when sent twice; no line without a certificate, with a stranger's certificate, under another box's name, on the internal port with a copied fingerprint, or as the gateway with a guessed password; a box cannot listen to or send as another box (the broker drops its line); a revoked certificate is refused.
- First trial found that EMQX does not escape line breaks when passing a whole certificate, so the fingerprint is used instead.
- Second-agent security review: no way found to pass as a box without its key, or as the gateway without its password. Fixed from it:
  - (high) a box revoked or reported lost while connected kept uploading. Now its certificate is checked again on every message and subscription; the broker drops its line at its next message;
  - the broker's cluster ports now stay on the machine itself; secrets (hook token, node cookie, gateway password) must be at least 32 characters;
  - limits per box (5 messages a second, 512 KB a second); the gateway handles 16 messages at once; a hello or refusal is recorded at most once a minute per box;
  - screens may not leave retained messages on the broker;
  - strong encryption only (forward secrecy, authenticated ciphers).
- Found by CI: a broker still starting refuses the gateway's first login, and the MQTT library never tries again after a refusal. The gateway now tries again every 2 seconds (reproduced with a broker that refuses the first login, then fixed), and retries its first subscription too. The end-to-end test gives up on each setup step after a minute and prints the broker's and gateway's logs.
- Found by CI next: on a slow machine the broker lost the hook's "allow" for the gateway's subscription, and the MQTT library silently skipped the retries. Reproduced here by giving the broker a third of a CPU. Now the gateway (password, internal port only) is the broker's superuser, so its topics never depend on the hook; retries really resend. All 6 end-to-end tests pass on the slowed broker too (boxes' checks included).
- Tests: 3 database (who may connect, revoked and lost, hellos and refusals) + 4 gateway unit (topics, secrets, settings) + 6 gateway database (hello, upload once, refused upload, hooks over HTTP, recording limit, checked again on every message) + 6 end to end (incl. revoked while connected, retained messages, cluster ports).
- Open: the laptop broker (docker compose) still runs without TLS for development; the production deployment uses this template (P6). When certificate renewal is built, the old certificate must be revoked. For P2.3.3: acks can arrive out of order (the box keeps the highest; the outbox already does), and the box must send unconfirmed uploads again on a timer, not only on reconnect.
- Next: P2.3.3, the player's side (the line on the box with its key in the secure store, hello and time, uploads from the outbox, reconnects).

## 25 Oct 2026 · P2.3.1 · Screen line: messages, outbox, clock, reconnects
- P2.2 merged (PR #31, all checks green, kiosk proven on the emulator).
- P2.3 is split in three: **P2.3.1** the message format and the box's own logic (this entry), **P2.3.2** the cloud gateway (EMQX over TLS that lets in only certificates we issued; stores messages and acks them), **P2.3.3** the Android wiring (the line itself, GPS time).
- **Message format** (`packages/domain/src/screen-link.ts`, Kotlin `ScreenLink.kt`, shared cases `test-vectors/screen-link.json`): topics per screen; the upload is the one from P1.2.5, unchanged (numbered reports + the oldest number held; the cloud answers "stored up to N" and stores with `storeUpload` as before); a hello when the line opens and the cloud's time in reply. What the cloud refuses whole (too big, over 500 reports, wrong fields, a report without a number); a bad report inside is set aside alone, as before. `topicAllowed` is the rule the gateway will enforce: a screen sends only on its own up topics and listens only on its own down topics.
- A first draft used a new numbering scheme; it was dropped for the existing P1.2.5 one (no silent re-decision).
- **Outbox** (`Outbox.kt`, the box's side of P1.2.5 `enqueue`/`nextBatch`/`oldestHeld`/`acknowledge`): every report is written to storage (and synced) before it is sent; it stays until confirmed; a restart keeps it and leaves no gap; a number that ever left the box is never reused; a forged ack beyond what the box holds is ignored; a line cut off by a power cut, or damaged, is skipped (each line carries a checksum); a write that fails half-way is cut back, costing no number; an upload never goes over the cloud's 256 KB limit. Given up only after 7 days (judged by a time the cloud backs, so a faked GPS date cannot wipe it) or beyond 256 MB, oldest first, so what the box holds stays one unbroken run and `oldestHeld` tells the cloud exactly what is lost; counted for the health report.
- **Clock** (`TrustedClock.kt`): GPS time and the cloud's time (half the round trip as doubt); runs on the monotonic counter between readings; the one with less doubt wins; if they differ by more than 10 s the cloud wins and it is flagged. Unknown until heard.
- **Reconnects** (`Backoff.kt`): 1, 2, 4 … 60 s, random in the top half, starts over after a line that stayed up a minute.
- Second-agent review (outbox, clock, format): 9 findings, all fixed: a failed write could later let a number be used twice; a half-failed append could leave memory and disk out of step; no byte limit per upload; a future-dated report could wipe the outbox; a later-damaged line could stall uploads; field names like "at,report" could pass the check; reboots showed as lost reports; folder not synced after renames; a reading from before a restart of the counter.
- Tests: 4 TS (shared cases incl. trick field names, topic rules incl. wildcards and other screens, size and batch limits, property: every upload reads back exactly) + 20 Kotlin (shared cases; outbox order, 500 per upload, 256 KB per upload, restart without gaps, numbers given up never reused, failed write, forged acks, cut-off and damaged lines, 7 days and space, faked dates, a 3,000-step random run with restarts never losing or repeating a report; backoff; clock incl. counter restarts).
- Kiosk fix found by the emulator check on this PR: after a crash Android's own handler waits for a "has stopped" box nobody answers on a kiosk, and the watchdog's restart landed in the half-dead process (frozen over 5 s). Now the player and the watchdog write the crash down and end their process at once; the watchdog starts a clean one.
- Open: reports need a time, so a box that has heard neither GPS nor the cloud since power-on makes no reports yet (P2.7/P2.8 decide how to show this). A box whose app data is wiped loses its keys too and must be enrolled again, so its numbers never restart under the same screen id.
- Next: P2.3.2, the gateway.

## 25 Oct 2026 · P2.2 · Kiosk mode and watchdog
- P2.1 merged (PR #30, all 6 checks green including the new Kotlin job).
- **Android app** (`apps/player/app`, Android 11+): the player is the box's device owner and its home screen. Every start it sets the box rules: only the player may run (lock task), no status bar, no lock screen, no factory reset, no safe mode, no new users, no USB files or SD cards, no clock changes; release builds also close the debugging port. Screen kept on, full screen.
- **Watchdog** in its own process: checks the player's heartbeat every second and starts it again when it stops: within 5 seconds; after 3 quick restarts in 10 minutes, pauses grow (5, 10, 20, 40, 60 s) and the restarts are marked as a crash loop for the health report (P2.11). Every crash and restart is written to a small log on the box. The rules are in `core` (`Watchdog.kt`) and tested there.
- **Proof on an emulator** (CI job "Screen player"): builds the app, runs Android lint, starts an Android 11 emulator, makes the player device owner, checks it is on screen and locked, that the home button stays on it, and that after a forced crash it is back within 5 seconds and the crash is logged.
- Warehouse steps: `docs/RUNBOOKS/screen-setup.md`.
- This sandbox cannot download Android's build kit, so the Android app is built and tested on GitHub's runners only; `core` builds anywhere.
- Tests: 4 Kotlin (watchdog: alive left alone, back within 5 s, growing pauses and crash loop, crashes spread out never a loop) + the emulator checks.
- Open: the real box may need its vendor's way to set the device owner (some boards ship with it pre-set for their own app); checked on the sample unit.
- **Next: P2.3** connection: MQTT over TLS with the screen's certificate, reconnects, clock from network and GPS, store-and-forward.

## 25 Oct 2026 · P2.1 · Screen identity, enrolment and fitting
- P1.10.1 v2 merged (PR #29); P1 complete. Answered Prateek's hardware question (components, specs, what the sample unit is for) in chat.
- **Screen id and QR** (`packages/domain/src/screen-identity.ts`): `SCR-` + 7 random letters/digits + a check character (Crockford base32, Luhn mod 32: every single wrong character is caught). QR sticker text `RECALL1:SCR-…`. Number plates read in one form (state series and Bharat series).
- **Enrolment at the warehouse** (`enrolScreen`): the box makes two keys in its secure store (secure line, plays) and sends a request signed with both; the cloud checks it is fresh (±10 minutes) and that both signatures are good, gives a screen id, a 2-year certificate for the secure line from our certificate authority (new `device-ca` adapter; fake CA on the laptop, a key store in P6), and records the play key. A box is enrolled once.
- **Fitting** (`fitScreen`, `unfitScreen`): the rider app's QR scan links screen → bike (number plate) → rider; one screen per bike, one per rider; a screen with no valid certificate or reported stolen cannot be fitted; rider pay follows in the same step (`rider_screens`). Migration 0020 (`screens`, `screen_certificates`, `screen_fittings`, append-only).
- **Player** (`apps/player`, Kotlin): first Gradle project; `core` holds the same screen id, QR, plate and enrolment rules, passing the same shared cases (`test-vectors/screen-identity.json`) as the cloud. New CI job "Screen player (Kotlin)".
- Review by a second agent (security) found 4 real problems, all fixed with tests: the same key could be enrolled on two screens, letting one box sign plays for two ids (now a key belongs to one screen in one role; unique in the database); two enrolments of one box at once could both get a certificate (now one at a time, certificate and records in one step); rider pay could be moved without the fitting (now an enrolled screen moves only by fitting); one bike could pass in two spellings, TS9EA1234 and TS09EA1234 (now the district always has 2 digits and the number 4; a 0 is not a plate; plates without series letters are refused as ambiguous). Also: a same-moment change gives a clear message; the fake CA uses random 64-bit serials and key identifiers; Kotlin and TypeScript now trim and drop exactly the same characters (new shared cases), and a request signed by the Kotlin code is checked by the cloud's code.
- Tests: 3 domain (shared cases, property: any wrong character caught, request checks), 1 adapter (certificate for the box's own key, signed by the CA), 9 database + 1 unit (enrol once; stale or wrongly signed refused; fitting rules and same-scan-again; stolen or unknown screen refused; records can't be changed; the review cases), 4 Kotlin.
- Open: the enrolment and fitting web endpoints come with the API service (P3/P4): the rider id must come from the signed-in rider, never from the scan. The MQTT gateway (P2.3) must accept only certificate serials stored here, not anything the CA signed. The Android Keystore key vault comes with the Android app (P2.2). The Gradle wrapper's download checksum is to be added from a machine that can reach gradle.org.
- **Next: P2.2** kiosk mode (the player as device owner, starts on power-up, watchdog).

## 25 Oct 2026 · P1.10.1 v2 · Real roads in the simulator; final report at 48 hours
- P1.9 merged (PR #28). Prateek: the final report is built 48 hours after the last hour (setting changed from 24; plan and DECISIONS updated).
- **Real roads.** OpenStreetMap is blocked from the cloud sandbox, so a GitHub job (**OSM roads**, `.github/workflows/osm-roads.yml`) downloads west Hyderabad's roads (17.38–17.50 N, 78.31–78.48 E; roads a delivery bike uses, no footpaths) and commits them: 1,14,377 road points, 1,30,780 road pieces, 1 MB (`tools/simulator/data/`, © OpenStreetMap contributors, ODbL). Only the largest connected part is kept, so every trip has a way.
- The simulator now rides any `RoadMap`: the grid (version 1) or the real roads (`road-graph.ts`: shortest way by A* search, nearest road point, signals only where roads meet). `--roads osm|grid`; real roads by default.
- Results on real roads (1,000 bikes, 30 min): clock 96.3% of the truth (never over), area agreement 96.6%, every report stored once, none lost; 22 s, the same speed as the grid.
- Finding: on real roads bikes spread wider and vary more from day to day than on the even grid. Selling from another day's numbers delivered 97.3–97.5% of plays (99.9% on the grid); the rest goes to make-ups, which the forecast's 10% margin covers. Worth watching in the POC: the forecast may need a bigger margin in thin areas.
- Tests: 8 new (Overpass answer → road map; shortest way checked against a plain search on the real map; nearest point is truly nearest (property); signals only at crossings; fleet runs on both maps; scheduler on real roads). Scheduler proofs stay on the grid.
- Open: one-way streets ignored; trips spread evenly rather than around restaurants (tune with POC rides).
- **Next:** P1 is complete. P2.1 — the screen player on an Android emulator (Kotlin), following the plan.

## 25 Oct 2026 · P1.9 · Final campaign report
- P1.8 merged (PR #27).
- **P1.9.1 Built once, kept as built.** `buildDueReports`: a booking's report is built at least 24 hours after its last hour (a setting), and only once every line has had its last check: the day of its last make-up (same hour next day) has closed and the refund for missing plays has been proposed. In practice about 48 hours after the last hour. The clock moves the booking to *done* first. Migration 0019 `campaign_reports` (one per booking, never changed).
  - Contents: plays delivered vs promised (extras shown as a free bonus, never making up another hour), different bikes, heat map (H3 hexagons, about 0.1 km² each), busiest streets (street names for the busiest 40 hexagons through the new `maps` adapter; fake knows 16 main Hyderabad roads), make-ups, refund, people (approximate range).
  - Refund: exactly as proposed (with any top-up), "being processed" until the super admin decides, then "refunded".
- **P1.9.2 Shown and sent.** `services/workers`: the web page (Night Signal, works at phone width, all outside text escaped) and an A4 PDF (pdf-lib; the same file every time; "Rs." in the PDF because its font has no ₹). `sendDueReports`: WhatsApp (template with a link to the portal) and email (page + PDF), each channel once with a fixed key; passing failures tried again up to 3 times; wrong address given up; booking moves to *report-sent* once the report reached the brand. Brands with no contact and reports that reached no one are listed for staff. New `messages` adapter with a fake; brand contacts (`setBrandContact`, phone +91 or email, latest wins).
- Review by a second agent found 3 real problems, all fixed with tests: the report was frozen a day before the refund check, so late uploads could make its refund wrong for good (now built after every line's last check, showing the refund actually proposed); a wrong address could never be retried after staff fixed it, and a short outage used up all 3 tries in 3 minutes (now tries count per address, 30 minutes apart, and the address is part of the send key); a maps outage stopped every report (now it goes out without street names). Also: the headline counted extra plays from one hour against another hour's shortfall (now "what made the promise", extras shown separately).
- Tests: 7 domain, 3 database (full campaign end to end: due time, built once, refund, streets, people, done; sending with a failed email tried again 30 minutes later, each channel once, report-sent; a wrong address given up and a new one tried afresh), 4 workers, 2 adapters (page, PDF, unprintable text, heat map), guard test still holds.
- Open: the report page inside the brand portal comes with P5 (the link points there); real WhatsApp and email providers need accounts (WhatsApp also needs the template approved); the PDF uses a plain font until the brand fonts are added (P5).
- **Next:** P1.10 version 2 (real OpenStreetMap roads instead of the street grid), the last open part of P1; then P2.1 player on the emulator.

## 25 Oct 2026 · P1.8 · People counts
- P1.7.9 merged (PR #26); P1.7 marked Done in the plan.
- Already in place since P1.5: every play carries the number of people its screen faced while it ran, signed on the screen with the play, so it cannot be changed on the way.
- **P1.8.1 Only the number leaves the screen.** Each kind of report may carry only its own fields (`REPORT_FIELDS`); a report with anything else (a picture, say) is refused. What is kept of a refused report for staff to look at is now only its known fields, each text cut short, plus the names of any other fields. Before, up to 4,000 characters of the raw report were kept, which could have held part of a picture.
- **P1.8.2 Tied to the booking line.** `bookingPeople(bookingId)`: for each line, the people during the plays that count for it (inside its area; edge plays up to their 10% share) plus its make-ups' plays; plays signed with a key after it was given up are left out (same rule as play counting). A count above 150 for one play (a faulty chip) is taken as 150 and flagged.
- **P1.8.3 Shown as an approximate range.** `peopleEstimate`: ±15%, rounded outwards to two figures, in Indian words: 2,40,000 → "2.0–2.8 lakh people (approximate)". The exact count is never handed out. Range and per-play limit are settings in the price book.
- Never billed: a test fails if any file other than the counting and reporting ones reads a people count (hard rule 7).
- Review by a second agent found 3 problems, all fixed with tests: a report with an odd kind ("toString") crashed the whole upload and blocked the screen (now refused like any unknown kind); place names, field names and long texts of a refused report could still hold pieces of a picture (now only counts of places and seconds, 40 characters per text, 5 field names); line totals carried the exact people count into money code (removed; the guard test now scans every source file in the repository).
- Tests: 7 domain (refused fields, nothing of a picture kept, ranges, property: the true count is always inside the range and it is never wider than ±30%, the limit per play), 2 database (a line and its make-up with one faulty play; a report with a picture set aside and the picture not stored), 1 guard.
- Open: the chip itself and its counting model come with the screen player (P2); the minute summaries' people number is kept but not yet shown anywhere.
- **Next: P1.9** final campaign report.

## 25 Oct 2026 · P1.7.9 · GST and the books
- P1.7.7–8 merged (PR #25).
- Domain (`gst.ts`): financial years (April–March), document numbers (`RC/27-28/000001`, `CN/…`, at most 16 characters), GSTIN check (shape and check digit), CGST + SGST or IGST split, CSV files safe for spreadsheets (no formulas run), rupees with paise. Tax settings in the price book: RECALL's state (36, Telangana), e-invoicing limit (₹5 crore) and warning (80%).
- Database (migration 0018): `brand_tax_profiles` (legal name, GSTIN, state; latest wins) and `gst_documents` (every invoice and credit note, one per ledger entry, numbered under a lock so the series has no gaps or repeats; never changed).
  - A paid booking issues its tax invoice in the same step; an approved refund (and a top-up) issues its credit note in the same step.
  - `gstSummary(month)`, `accountantExport(month)`: invoice and credit-note registers, the full journal, the summary.
- Prateek (no CA yet, best practice): partner invoices recorded (`recordPartnerInvoice`, migration 0018 `partner_invoices`); their GST claimed back only with an invoice, never more than booked; service code 998365 on every document (a setting).
- Review by a second agent found 3 real problems, fixed with tests: a credit note took the brand's current GSTIN instead of its invoice's (now copies the invoice); several credit notes did not add back to the invoice's CGST/SGST (now split from what the invoice still has, and never beyond it); a leading tab could still start a spreadsheet formula (now escaped). Tax details are taken as they were at the moment of the invoice.
- Tests: 5 domain, 9 database (numbers; Telangana vs Maharashtra; credit note against its invoice, same customer and GSTIN after a change; two credit notes add back exactly; summary agrees with the ledger; missing tax details; partner invoices; export lines; documents can't be changed).
- Known: a refund on a booking with no invoice is refused (a refund needs an invoice to credit). Every paid booking gets one from now on; there are no older paid bookings anywhere yet.
- Open: the invoice PDF itself comes with the brand portal (P5). E-invoicing (IRN) goes behind an adapter when turnover nears the limit (P6). When a CA is appointed: confirm 998365, the 2% TDS on cuts and 1% on rider pay.
- **Next:** P1.7 is complete after review. Then the plan's next step.

## 25 Oct 2026 · P1.7.8 · Screen loan record
- Domain (`screen-loan.ts`): loan statuses that only move forward (applied → approved → disbursed → closed; or rejected; disbursed → defaulted → closed); EMI dates the same day each month (the last day of a shorter month); what the rider app shows: status, next EMI, EMIs left.
- Database (migration 0017): `screen_loans` (bank, amount, EMI, months, first EMI date) and `screen_loan_events` (each status the bank reports, who, when). `recordScreenLoan`, `moveScreenLoan`, `riderLoans`. Nothing here touches the ledger: loans and EMIs are never on RECALL's books.
- Tests: 3 domain, 3 database (including: no ledger entries at all).
- Open: RECALL's 5% first-loss deposit with the bank (₹1,830 a new bike, model v5.2) is RECALL's own money and will be booked with P1.7.9.
- **Next: P1.7.9** GST and books (monthly GST summary, invoice and credit-note registers, export for the accountant).

## 25 Oct 2026 · P1.7.7 · Monday payout run
- P1.7.5–6 merged (PR #24).
- `packages/adapters`: the first adapter, `payouts` (bank or UPI), with a working fake: same key → same answer (never pays twice), failures and pending on request.
- Database (migration 0016): payout accounts (latest wins), runs, lines (amount and destination as prepared), approvals, every try. All append-only.
  - `preparePayoutRun(monday)`: brings rider pay up to date, then lists each rider's amount owed (less what earlier runs are still paying); riders with no account listed apart.
  - `approvePayoutRun`: finance or a super admin, once, not the person who prepared it.
  - `sendPayoutRun`: pays through the adapter; one sender at a time; retries up to 3; a wrong account is given up and shown; a paid line moves the money from "owed to the rider" to the bank in the ledger. Safe to call again.
  - `payoutRunStatus` for admin.
- Tests: 3 adapter, 13 database (only on its Monday; the week's amounts; no account; approval rules; paid once, retried, given up; next Monday picks up what was not paid; an unpaid run is never listed twice; ledger balances; account checks).
- Review by a second agent found 5 real problems, all fixed with tests (`payouts-edges.test.ts`):
  - A run could pay more than a rider was owed after a late correction. Now each line is checked against what he is owed when it is sent; if he is owed less, the line is cancelled and the right amount goes in the next run.
  - A run could not be cancelled, so its money was stuck. Now finance can cancel what is left of a run (`cancelPayoutRun`); the money comes back in the next run.
  - Pending payouts counted as tries. Now only failures count; a pending one is asked again and never given up by itself (it may already be paid).
  - A provider that did not answer stopped the whole run and the try was not kept. Now it is kept as pending (same key next time) and the other riders are still paid.
  - The run hung with a one-connection pool. Now all its work goes through one connection.
  - Also: a rider whose pay could not be updated, and late changes in closed months, are shown to finance with the run instead of stopping it.
- Open: bank details are stored as entered; they will be encrypted at rest with the real servers (P7). Depositing TDS to the government comes with P1.7.9. A real provider may replay a first "failed" answer for the same key; the real adapter (P6) will retry with a new key only after the provider confirms the first one is dead.
- **Next: P1.7.8** screen loan record, then **P1.7.9** GST and books.

## 24 Oct 2026 · P1.7.5–6 · Rider pay and the business switch
- P1.7.4 merged (PR #23).
- **Business switch** (Prateek): `business-mode.ts` + migration 0015 `business_modes`. A super admin flips POC ↔ regular business (`setBusinessMode`); it counts from the start of that business day; one switch a day; append-only with who and why. Switching the POC on counts from the 1st of a month (so month 1 is full). The POC runs once: after it is switched off it can never come back (`canSwitch` tells the portal; after the POC it shows as a record, view only, to the super admin). Demo copy for investors (Prateek, 25 Oct): `markDemoCopy` (only an empty database) lets the super admin flip POC on and off freely there. The month the POC is first switched on is POC month 1. Rider pay follows it; the brand side will read it later.
- **POC pay** (model v5.2 table, Prateek):
  - Flat base ₹2,000 / ₹4,000 / ₹6,000 in POC months 1 / 2 / 3, earned day by day (`pocDayPaise`: a full month adds up exactly) for the Monday payouts.
  - Founding bonus each month (`pocMonthBonus`): full ₹6,000 at 150+ verified hours in the 15 km zone, in proportion from 100, none below. `pocBonusList(month)` for the portal; `givePocBonus` by a super admin once the month has closed, once.
  - ₹3,000 for finishing the POC and keeping the screen: `pocFinishList` (riders holding a screen when the POC was switched off), given by a super admin.
  - No sales share in the POC.
- **Regular business pay:** ₹25 a moving hour (capped at 260 a month) + 25% of what his plays sold. Only hours and plays under regular business count; a month with a switch in it has both parts.
- TDS 1% for now on all rider pay (a setting; CA to confirm).
- `soldShares`: a line's money shared by counted plays (each play = paid ÷ promised), never more than the line was paid. `countedPlays` split out of `lineTotals`, so pay and play totals count the same plays.
- `riderPayAccrued`: rider earnings, owed to the rider less TDS, TDS owed to the government; up or down by the difference. Bonuses are their own entries.
- Database (migration 0014): `rider_screens` (who rides which screen from when; one screen per rider at a time). `accrueRiderPay(month, now)`: safe to rerun; one rider failing doesn't stop the others.
- Review by a second agent found 3 real problems, all fixed with tests:
  - A last-day line's make-up plays the next day: its sales went to nobody if the screen changed hands after 03:00 on the 1st. Now riders are looked up for 2 days after the month, and a rider whose plays sold is always in the run.
  - Pay could go to riders with no screen that month. Now only riders who rode (or whose plays sold) are paid.
  - A closed month could still change. Now, once closed (48 h after the month), late changes are not posted; they come back in `late` for finance to settle by hand.
- A third review of the POC and the switch found 5 problems, all fixed with tests:
  - The finishing bonus was tied to the first switch-off even if the POC came back on: the POC now runs once.
  - A switch-on mid-month (or at 00:30 on the 1st) made a short month 1 and shifted the bases (₹16,000 instead of ₹12,000 over a Nov–Jan POC): the POC now always starts on the 1st.
  - A rider who handed his screen on at the exact moment of the switch got the finishing bonus: fixed.
  - The finishing bonus read the price book of the first regular month: now the last POC day's.
  - Migration 0014 was changed after it was pushed (it was never merged or run outside tests); its comment fixed. Months must stay open at least 24 hours (a switch reaches back to 08:00).
- Tests: 244 domain (property tests: a month's days add up exactly; the bonus never falls with more hours; shares never more than paid; pay entries always balance), 105 database (a demo copy; a POC week; a full month exact; a screen changing hands; bonus full / in proportion / none; given once, only by a super admin, only after the month closes; finishing bonus; the switch; ₹25/h + 25% sold; 260 h cap; a closed month stays closed; make-up sales after the month).
- Open (speed, before real volumes): the monthly run is one transaction with per-line queries; fine for the POC (200 bikes), to be split up before scale. A price book saved later with a back-dated start can change an unpaid month's rates: saving books will check this with the admin tools (P3).
- Open: POC brand package (₹2.5 lakh a month + GST, invoiced and paid before each month starts) on the brand side (P5) reads the same switch.
- **Next: P1.7.7** Monday payout run (finance approves, payout adapter with a fake, retries).

## 24 Oct 2026 · P1.7.4 · Review fixes: cuts and cancellation
A second agent reviewed cuts and the cancellation code. It found 4 real problems; all are fixed with tests:
- **A cut given late was never paid.** The hour close only looked at bookings settled in the last week. Now `giveCut` brings the cut in line at once (under the hour-close lock), and every booking with a cut is looked at.
- **Cuts were paid on money that was not delivered** (a late cancellation, a refund rejected). Revenue is now booked in two kinds: `line-earned` (delivered by plays) and `line-kept` (kept, not delivered). Cuts use delivered only.
- **An early-cancel refund nobody decided kept the money held for ever.** After 7 days (setting `cancelRefundDecideHours`) the system records it as rejected. Refunds for missing plays have no deadline.
- **A cut could be given on any booking.** Now it needs a paid booking that can still deliver (not a trial, cancelled or ads-missing), a rate of 0.01–50% and partner GST of 0–28%. The price book's cut rates are checked the same way.
- Also: if a cut fails during a refund decision, the decision still stands (the next close fixes the cut).
- Checked and fine: the 72-hour boundary, booking-id matching, no cut posted twice, and raising or lowering a cut.
- Tests: 226 domain, 92 database.
- Prateek answered questions 13 and 14 the same day: both money calls confirmed; TDS is held back from cuts; partner GST is claimed back; our rounding wins.
- **TDS on cuts:** setting `cutTdsBp` (2%, section 194H, CA to confirm the rate and any yearly threshold; until then held back on every cut, the safe side). The rate in force when the cut is given is kept with it (migration 0012).
- **Cuts include the partner's GST** (Prateek, later the same day): 10% of ₹1,200 = ₹120 in all = ₹101.69 + ₹18.31 GST. TDS on ₹101.69 (₹2.03) goes to `tds-payable`; the partner is owed ₹117.97; the ₹18.31 is claimed back (`gst-input`).
- Third review (top-ups and TDS): top-up GST could give back 1 paisa more than charged (fixed, test added); top-ups now recorded in `refund_topups` (migration 0013) with who, when and how many plays; refund proposal time comes from the run; cut and TDS rates from the price book in force when the cut is given.
- A second review of these fixes found no blocking bug. Fixed anyway:
  - Plays found fake after a refund was proposed: the credit note is now topped up at approval, so the brand pays only for what was delivered.
  - The 7-day deadline counts from when the refund was proposed, if that is later than the cancellation.
  - Deciding a refund that is already decided gives a clear message.
  - A cut error during a refund decision is returned, not hidden.
- Open (known): a stolen screen found after a line is fully closed changes nothing (closed lines are not reopened). That needs a 'reopen' step; for P3 admin tools.
- Open (known): the hour close now looks at every booking with a cut each run. That is fine for now; it should be narrowed once there are thousands.
- **Next: P1.7.5–7** rider earnings, payouts, TDS.

## 24 Oct 2026 · P1.7.4 · Cuts, and cancellation after payment
- Cancellation after payment (Prateek, answers open question 12; merged in PR #22):
  - No refund by default.
  - At least 72 hours (a setting) before the first hour, a full refund is proposed, which a super admin may approve.
  - Later than that, no refund is possible and the money is earned (`forfeited`).
- Cuts (Prateek):
  - Never automatic: a super admin gives a cut on a booking (once per kind), with the partner's GST rate.
  - `cutAccrued` keeps the cut at its rate of what the booking has earned, going down if earnings go down. The partner's GST is owed on top and recorded in `gst-input` (claimed back).
  - Default rates (agency 10%, aggregator 2%) are price-book settings.
  - Migration 0011: `booking_cuts`, `gst-input` account.
- Tests: 223 domain (property test: cut entries always balance and land on the target), 84 database.
- Open: input tax credit on partners' GST to be confirmed with the CA.
- **Next: P1.7.5–7** rider earnings, payouts, TDS.

## 24 Oct 2026 · P1.7.1–3 · The ledger: payments held, revenue earned, refunds
- P1.6 merged (PR #20).
- Domain (`ledger.ts`): accounts; `checkEntry` (balanced, whole paise, one side per posting, two or more postings); `reversal` (only for a person's adjustments); `balances` from postings; `bookingPaid`, `earnedPaise`, `lineEarned` (both ways), `refundApproved`.
- Database (migration 0009):
  - `ledger_entries`, `ledger_postings`, with balance checked at commit.
  - Writes only through `ledger_post`, so postings can't be added later and a reversal must mirror its entry. Append-only.
  - `postEntry` is idempotent. `accountTotals` and `trialBalance` are summed from the postings.
- Flows:
  - Paying a booking posts the advance (held + GST owed).
  - `closeEarnings`: per line, delivered share to revenue (and back when plays are found fake); entries numbered per line; one line failing doesn't stop the others.
  - `decideRefund` posts the credit note and settles the line in the same step.
  - Ads missing: everything is earned. Cancelled after paying: a full refund is proposed for sign-off.
- Cuts: Prateek decided they are given only when RECALL chooses, and then with their GST (recorded in DECISIONS and the plan).
- Second review found 5 issues, all fixed with tests:
  - paid bookings cancelled or forfeited kept money held forever;
  - reversing a closed line's entry left money stuck;
  - postings could be added to an old entry later;
  - one bad line stopped all earnings;
  - held went negative between a refund approval and the next close.
  Also: a refund rounding to ₹0 is not proposed; payment ids are checked.
- Tests: 219 domain (500-run property test: the ledger always balances), 81 database. The money walk: ₹1,500 paid → ₹1,350 earned → make-ups earn → stolen screen's revenue goes back → refund approved → held ₹0. Also covered: ads missing, cancelled after paying, a rerun at the same moment, hand-written rows refused, a non-mirroring reversal refused.
- Open:
  - `closeEarnings` re-reads each booking's lines per line (slow for 12-month deals with thousands of lines); cache before the load tests.
  - Open question 12 (cancellation refund policy).
- **Next: P1.7.4–7** cuts (when given, with GST), rider earnings, payouts and TDS; then P1.7.9 GST registers.

## 24 Oct 2026 · P1.6 · Make-ups and refunds
- P1.5 merged (PR #19).
- Domain (`makeups.ts`):
  - Make-up windows: the next 2 hours, never past 02:00; then the same hour the next day.
  - `nextSettlementStep` / `nextDecisionAt`: one decision at a time — hour end + 10 min, first make-up end + 10 min, then day close 24 h after the second make-up.
  - `refundPaise`: exact, rounds halves up, never more than paid. `discountShares`: shares add up exactly to the discount.
  - Settings live in the price book (`makeUps`).
  - Scheduler: `addMakeUps` re-issues a sent hour plan (revision + 1) when a make-up opens; a spare bike carrying a make-up plays it as a make-up.
- Database (migration 0008: `make_ups`, `line_settlements`, `refunds`, `refund_decisions`, append-only):
  - `settleDue`: one run at a time. Each line is decided on its own (one failure does not block the rest). Lines with nothing due are skipped cheaply. It returns the make-ups opened, so their plans are re-sent.
  - A booking's refunds never exceed its bill or its GST.
  - `makeUpsDue` feeds hour plans. `decideRefund` is for super admins only.
- Second review found 5 issues, all fixed with tests:
  - make-up plays from spare bikes never counted;
  - the first make-up could never reach the screens (plans go out 2 hours ahead);
  - a line once "delivered" was never re-checked after a stolen screen's plays stopped counting;
  - with odd prices, deal-discount rounding could refund 1 paisa more than paid;
  - the decision run re-read everything under its lock.
- Tests: 210 domain, 65 database. The database test walks a line through every stage: 100 short, make-up 7–9 pm (spots and spare bikes), late uploads shrink the next-day make-up, refund ₹37.50 + GST. It also covers: a full line, a trial (no refund), a stolen screen found after a full delivery (refunded at day close), three runs at once (nothing twice), super-admin-only approval, and no edits or deletes.
- Open:
  - Refund approval checks the role given by the caller; sign-in and roles come with the admin portal (P3.1).
  - Each make-up gets its own 10% edge allowance (as worded in DECISIONS).
  - The credit note and the payment back come with the ledger (P1.7).
  - The cloud service that builds and sends hour plans comes with the services step.
- **Next: P1.7** ledger, GST, cuts and rider earnings.

## 22 Oct 2026 · P1.5 · Play counting and proof
- P1.4 merged (PR #18).
- Domain (`plays.ts`):
  - A play record travels as a screen report (numbered, resent until confirmed). Its id is screen + number. The screen signs fixed bytes (one field a line, whole numbers) with ECDSA P-256.
  - `judgePlay`: refusals (bad signature, unknown or given-up key, overlap within 15 s); otherwise kept, with whether it counts and why not. The place is re-checked against the line's own published area.
  - `lineTotals`: inside plays, plus edge plays up to 10% of the promise; different bikes, minutes inside, people (estimate).
  - Play settings live in the price book. `publishedAt`: drafts are never in force (also fixed for bookings and suggestions).
- Database: migration 0007 (`screen_keys`, `screen_key_revocations` with `plays_until`, `plays` hypertable, unique per screen and start time, one play per report number, append-only). `storeUpload` judges plays on arrival. `addScreenKey` accepts P-256 only. `lineTotalsFor` uses the line's own price book.
- Second review found 6 issues, all fixed with tests:
  - totals changed when a later price book came in;
  - plays counted before ads were approved;
  - a draft correction of an area made plays count as outside, for good;
  - "…/08" and "…/8" split a line;
  - revoking a key lost the plays signed before the screen was lost;
  - no database backstop against a repeated play.
  Also fixed: an edge play inside a neighbouring area now counts for its line; a screen clock running ahead gives "kept, not counted" instead of losing the play; "minutes inside" counts inside plays only.
- Tests: 194 domain, 55 database (including a property test: uploads repeated, split and reordered store each play exactly once).
- Open:
  - The ad id is not yet checked against the booking's approved ads (comes with ad upload, P3).
  - Area versions and price books are re-read on every upload; cache them before the full fleet (P5 load tests).
  - Plays arriving after the final report still change the totals. Day close (P1.6.5) will freeze what is billed.
- **Next: P1.6** make-ups and refunds.

## 22 Oct 2026 · P1.4 · The ad scheduler
- P1.3.7 merged (PR #17). P1.3 done.
- `packages/domain/src/scheduler.ts`:
  - Hour plan (P1.4.1): paid → make-ups → trials for whole bikes; make-ups → aggregator ads for RECALL spots; RECALL's own ads last. 2–5 ads a booking (settings).
  - 240-spot pattern (P1.4.5): 200 brand plays, plus a RECALL spot after every 5. Only the carried brand's ads, in turn (P1.4.4).
  - Live assignment every minute (P1.4.2): tier by tier, a bike keeps its line while that line has a gap. Over-covered lines give bikes back. New bikes are preferred while a line is short of different bikes. A bike is counted on for 90% of its remaining plays (bikes leave), and spare bikes top up unfinished lines before playing RECALL ads.
  - Offline fallback (P1.4.3): weighted rendezvous hashing, FNV-1a plus a final mix. Test numbers are pinned for the Kotlin player. Make-ups come before aggregator ads here too.
- `tools/simulator`, scheduler proof (P1.4.7): a first pass measures what each area carried, a share is sold, then the hour is replayed with the scheduler, make-ups and an aggregator. Command: `pnpm --filter @recall/simulator schedule -- --bikes 15500`.
- Results at 2,000 bikes, seed 7:
  - 90% sold, cloud assigning: 19 of 19 lines fully delivered; make-ups owed 3,260, delivered 3,260.
  - 100% sold: 21 of 21.
  - Sold from a different day's numbers (as the real forecast does): 99.9% of plays; 3 lines about 1% short, which make-ups cover.
  - No network all hour: 98.6%.
- At 15,500 bikes, 90% sold, with make-ups owed (5%) and an aggregator, final version: cloud assigning, 133 of 133 lines fully delivered (521,200 of 521,200 plays); no network all hour, 98.9% of plays (104 of 133 lines in full; the rest go to make-ups). About 7.5 minutes per run on one laptop core.
- Second review found 8 issues, all fixed with tests:
  - make-ups and trials could keep bikes a paid line needed;
  - a make-up delivered in spots kept its bikes;
  - over-covered lines never gave bikes back;
  - the "different bikes" promise was dropped once plays were covered;
  - the offline split was 10–20% off its weights (hash fixed: now within 1%);
  - at the last spot, all free bikes piled onto one line;
  - offline spots ignored "make-ups first";
  - the simulator was too kind (perfect forecast, no make-ups, re-entering bikes changed brand).
- Tests: 181 domain (26 scheduler, including a property test), 13 simulator.
- Open:
  - In the simulator the cloud sees counted plays at once. Real counting (P1.5) arrives with delay.
  - With no network all hour and make-ups owed, aggregator ads get no spots that hour.
- **Next: P1.5** play counting and proof.

## 22 Oct 2026 · P1.3.7 · Selling only what an area can carry (after the POC); 6-month deals
- Bookings merged (PR #16). Prateek's rules recorded: drafts reserve nothing; RECALL's 40 spots go make-ups → aggregator ads (free) → RECALL ads; drafts always paid at current prices; POC needs no forecast.
- 6/12-month deals reworked: lines at list price; one discount on the bill on Peak and Normal hours only; hours spread about equally over the months (±20%). Migration 0005 stores the discount.
- `supply.ts` (domain): sellable bikes = level reached in 4 of the last 5 same weekdays (smaller of different bikes and bike-hours), less 10% for make-ups; starting estimate before 4 weeks of history; nothing sold blind. Offers: what fits now + suggestions (nearby areas, next hours, other days). Mode `poc` (manual limits only) or `forecast` in the price book.
- Database: migration 0006 (`area_supply_estimates`), history read from the screens' minute summaries (India time, 23:00–02:00 on the right business day), `forecastLimits`, `offerForRequest`; bookings, holds and the move to payment use the forecast after the POC.
- Prateek's example tested end to end: Madhapur 6–7 pm carries 150, A pays for 100, B asking 100 gets 50 there and Hitech City 6–7 pm (50) / Madhapur 7–8 pm (50) suggested.
- Second review found 5 issues, all fixed with tests: weeks when no bike came were read as "no history" (so the starting estimate oversold; now they count as 0, and history starts when the fleet first reported and the area was on); a minute stored twice counted twice (now at most 60 s per bike, minute and area); a deal offer could take a band below the ₹220 floor (price book now refused); suggestions offered the same free bikes twice (now each suggestion uses up what it offers, and never the request's own hours); history read the whole city for 6 weeks on every sale (now only the hours asked for). Also: a deal's months count from its first day (25 Jan → 24 Feb …), and today never counts as a past week.
- Tests: 155 domain, 42 database.
- Open (small, later): suggestions use areas as they are today and do not check the 15-day lead time (the booking itself still checks both).
- **Next: P1.4** the ad scheduler (with the 40-spot order).

## 22 Oct 2026 · P1.3 (part 2) · Bookings in the database, and review fixes
- `packages/db` migration 0004: `price_books` (versioned), `bookings` (with the hold they came from), `booking_lines` (area version and price kept), `booking_events` (each step a new row), `trials_used`, `holds`, `hold_lines`, `area_hour_limits` (versioned). Append-only; `recall_app` insert/read only. Bookings and holds are checked one at a time; limits are checked again when a draft becomes a sale (a test caught two drafts both taking the last limited bikes).
- Second review found 6 issues, all fixed with tests: another brand's hold could be used (now only the hold's brand, while it lasts); a hold that became a booking was counted twice; 6/12-month offers on a one-day booking (now every month must have hours); short-notice ad approval (after the deadline only staff, with a reason; a late payment is always recorded); trial loopholes (blank phone, GST with spaces: now must be valid); no upper limit on bikes. Also: areas checked on each line's own day; forfeited bookings (ads missing) free their bikes; a draft from before a price change, or a portal draft now inside 15 days, cannot go to payment.
- Tests: 140 domain, 34 database.
- Open: how long a payment link (awaiting payment) may hold limited bikes — to set with the payments step (P1.7); open question 12 (refund on cancellation).
- **Next: P1.4** the ad scheduler (hour plan, live assignment every 60 s, offline fallback, one brand per bike per hour, the 240 spots, priority order, simulation proof).

## 22 Oct 2026 · P1.3 (part 1) · Prices, quotes, booking steps, holds, free trial
- Database work merged (PR #15). P1.1–P1.2 marked Done.
- `packages/domain`: `price-book.ts` (Peak ₹300 / Normal ₹250 / Lite ₹220, 200 plays a bike-hour, GST 18%, 5 bikes, ₹15,000, 6/12-month offers 8%/12% with the ₹220 floor, 15-day portal lead, ads due 7 days before, trial 7 days / 20 bike-hours — all one versioned setting); `bookings.ts` (lines, area and date checks, India hour → UTC, quote in whole paise, GST, ads-due time); `booking-flow.ts` (steps Draft → … → Report sent with Cancelled and Ads missing; holds against manual limits; free-trial check).
- Check: the admin sample Biryani Hub prices to ₹54,000 + ₹9,720 = ₹63,720 exactly.
- Tests: 134 in `packages/domain` (property test: 500 random bookings, money always adds up in paise, never below the floor or the minimum).
- New open question 12: refund when a brand cancels a paid booking before it starts.
- **Next: P1.3 part 2** — database tables for price books, bookings, lines, holds and booking events (append-only), with tests on real PostgreSQL.

## 22 Oct 2026 · P1.1–P1.2 storage · Areas and screen reports in the database
- Prateek's answers merged (PR #14).
- New `packages/db`: numbered SQL migrations and a small runner (each once, in a transaction, edited files refused, no BEGIN/COMMIT inside); `area_versions` (PostGIS, append-only, next-version and later-start enforced by the database; `saveAreaVersion` runs the domain overlap check under a lock); `screen_inboxes`, `screen_reports` (each report once by its number), `minute_summaries` (TimescaleDB), `screen_inbox_changes` (who moved an inbox, when). New CI job runs the database tests on a real PostgreSQL and the migrations twice. Runbook: `laptop-setup.md`.
- Second review found 5 issues, all fixed with tests: one bad report could block a screen forever (now checked first and kept aside with its reason; the queue moves on); the minute table could be emptied (TRUNCATE trigger; app role can't drop chunks); the app connected as a superuser (now works through `recall_app`, which owns nothing); a minute could be claimed several times a second apart (must start on a whole minute); inbox moves weren't logged (now logged).
- Tests: 21 database tests, 118 domain tests.
- Open: app login roles on the real servers (P7).
- **Next:** P1.3 inventory, prices and bookings (bike-hours in area-hours, price bands as versioned settings, minimums, booking states, free trial).

## 22 Oct 2026 · P1.2 · Prateek's answers to the open questions
- P1.10 merged (PR #13, all checks green).
- Answers recorded in DECISIONS, the plan (P1.7.6, P1.7.7, P3.17, change log 1.7) and `docs/OPEN_QUESTIONS.md`: POC pay zone 15 km around Hitech City; after the POC, the areas that are on (+ exceptions); loan bank Dhanlaxmi Bank; fitting centres and support numbers as settings (support 10 am – 7 pm); the loan screen is the rider's (bank handles defaults; RECALL may buy back); TDS on rider pay (rate with the CA); POC pay once a month after it ends; chart colours stay.
- Code: `pay-zone.ts` (circle for the POC, list of areas after); each minute summary now carries `payClockSeconds` (clock seconds inside the pay zone, last known position through short GPS gaps); daily counted hours use it. Shared test cases regenerated. 109 tests in `packages/domain`.
- Canvas version 54: rider Founding pay (15 km of Hitech City, paid after each month), Fitting (fitting centre, address to come), Screen loan (Dhanlaxmi Bank), Help (10 am – 7 pm), Payouts (TDS), Profile (leaving: the screen stays the rider's); admin Today, Areas (pay zone), Prices, Payouts, Support.
- Still open: post-POC exceptions, fitting centre address, support numbers, charging steps, TDS rate.
- **Next:** database tables for areas, versions and minute summaries, with migrations tested in CI.

## 22 Oct 2026 · P1.10 · Fleet simulator, version 1
- P1.1–P1.2 merged (PR #12, all checks green). Prateek confirmed: moving hours only in business hours.
- `tools/simulator`: fake delivery bikes on a 250 m street grid over west Hyderabad (trips, signal waits, pick-up stops, long breaks, messy GPS, signal loss, battery drain), each running the real screen tracker, minute summaries and the store-and-forward path into the cloud inbox. Scenarios: normal, rain, cricket (stadium crowding), 30-minute network outage. Command: see `docs/RUNBOOKS/simulator.md`.
- Results (seed runs): clock 96–99.5% of the true time and never above (cautious by ~10 s per start); area agreement ~97%; every report stored exactly once, none lost, including through the outage; 1,000 bikes × 30 min in ~20 s.
- Tests: 9 in the simulator (repeatable from a seed; each scenario: all reports once, clock within 5% and never over, areas > 95%).
- Decision (Claude): version 1 roads are a grid; real OSM roads in version 2.
- Open: the clock under-counts by 1–3% (the 10 s it takes to be sure a bike started). Fine for now; tune with real rides in the POC.
- **Next:** database tables for areas, versions and minute summaries (PostGIS, TimescaleDB), with a migration runner tested against the laptop services in CI.

## 22 Oct 2026 · P1.1 + P1.2 · Areas and GPS in code (shared logic)
- **P1.1 Areas** (`packages/domain`): shapes checked on save (3+ corners, no self-crossing, no overlap or touching, edge zone 0–2,000 m, default 300 m); versions (a change builds on the newest; `versionAt` finds the one in force; strict UTC times); **on/off by super admin** (Prateek: off = not sold, not counted, a new version, never a delete); H3 size-9 lookup that always equals the exact check; six launch areas as drafts. Admin Areas screen (canvas v53) shows the on/off list; it also had a drawing with a shape overlapping Madhapur, now fixed.
- **P1.2 Screen tracker** (reference for the Kotlin player): GPS clean-up, 15 s area hold, moving clock with the 10-minute stop rule, live position every 30 s, one-minute summaries, numbered store-and-forward (7 days) with a cloud inbox that takes each report once; daily and monthly moving hours, 260 active-hour cap (Prateek), odd-minute check.
- Shared test cases: `packages/domain/test-vectors/screen-tracker.json` (1,200 seconds: two areas, poor fix, jump, tunnel, 11-minute stop).
- Tests: 99 in `packages/domain` (property tests: fast lookup = exact check on 20,000 points; any GPS input never breaks the clock rules; any mix of lost/repeated/reordered uploads → each report once, in order).
- Review: a second agent fuzzed ~1.2 million points against the lookup (no disagreement) and found 4 issues, all fixed with tests (time-zone-dependent dates, duplicate version numbers, slanted touching, undefined changes).
- Decisions: 260 cap on active hours (Prateek); tracker numbers and edge cases (Claude, for information).
- Second review (tracker and uploads) found 6 issues, all fixed with tests: a 20 m push could add 10 minutes to the clock (now only 30 s of riding ends a stop); a wrong "oldest held" number could skip reports (now only believed up to what the screen sends); bad-fix runs must agree to be trusted; no distance across gaps or resets; GPS-less seconds don't count to the area hold; a minute sent twice is merged (max 60 s) instead of stopping the day. Shared test cases now also pin clock, positions, minute summaries and the limits. 106 tests.
- Prateek confirmed: moving hours only inside business hours.
- Not yet: storing areas and reports in the database (PostGIS tables), the fleet simulator (P1.10).
- **Next:** P1.10 fleet simulator v1 on these modules, then the database tables for areas and minute summaries.

## 22 Oct 2026 · P0.3.4 done · All screens approved
- Prateek approved batches 3b and 3c with my two choices: agency and aggregator cuts on delivered value (BUILD_PLAN P1.7.4); no discount below ₹220 a bike-hour. DECISIONS updated; canvas version 52 marks every batch approved.
- Edge width answered by the plan itself (P1.1.1: 300 m default, a setting): open question 3 closed, Areas screen updated.
- P0.3 marked Done. P1.10, P1.1 and P1.2 started (BUILD_PLAN change log 1.5).
- Decision (Claude): screen logic is written first in TypeScript (`packages/domain`) as the reference, with shared JSON test cases the Kotlin player must also pass.
- **Next: P1.1** areas in code (shapes, versions, H3 cells, edge zone, overlap check, the six launch areas as drafts).

## 22 Oct 2026 · P0.3.4 · Batch 3c: admin money, reports, support, audit (for approval)
- Canvas version 51, admin row end: Payouts (P3.12), Money (P3.13), Reports (P3.14), Support (P3.15), Audit log (P3.16). All 16 admin side menus now link; Delivery's "Open Money" opens Money. Riders now shows Arjun Rao (Operations) as the signed-in admin, since Priya has Sales and Support only.
- Payouts: system prepares the Monday run, Finance (Meena Iyer) checks, only a super admin approves; holds with a reason; failed payments retry. Sample Mon 13 Mar 2028 matches Ravi's rider app (52 h × ₹25 + 25% of ₹8,008 = ₹3,302).
- Money: ledger at 31 Aug 2027 in paise, debits = credits (₹1,35,00,934.50); held ₹6,40,000 + earned ₹91,99,775 = invoiced ₹98,40,000 − refund ₹225; GST CGST + SGST ₹17,71,159.50; credit note CN-2027-0001 for Brand 31's ₹225 + GST; agency and aggregator statements; exports. Discounts wait for a super admin.
- Reports: final reports 24 h after the last hour, re-send; weekly fill, earnings, refunds, moving hours for POC weeks 1–5 (fill 53% → 63%).
- Support: one inbox, WhatsApp history, actions logged. Audit log: searchable, who/what/when/before/after, cannot be edited.
- For Prateek to check (my choices): agency/aggregator cuts on delivered value; no discount below ₹220 a bike-hour.
- Records: `docs/OPEN_QUESTIONS.md` (new) lists every open question in one place (11 so far). BUILD_PLAN P1.7.6 corrected to Prateek's 150-hour bonus rule (change log 1.4).
- Open: approval of batches 3b and 3c.
- **Next:** once approved, P0.3 is done. Then P1.10 fleet simulator and P1.1–P1.2 areas and GPS (the roadmap order).

## 22 Oct 2026 · P0.3.4 · Batch 3b: admin operations (for approval)
- Batch 3a approved with Prateek's answers (read-only role; super admin sign-off for refunds and discounts).
- Canvas version 50, admin row continued: Delivery and make-ups (P3.10; refunds need super admin sign-off), Fleet map (P3.3; positions only from screens), Screens (P3.4; stock 210 = 200 + 5% spares; staged updates 1% → 10% → all with pause and roll-back), Areas (P3.5; versions, edge zone, overlap check; bookings keep their version), Prices and rules (P3.6; super admin only; versioned from a date; current values from rulebook v5.4, model v5.2/5.3 and today's decisions), Riders (P3.11; funnel, list, rider detail and notes). All 11 admin side menus now link to each other.
- Same sample day as Today (Mon 23 Aug 2027, POC day 23): lines, make-ups (refund ₹225 = 150 plays × ₹1.50 at peak), bikes (142 moving / 31 stopped / 18 at hub / 9 offline = 200).
- Placeholder: [edge width] of an area's edge zone (P1.1).
- Open: approval of batch 3b.
- **Next: batch 3c** — Payouts (P3.12), Money (P3.13), Reports (P3.14), Support (P3.15), Audit log (P3.16). That completes P0.3.4.

## 22 Oct 2026 · P0.3.4 · Batch 3a: admin (for approval)
- Batch 2b approved with Prateek's bonus rule.
- Canvas version 47, admin row: Today (P3.2, replaces the pre-v5.4 Live operations board, kept and marked OLD), Inventory and holds (P3.7), Brands and bookings (P3.8), Ad review (P3.9), Team and roles (P3.1/P3.17).
- Prateek's admin rules built in and recorded (DECISIONS; BUILD_PLAN P3.1, P3.7–P3.9, P5.4.3, change log 1.3): super admin + admins with permission areas; client holds; admin bookings for any start date (portal brands need 15 days, now shown on the brand Book screen); short-notice ad approval with a logged reason.
- Caught and fixed my own sample error before publishing: Fri–Sun 27 Aug – 5 Sep is 6 days, not 9 (180 bike-hours, 36,000 plays, ₹54,000 + GST = ₹63,720).
- Prateek's answers (canvas version 49): add a read-only role; refunds and discounts need a super admin's sign-off. Team and roles updated; DECISIONS and BUILD_PLAN P3.1 updated.
- Open: approval of batch 3a.
- **Next: batch 3b** — Delivery and make-ups, Fleet map, Screens, Areas, Prices and rules, Riders; then 3c — Payouts, Money, Reports, Support, Audit log.

## 22 Oct 2026 · P0.3.4 · Batch 2b: rider app complete (for approval)
- Batch 2a approved by Prateek.
- Canvas version 45: five more rider screens (top row, right): R06 Founding rider pay (POC; model v5.2: ₹2,000/₹4,000/₹6,000 base + ₹6,000 bonus, full at 150+ verified hours inside Hyderabad, part at 100–150, none under 100; day-90 ₹3,000 into the loan), R07 Your screen (status, care, report a problem with photo, repair or swap), R08 Help (WhatsApp, call, requests, plain answers), R09 Alerts (silent while moving), R10 Profile and settings (language, documents, bank re-check with ₹1, leave RECALL).
- Navigation wired: Device and Help tabs, alerts bell and profile from Today, founding pay from Earnings. All 11 plan screens (P4.1–P4.11) now drawn.
- Prateek decided (canvas version 46): the founding bonus needs 150 moving hours minimum, no part bonus; only moving hours as RECALL calculates them count (never app-open time); POC hours only inside Hyderabad (radius to be confirmed); after the POC, counted hours depend on allowed areas with exceptions (to be set). Founding pay and Help screens updated; DECISIONS and MODEL_V52 amended.
- Open: POC radius; post-POC area rules and exceptions (needed by P1.2 GPS counting).
- Placeholders: charging steps (screen maker), support hours and number, rules for returning a loan-bought screen.
- **Next: batch 3** — admin screens, starting with "Live operations" (still uses pre-v5.4 plays-per-brand), for approval.

## 22 Oct 2026 · P0.3.4 · Batch 2a: rider app (for approval)
- Canvas version 44 (https://claude.ai/artifact/MsppEXdv7UShL6FjJBvNBQ), rider rows at the top.
- Fixed Today (P4.4) and Earnings (P4.5) against plan P4 and model v5.3: "this hour sold ₹210" (share-hour leftover) → a sold peak hour is ₹300, ₹264 after agency cuts, rider ₹25 + ₹66; unsold hours pay ₹25. Payouts every Monday (plan), not Friday. Weekly pay no longer subtracts the screen EMI (the bank takes it; RECALL never does, P4.7): payout ₹3,302. Removed an unverified tax threshold. Menu labels 4.3:1 → 5.6:1 (#8A909C). Sample dates moved to March 2028 (after the EMI holiday); loan figures recomputed (2 of 36 paid, ₹46,580 to go).
- New: R01 Sign in and language (Telugu, Hindi, English; WhatsApp code, SMS fallback), R02 Join RECALL (6 steps with status, the camera line), R03 Fitting (slot, QR link, fitting check), R04 Payouts (every Monday, history, tax certificate), R05 Screen loan (bank's data, EMI holiday, day-90 bonus, "RECALL never takes your EMI").
- Placeholders: [Partner bank], [Warehouse address]. No invented durations or rules.
- Open: Prateek to approve batch 2a.
- **Next: batch 2b** — Screen care (P4.8), Help (P4.9), Alerts (P4.10), Profile and settings (P4.11), POC earnings with the 150-hour bonus (P4.5); then batch 3, admin.

## 22 Oct 2026 · P0.3.4 · Batch 1 approved by Prateek, with one change
- Prateek approved the 9 brand screens, with one correction: brands upload their own 15 s video or picture carousel; we run it if it passes the rule check; best practices only at the side. My batch-1 change (template only) was wrong; plan step P5.5 already said "template or own file".
- 5 · Your ads redrawn (canvas version 43): upload first (video, or 2–5 pictures as a carousel; 1280 × 640, no sound, ≤30 MB), each file shows its rule check (✓ ready / fix: too long, wrong shape / checking); template is an optional fold-out for brands with no ad (own colour on midnight, night-readability hint, "make another version"); 2–5 ads; best-practice list extended from the brand book.
- Records: DECISIONS (Prateek's upload rule; old row struck through), PRODUCT_V54 ads line amended, BUILD_PLAN P5.5 + change log 1.2, brand book Screen creative (only the must rules are checked for brand files; the rest is advice).
- Clock rule: 10 minutes everywhere (fixed earlier today in the brand book and code).
- **Next:** batch 2, rider app screens (fix "this hour sold ₹210", then the rest of P4's screens), for approval.

## 22 Oct 2026 · P0.3.4 · Screens redrawn for approval — batch 1: brand portal (in progress)
- The 9 brand screens were already in Night Signal on the design canvas (https://claude.ai/artifact/MsppEXdv7UShL6FjJBvNBQ). Checked each against rulebook v5.4, model v5.3 and the design system, and fixed what was wrong (canvas version 41):
  - 5 · Your ads: removed "upload your own video or image" (rulebook + brand book: every ad is made in RECALL's templates). Colour themes used volt, which the brand book keeps for RECALL's own ads, and two broke screen rules (a light field at night; 6.2:1 text). Now: the brand picks its own colour; layouts "your colour on midnight" and "paper on midnight with a colour band"; a live check refuses colours under 7:1 on midnight.
  - 4 · Book and 9 · Help: ₹220 band named Lite (decision 22 Oct), with its hours.
  - 7 · Report: people estimate as a ±15% range (2.0–2.8 lakh), as P1.8.3 says.
  - All brand screens: control borders #5B6272 → #606777.
- Checked and correct: prices and peak windows, 5-bike and ₹15,000 minimums, GST, 6/12-month offers, every invoice total, free week (rulebook allows it), make-up rule, ads due 7 days before.
- Design system: type sample corrected to "the clock pauses after 10 minutes standing still" (model's 10-minute stop rule; it said 5).
- Found for later batches: rider "Today" says "this hour sold ₹210" (share-hour leftover; v5.4 sells whole hours: ₹300 peak → ₹264 after cuts → rider ₹25 + ₹66). Admin "Live operations" still counts plays per brand per hour (5) and RECALL's 6th slot (pre-v5.4) and needs a redraw.
- Open: Prateek to approve batch 1 on the canvas.
- **Next:** batch 2 (rider app screens), then batch 3 (admin), each for approval.

## 22 Oct 2026 · P0.3.3 · Logo and app icons in the code
- The Night Signal logo was already finished in Cowork (decision: keep the Afterimage, recolour it). This step brings it into the code instead of redrawing: the 11 brand-book SVGs copied exactly to `packages/design/brand/logo/`.
- App icons for every platform generated from `recall-app-icon.svg` by `pnpm --filter @recall/design build` (`src/icons.ts`, renderer `@resvg/resvg-js`): browser tab, iPhone home screen, installed web app (incl. maskable), rider app (Expo 1024), Android adaptive foreground (symbol scaled 72/108 so it looks the same size and stays in the safe circle), Play Store 512. Guide: `packages/design/brand/README.md`.
- Tests: 25 new (111 in `packages/design`): logos use only volt/midnight/paper and load nothing; echo heights 78% / 56%; adaptive symbol inside the 66/108 safe circle; every PNG at its size; derived SVGs in sync.
- Open: none.
- **Next: P0.3.4** — redraw the 9 brand screens, then rider and admin screens, page by page, for Prateek's approval before code.

## 22 Oct 2026 · P0.3.2 · RECALL design system (components, chart and map colours)
- Found the RECALL brand book (design-system artifact made in Cowork) already set token names, an 8-point spacing scale, 12 type styles, corners 4/6/14/20/pill and a lift shadow. `packages/design/src/tokens.ts` now copies them exactly, with their usage notes (replaces the P0.3.1 4 px grid and 12–56 px sizes; DECISIONS). Code is the one source: `pnpm --filter @recall/design build` writes `tokens.css` and the design system's `tokens.json` + `bundle.css`.
- `components.css` (`rc-*` classes): button, field (input/select, help, error), status chip, filter chip, card, stat tile, table. `src/dataviz.ts`: chart series, map roles, heat-map ramp, all naming tokens.
- Design system https://claude.ai/artifact/BjjWMHaUHHX5o2VkTPMfWY updated (version 9): tokens from code (dark `line-strong` #606777, flag removed), component stylesheet, 6 new cards (TextField, FilterChip, Card, DataTable, ChartColours, MapStyle), Button/StatusChip/StatTile now use the shared styles, Colour section updated. Card sources live in `packages/design/design-system/`. How to change things: `docs/RUNBOOKS/design-system.md`.
- Tests: 86 in `packages/design` — every contrast promise (text, borders, chips, charts, maps), heat-map steps, tokens.css and tokens.json in sync, every card has a marker, a guideline and only real classes. All 9 cards rendered in Chromium, light and dark, desktop and 360 px phone: no errors, no sideways scroll.
- Open: in light, chart series 1 (olive) and 2 (blue) differ by hue, not lightness (1.1:1). Rule added: always name series on the chart. A colour change would fix it properly; for Prateek when charts are built (P1.9 reports).
- **Next: P0.3.3** — new logo mark and app icon in Night Signal.

## 22 Oct 2026 · P0.3.1 · Night Signal tokens as code
- P0.2 merged to `main` (PR #1, all checks green). SeaweedFS confirmed by Prateek.
- `packages/design`: core colours, light/dark theme tokens exactly as `docs/NIGHT_SIGNAL.md`, fonts (Anek Latin/Telugu/Devanagari, IBM Plex Mono) and Google Fonts link, font roles, text sizes, 4 px spacing, corners 6/14/20/pill, 1 px lines. `tokens.css` generated for the web portals (`pnpm --filter @recall/design build`); light by default, dark from the system setting or `data-theme="dark"`.
- Tests: 41 — every contrast promise in NIGHT_SIGNAL.md, same tokens in both themes, no Inter/Space Grotesk, corners, 4 px grid, `tokens.css` up to date.
- Prateek's answers: dark control border changed #5B6272 → #606777 (now ≥3 : 1 on every surface, both themes; also in NIGHT_SIGNAL.md); spacing and text sizes confirmed; Claude merges its own PRs once checks are green.
- Open: none.
- **Next: P0.3.2** — RECALL design system (buttons, inputs, chips, tables, cards, map styles, chart colours).

## 22 Oct 2026 · P0.2 · Repository, automatic checks, record files (Claude Code)
Branch `claude/festive-meitner-kb0teg`, draft PR https://github.com/Picorus/recall-platform/pull/1. One commit per part:
- **P0.2.1** Monorepo: pnpm 10 + Turborepo; every folder from the plan with a placeholder package (`apps/player` is Kotlin, outside the workspace).
- **P0.2.2** Checks: strict TypeScript 6.0, ESLint, Prettier (code only; `.md` files left as written), Vitest, fast-check. `packages/domain`: money in whole paise (`parseRupees`, `formatRupees` with Indian grouping) and India time / `businessDayOf` (08:00–02:00; 23:00–02:00 counts for the day it started). `tools/repo-checks`: secret patterns, `.env.example` names-only rule, commit-message rule.
- **P0.2.3** Laptop services: `pnpm services:up` / `services:check` / `services:down` — Postgres 16.15 + PostGIS 3.6 + TimescaleDB 2.31 + H3 4.2, Redis 7.4, EMQX 5.8, SeaweedFS 4.48 (S3 stand-in; MinIO no longer ships a free image).
- **P0.2.4** CI (GitHub Actions): format/lint/types/tests, laptop services start, gitleaks over full history, step-id commit messages. All 4 green on GitHub.
- **P0.2.5** Records: `docs/ARCHITECTURE.md`, `docs/RUNBOOKS/` (laptop set-up), README, 5 decisions.
- Review by a second agent found 6 defects, all fixed with tests: test cache hid the secret scan on laptops; `parseRupees` accepted mis-grouped amounts ("1,50,00" read as ₹15,000); `.env.example` rule could be bypassed; services check failed on macOS; quick pushes to main could skip the commit check; force-push broke it. Plus nits (mid-sum overflow, fake "Merge" subjects, Node ≥22.18).
- Tests: 49 domain tests (2 property tests, thousands of random cases each), 26 repo-check tests; planted secrets, bad commit names and a missing DB extension each proven to fail.
- Open: Prateek to confirm SeaweedFS instead of MinIO. Docker Hub rate-limits the cloud sandbox; images were pulled via mirror.gcr.io here (not needed on a laptop or in CI).
- **Next: P0.3.1** — Night Signal colours, type, spacing and corners as code tokens in `packages/design` (light and dark).

## 22 Oct 2026 · P0.1 · Build plan done (Cowork)
- Wrote docs/BUILD_PLAN.md (copy of the "RECALL Build Plan" doc in Claude), CLAUDE.md, DECISIONS.md.
- Night Signal colours applied to the design system, investor deck and design canvas (outside this repo).
- Tests: none yet (no code).
- Open: GitHub repo created by Prateek; company accounts (AWS, payments, WhatsApp, KYC) come after incorporation; screen vendor sample unit needed before P2.9.
- **Next: P0.2** — set up the monorepo (pnpm + Turborepo), lint/format/test tooling, CI on GitHub Actions, `.env.example`, docker-compose for Postgres+PostGIS+Timescale, Redis, EMQX; then P0.3.1 design tokens in `packages/design`; then P1.10 simulator skeleton and P1.1 areas.
