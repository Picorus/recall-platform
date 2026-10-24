# Work log

Newest first. Each entry: date · step id · what changed · tests · open issues · next.

## 24 Oct 2026 · P1.7.5–6 · Rider pay
- P1.7.4 merged (PR #23).
- Domain (`rider-pay.ts`, settings `riderPay` in the price book):
  - POC: base (₹2,000 / ₹4,000 / ₹6,000, set per rider) + ₹6,000 bonus at 150+ moving hours in the pay zone, none below; worked out after the month ends.
  - After the POC: ₹25 a moving hour (capped at 260 a month) + 25% of what his hours sold.
  - TDS 1% for now (a setting; CA to confirm).
  - `soldShares`: a line's money shared by counted plays (each play = paid ÷ promised), never more than the line was paid.
  - `riderPayAccrued`: rider earnings, owed to the rider less TDS, TDS owed to the government; up or down by the difference.
  - `countedPlays` split out of `lineTotals`, so pay and play totals count the same plays.
- Database (migration 0014): `rider_screens` (who rides which screen from when; append-only) and `rider_poc_bases`. `accrueRiderPay(month, now)`: every rider's hours (only while he rode each screen), what his plays sold, and the ledger brought up to date. Safe to rerun; one rider failing doesn't stop the others.
- Tests: 235 domain (property tests: shares never more than paid; pay entries always balance and land on the figure), 12 new database tests (POC bonus at exactly 150 h and not at 149; a screen changing hands; pay-zone seconds only; late minutes; ₹25/h + 25% sold; 260 h cap; ledger balances).
- Review by a second agent found 3 real problems, all fixed with tests:
  - A last-day line's make-up plays the next day: its sales went to nobody if the screen changed hands after 03:00 on the 1st. Now riders are looked up for 2 days after the month, and a rider whose plays sold is always in the run.
  - A POC base was paid every month for ever, even with no screen, and could not be ended. Now only riders who rode a screen that month are paid, and a base of 0 ends it (checked against that month's price book).
  - A closed month could still change. Now, once closed (48 h after the month), late changes are not posted; they come back in `late` for finance to settle by hand.
  - Also: a rider can be on only one screen at a time; screen lookups grouped by screen (faster).
- Open (speed, before real volumes): the monthly run is one transaction with per-line queries; fine for the POC (200 bikes), to be split up before scale. A price book saved later with a back-dated start can change an unpaid month's rates: saving books will check this with the admin tools (P3).
- Open for Prateek: question 15 (what decides a rider's POC base; does a rider who joins mid-month get the full base?).
- Open: the day-90 ₹3,000 bonus towards the screen loan comes with P1.7.8 (screen loan).
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
