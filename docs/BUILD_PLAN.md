# RECALL Build Plan: rider app, brand portal, admin

Oct 22, 2026 · @Prateek

## How to use this document

This is the single build plan for the RECALL platform: every product, engine and step, in the order we build it. Claude builds from it one step at a time; a human engineer can pick it up at any step.

- **Step numbers.** Every step has an id like `P2.4.3` (phase 2, step 4, sub-step 3). Code commits, tests and the work log quote the same id, so anyone can trace a feature from this plan to the code.
- **Status.** Each step is To do, Doing, Done or Blocked (waiting on something outside our control, such as a hardware sample or an API key). The roadmap section holds the live status.
- **Source of truth.** Business rules come from the rulebook v5.4 and model v5.3. If code and this plan disagree, the plan wins until the plan is changed, and every change goes in the change log at the end.
- **Definition of done** for any step: code merged, automatic tests passing, the step's acceptance checks ticked, and a line in the work log saying what changed and why.
- **Records.** The code lives in one repository with its own `docs/` folder (architecture, decisions, work log, runbooks). This document is the plan; the repository is the record.

## What we are building

We are building five pieces that work as one system: a box on every bike that plays ads, a cloud that decides what plays where and counts it, and three apps for riders, brands and our own team.

| Piece | Who uses it | What it does | Built with |
| --- | --- | --- | --- |
| Screen unit ("Player") | Nobody touches it; it runs itself | Plays ads, reads GPS, counts people on the chip, logs every play, works offline, updates itself | Android app (Kotlin) on the screen's controller box |
| Cloud platform ("Core") | All apps and screens | Areas, bookings, the ad scheduler, play counting, make-ups, money ledger, invoices, rider earnings, reports | TypeScript services, PostgreSQL with PostGIS, MQTT broker, file storage |
| Rider app | \~200 riders in the POC, 15,500 by 2031 | Sign-up and KYC, screen check, today's hours and earnings, payouts, loan status, help, Telugu and English | Android app (React Native) |
| Brand portal | Shops, brands, agencies | The 9 screens: sign in, business, campaigns, book, ads, pay, report, invoices, help | Web app (Next.js) |
| Admin portal | RECALL ops, sales, finance, support | Fleet map, areas, prices, ad review, bookings, make-ups, riders, payouts, invoices, GST, roles, audit log | Web app (Next.js) |

**The rule that shapes everything:** the screen decides what to play on its own, from a plan the cloud sends ahead of time. If the 4G signal drops, the bike keeps playing the right ads and keeps a record; the cloud catches up when it reconnects. Billing and reports only ever use those records.

## Build order and why

We build the engine first, then the screen, then the admin portal, then the rider app, and the brand portal last. Each piece needs the one before it, and the POC in August 2027 needs the first four; self-serve brands start only in November 2027.

1. **P0 Foundations.** Repository, automatic tests and checks, new brand colours as code, the record files. Nothing else can start cleanly without it.
2. **P1 Core engine with a fleet simulator.** Areas, GPS counting, the ad scheduler, play counting, make-ups and the money ledger. A simulator drives 200 to 15,500 fake bikes around real Hyderabad roads, so every rule is tested before any hardware exists. This is the heart of RECALL and the hardest part, so it goes first.
3. **P2 Screen player.** The Android app on the screen box, built on an emulator against the simulator, then proven on a real sample unit. Blocked until we have one sample screen.
4. **P3 Admin portal.** Our team needs it to draw areas, set prices, review ads, run the POC's 40 brands and watch the fleet. Sales books POC campaigns here for brands.
5. **P4 Rider app.** Needed before riders are fitted in June–July 2027: sign-up, KYC, earnings, payouts, loan, help.
6. **P5 Brand portal.** The 9 simple screens. The final report generator is built inside P1, because POC brands need reports in August.
7. **P6 Real integrations.** Maps, WhatsApp, payments, payouts, KYC, GST invoices. Every one is built from day one behind a switch with a fake version, so we plug the real service in by adding keys, not by rewriting code.
8. **P7 Hardening and launch.** Security review, load test at 15,500 simulated bikes, the 2-week road test, POC readiness checks.

**Why not the apps first?** Screens and portals are only windows onto the engine. If the scheduler or the play count is wrong, every app shows wrong numbers and we rebuild. Building the engine first, with a simulator, means the apps are built once.

## Architecture

One repository, one main database, a small number of services, and a message line to every screen. We keep it boring and proven so a team of five can run it at 15,500 bikes.

&#91;embedded content: system architecture · screens, cloud, apps\]

The screen keeps a two-way line to the device gateway and downloads ad files from storage; the three apps reach the cloud only through the API.

### Services

| Service | Job | Talks to |
| --- | --- | --- |
| API | Every app's front door: sign-in, bookings, areas, riders, payments, reports | Database, queue, file storage |
| Device gateway | Holds the line to every screen: sends plans and updates, receives plays, GPS and counts | MQTT broker, database |
| Scheduler | Builds the hour plans, rebalances bikes between bookings every minute, books make-ups | Database, device gateway |
| Ledger and billing | Money in, revenue earned as plays are delivered, refunds, GST invoices, rider earnings, payouts | Database, payment and payout providers |
| Workers | Slow jobs: reports, heat maps, invoice PDFs, WhatsApp messages, ad file checks | Queue, file storage, providers |
| Admin, brand and rider apps | The three front ends | API only |

### Tech choices

| Area | Choice | Why |
| --- | --- | --- |
| Language | TypeScript for cloud and web, Kotlin for the screen player | One language for most code; Kotlin is the right tool for low-level Android hardware |
| Database | PostgreSQL 16 with PostGIS (areas, location) and TimescaleDB (GPS and play logs by time) | One database that handles maps and time series; no second system to run |
| Screen link | MQTT over TLS with a certificate per screen, through EMQX | Built for weak mobile networks; tiny messages; the screen reconnects by itself |
| Ad files | Object storage (S3-compatible) behind a CDN; screens download and keep files | Screens never stream; Rule 1 of the tech rules |
| Queue | Redis with BullMQ | Simple, enough for our scale |
| Web apps | Next.js with React | One framework for brand and admin portals |
| Rider app | React Native (Expo) | Shares types and code with the rest; Android only at first |
| Map display | MapLibre with an open map style; a paid map service only for search and geocoding | No per-view map fees; we draw our own areas |
| Map grid | H3 hexagons | Heat maps and fast "which area is this point in" checks |
| Hosting | AWS Mumbai region (ap-south-1), in containers | Data stays in India; low delay to Hyderabad |
| Monitoring | OpenTelemetry, Grafana, Sentry | One place to see every error and slow call |

### Rules the code must keep

1. **The screen is the truth for plays.** Every play is signed by the screen's own key at the moment it happens. The cloud never invents a play.
2. **Money is a ledger, never a running total.** Every rupee moves by a pair of entries that always balance; balances are always worked out from entries.
3. **Every change that matters is logged:** who, what, when, before and after. Nothing is ever deleted, only reversed.
4. **Every outside service sits behind an adapter with a fake.** We can run the whole system on a laptop with no keys.
5. **Times are stored in UTC and shown in India time.** The business day runs 08:00 to 02:00, so a night's 23:00–02:00 hours belong to the day they started.

## Core engines (P1)

Six engines carry the business: areas, GPS, the scheduler, play counting, make-ups and money. Each is built and tested against the fleet simulator before any app uses it. Amounts are kept in paise as whole numbers, never as decimals.

### P1.1 Areas (geofences)

1. **P1.1.1** Store each area as a map shape (PostGIS polygon) with a name, city, price band rules and an "edge zone" ring around it (default 300 m).
2. **P1.1.2** Version every area. A booking keeps the version it was sold on, so redrawing Madhapur never changes an old report.
3. **P1.1.3** Pre-compute each area as H3 hexagons (size 9, about 0.1 km²) for fast "which area is this point in" checks on the server and on the screen.
4. **P1.1.4** Rules: areas may not overlap; a point in two edge zones belongs to the nearer area. Checked automatically when an area is saved.
5. **P1.1.5** Seed data: the six launch areas (Madhapur, Kondapur, Gachibowli, Hitech City, Jubilee Hills, Banjara Hills) as draft shapes for ops to correct on the map.
6. **P1.1.6** A super admin adds areas and turns them on or off (Prateek, 22 Oct 2026). Off = not offered to brands, and plays and moving hours there do not count. On/off is a new version from a chosen date, never a delete. An area with bookings still to run cannot be turned off until they are moved or refunded. Operations admins correct shapes. Shapes may not overlap or touch; the edge zones cover any gap.

### P1.2 GPS and moving hours

1. **P1.2.1** The screen reads GPS once a second and cleans it: drop fixes with poor accuracy, drop jumps faster than 150 km/h, smooth the rest.
2. **P1.2.2** The screen decides its area every second, with a 15-second hold so a bike riding along a boundary does not flicker between areas.
3. **P1.2.3** Moving = above 5 km/h on average over 30 seconds. **10-minute stop rule:** stopped more than 10 minutes, the screen dims to standby and the moving-hour stopwatch pauses; it wakes as soon as the bike moves.
4. **P1.2.4** The screen sends a live position every 30 seconds (for the fleet map) and a one-minute summary: area, seconds inside, seconds moving, distance, plays, people counted.
5. **P1.2.5** Store-and-forward: with no signal, the screen keeps everything for up to 7 days and uploads it in order, numbered, when it reconnects. Nothing is lost or counted twice.
6. **P1.2.6** Moving hours per bike per day and month, the rider's 260-paid-hour monthly cap, and a daily check for odd patterns (a bike "moving" while its GPS stays still, or the reverse).

### P1.3 Inventory, prices and bookings

1. **P1.3.1** The unit of sale is a **bike-hour in an area-hour**: area × date × start hour (08:00 to 01:00 starts). One bike-hour = 200 plays of the brand's ads; the other 40 of the 240 15-second spots are RECALL's.
2. **P1.3.2** Price bands: Peak ₹300 (08–11, 17–23), Normal ₹250 (11–17), Lite ₹220 (23–02). Offers only for monthly repeats: 6 months 8%, 12 months 12%. Floor ₹220 a bike-hour, enforced in code. All prices + 18% GST, set in admin, versioned.
3. **P1.3.3** A booking = lines of (area, date, hour, bikes). Minimum 5 bikes a line, ₹15,000 a booking before GST. Ads due 7 days before the first hour (setting).
4. **P1.3.4** Sell only what the area can deliver (Prateek, 22 Oct 2026; replaces "no sell cap" of 21 Oct). Each area-hour has a sellable number of bikes from the supply forecast (P1.3.7); a super admin's manual limit overrides it. Paid bookings and live holds use it up; saved selections (drafts) reserve nothing: if another brand pays first, those bikes are gone. When a request does not fit, the brand is offered what fits there and suggestions for the rest (nearby areas at the same hour, next hours in the same area, the same hour on other days), or picks again. The weekly refund total stays the early warning.
7. **P1.3.7 Supply forecast** (after the POC; in the POC all 200 bikes run and only manual limits apply — Prateek, 22 Oct 2026). For every area × weekday × start hour: how many different bikes were really there and how many bike-hours they gave, from the screens' minute summaries over the last weeks; sellable = the level reached in most past weeks, less a margin kept for make-ups. Before there is history (before and early in the POC), a super admin's starting estimate per area is used. Every number is a setting.
5. **P1.3.5** Booking states: Draft → Awaiting payment → Paid → Ads approved → Running → Done → Report sent; side exits: Cancelled before start (paid: no refund by default; at least 72 hours before the first hour a super admin may refund 100% — Prateek, 24 Oct 2026), Ads missing (no refund).
6. **P1.3.6** Free trial: one per business (GST number or phone), 1 week, 1 area, about 20 bike-hours, lowest priority, from unsold time only.

### P1.4 The ad scheduler

The scheduler answers one question every minute: which booking does each bike in each area carry right now? It works in three layers, so it never depends on a perfect network.

1. **P1.4.1 Hour plan (2 hours ahead).** For every area-hour, the list of booking lines, their plays needed, their ads and a weight. Sent to every screen in the city (a few kilobytes). Ad files are sent 24 hours ahead or as soon as approved, and kept on the screen.
2. **P1.4.2 Live assignment (every 60 seconds).** For each area, take the bikes inside it now. For each booking line, need = plays required − plays counted − plays expected from bikes already carrying it. Give each free bike to the line with the biggest gap, preferring bikes that have not yet carried that line (the "at least N different bikes" promise). Send the change to the screen.
3. **P1.4.3 Offline fallback on the screen.** If no assignment arrives, the screen picks a line from the hour plan by itself, using a fixed formula on its own id and the hour (weighted rendezvous hashing). Every screen picks the same way, so the fleet spreads across bookings correctly with no network at all.
4. **P1.4.4 One brand per bike per hour.** While a bike is inside an area, it carries one booking line and plays only that brand's 2 to 5 ads in turn. If it crosses into another area, it switches to that area's booking.
5. **P1.4.5 The 240 spots.** 200 brand plays and 40 RECALL spots an hour, spread evenly (one RECALL spot after every five brand plays). The 40 RECALL spots are filled in this order (Prateek, 22 Oct 2026): make-ups owed to brands first, then aggregator ads, then RECALL's own ads (the default). Admins choose the aggregator and RECALL ads.
6. **P1.4.6 Priority order:** make-ups due now are played first in RECALL's spots; whole bikes go to paid bookings → make-ups still short → free trials → RECALL's own ads (a make-up never takes a bike a paid line needs; Claude, 22 Oct 2026, see DECISIONS).
7. **P1.4.7 Proof by simulation.** With 200, 2,000 and 15,500 simulated bikes on real roads, the scheduler must deliver every booking that the area's bikes can carry, and the run must be repeatable from a seed.

### P1.5 Play counting and proof

1. **P1.5.1** Each play is a record: play id, screen id, booking line, ad, start time, length, position, GPS quality, area as the screen saw it, and a sequence number, signed with the screen's own key.
2. **P1.5.2** The cloud checks every record: valid signature, sane time, no repeats, no more than one play per 15 seconds per screen, and the position re-checked against the area shape.
3. **P1.5.3** What counts: plays inside the area, plus plays in the edge zone up to 10% of the line's plays. Plays further out do not count.
4. **P1.5.4** Per line: plays counted, different bikes used, minutes inside, people counted. Kept as running totals for the live view and final totals after the day closes.

### P1.6 Make-ups and refunds

1. **P1.6.1** At each hour's end (plus 10 minutes for late uploads), the shortfall per line = plays promised − plays counted.
2. **P1.6.2** Shortfall becomes make-up demand in the same area over the next 2 hours, at top priority.
3. **P1.6.3** Still short: make-up in the same hour the next day, same area.
4. **P1.6.4** Still short: refund for the missing part (missing plays ÷ 200 × the price paid per bike-hour), issued as a GST credit note and paid back to the original payment method.
5. **P1.6.5** Day close at 24 hours: plays uploaded late still count; extra plays are a bonus, never charged.

### P1.7 Money: ledger, GST, cuts and rider earnings

1. **P1.7.1 Ledger.** Double-entry accounts: payment clearing, money held for campaigns not yet delivered, revenue earned, GST payable, agency payable, aggregator payable, rider earnings payable, refunds payable, TDS payable, gateway fees. Every booking, delivery, refund and payout is a balanced entry.
2. **P1.7.2 Brand pays in advance.** Full amount + GST, then a GST tax invoice is issued at once. The money sits as "held" until plays are delivered.
3. **P1.7.3 Revenue earned hour by hour.** At each hour close, the delivered part moves from held to earned.
4. **P1.7.4 Cuts.** Agency 10% on bookings made by an agency; aggregator 2% on brands referred by a delivery or ride app. Not automatic: RECALL decides whether a cut is given (per booking or per partner deal); the cut includes the partner's GST (claimed back), and TDS on the part before GST is held back (Prateek, 24 Oct 2026). Worked out on what was delivered (not invoiced), recorded as payable and paid monthly with a statement.
5. **P1.7.5 Rider earnings (after the POC).** ₹25 for each moving hour + 25% of what his hours sold (the booking's bike-hour price × the share of plays his screen delivered). Paid hours capped at 260 active hours a month (moving hours as RECALL counts them; Prateek, 22 Oct 2026).
6. **P1.7.6 Rider earnings (POC).** While the business switch (admin portal, super admin) is on POC: flat base ₹2,000 / ₹4,000 / ₹6,000 in POC months 1 / 2 / 3, earned day by day and paid weekly; founding bonus up to ₹6,000 a month on verified moving hours inside 15 km of Hitech City (full at 150+, in proportion from 100, none below), given by a super admin once the month closes; no sales share; ₹3,000 more for riders who finish the POC and keep the screen. Moving hours as RECALL calculates them from the screen, never app-open time (Prateek, 22 and 24 Oct 2026).
7. **P1.7.7 Payouts.** Weekly run every Monday: system prepares, finance approves in admin, the payout provider pays each rider's bank or UPI. Failed payouts retry and show in admin. TDS is deducted from rider pay at the rate the CA confirms (a setting); a gig-worker levy, if any, is a setting too.
8. **P1.7.8 Screen loan.** The bank lends to the rider; RECALL only records loan status and EMI dates shown in the rider app. Loans and EMIs are never on RECALL's books.
9. **P1.7.9 GST and books.** Monthly GST summary, invoice and credit-note registers, export for the accountant. E-invoicing switched on before turnover crosses the legal limit.

### P1.8 People counts

1. **P1.8.1** The screen's AI chip counts people facing the screen each minute. Pictures never leave the chip's memory; only the number leaves, with time and place.
2. **P1.8.2** Counts are tied to the booking line the screen carried in that minute and area.
3. **P1.8.3** Reports show a rounded range (±15%) marked "approximate". Counts are never used for billing or promises.

### P1.9 Final report

1. **P1.9.1** Built 48 hours after a campaign's last hour (once every line's make-ups and refund check are done): plays delivered vs promised, different bikes, heat map (H3 hexagons of play positions), busiest streets, make-ups, any refund, people (approximate).
2. **P1.9.2** Shown on the web, as a PDF, and sent on WhatsApp and email.

### P1.10 Fleet simulator

1. **P1.10.1** Fake bikes that ride real Hyderabad roads (from OpenStreetMap), with delivery-like trips, stops, signal loss and battery drain.
2. **P1.10.2** Each fake bike runs the same player logic as the real screen, so the simulator tests the true code path.
3. **P1.10.3** Scenarios: normal day, rain (fewer bikes), cricket match (bikes cluster), network outage, 15,500-bike load.

## Screen and device (P2)

Each bike carries a 28-inch P2.5 LED screen driven by a small Android controller box with 4G, GPS and an AI camera. Our own player app runs on that box and controls everything; we choose hardware that lets us install it.

### What the hardware must have (checked before we buy 210 kits)

| Part | Need | Why |
| --- | --- | --- |
| Controller | Android 11+ board (for example Rockchip RK3566 or RK3588 class) that lets us install our app as device owner | Our player must be the only app and start by itself |
| AI chip | NPU of at least 1 TOPS on the same board, or a separate camera module with its own chip | People counting on the bike |
| LED link | HDMI or vendor SDK to the LED sending card, with brightness control from our app | Night dimming and blanking |
| 4G | LTE Cat 4 modem, SIM slot, external antenna | Steady link while riding |
| GPS | GNSS (GPS + NavIC/GLONASS), external antenna | Area decisions and proof |
| Storage | 32 GB or more | Keep a week of ads and logs |
| Battery link | Battery charge and voltage readable by the board | Health alerts, battery planning |
| Tamper | Lid switch and unique hardware id | Theft and swap alerts |

**Blocked on you:** one sample unit from the shortlisted vendor, with its SDK, before P2.5.

### Player app steps

1. **P2.1 Identity and set-up.** Each box gets a unique id and its own security certificate at our warehouse. Fitting links box → bike → rider by scanning a QR in the rider app.
2. **P2.2 Kiosk mode.** The player is the device owner: starts on power-up, cannot be closed, a watchdog restarts it within 5 seconds if it crashes.
3. **P2.3 Connection.** MQTT over TLS; reconnects by itself; clock set from network and GPS time; store-and-forward up to 7 days.
4. **P2.4 Ad storage.** Downloads ads ahead, checks each file's fingerprint, keeps them until the booking ends, clears old files when space runs low. Never streams.
5. **P2.5 Playback.** Plays 15-second videos and still images without gaps, rotates the brand's 2 to 5 ads, keeps the 200-brand / 40-RECALL pattern each hour.
6. **P2.6 Local scheduler.** Knows its area from GPS (P1.2), follows the cloud's assignment, falls back to its own pick from the hour plan when offline (P1.4.3).
7. **P2.7 Signed play log.** Every play is written to local storage and signed with a key held in the box's secure store.
8. **P2.8 GPS service.** Reads, cleans and smooths positions; runs the moving-hour stopwatch and 10-minute stop rule.
9. **P2.9 People counter.** A small person-detection model on the AI chip, a few low-resolution frames a second, a short tracker so nobody is counted twice. Frames stay in memory under a second; nothing is saved or sent except the count.
10. **P2.10 Brightness.** Brighter by day, dimmer at night from a light sensor or the clock, never blinding riders behind.
11. **P2.11 Health.** Every minute: battery, temperature, storage, signal, LED faults, app version. Alerts on overheating, low battery, tamper or no contact for 30 minutes.
12. **P2.12 Remote commands.** Reboot, blank, test pattern, set brightness, send logs, clear cache. Every command is logged in admin.
13. **P2.13 Updates.** Our own update system: new versions go to 1%, then 10%, then all screens, and roll back by themselves if crashes rise.
14. **P2.14 Fitting check.** A test mode the technician starts from the rider app: shows a pattern, checks GPS, 4G, camera and battery, and marks the bike ready.

### How the screen connects, in order

1. Power on → player starts → connects to 4G → opens the secure MQTT line with its certificate.
2. Receives the hour plan and any new ad files; downloads files over HTTPS from storage.
3. Every second: reads GPS, decides area, plays the right ad, writes a signed play record.
4. Every 30 seconds: sends position. Every minute: sends the minute summary and health.
5. Signal lost: keeps playing from the plan, keeps writing records, sends everything when back.

## Rider app (P4)

The rider app does four jobs: get a rider signed up and fitted, show what he earned today, pay him every week, and help when the screen has a problem. It never asks for a tap while the bike is moving. Telugu, Hindi and English; works on cheap Android phones (Android 8+, 2 GB memory) and weak signal.

### Screens and steps

1. **P4.1 Language and sign-in.** Pick language, then phone number and a code by WhatsApp or SMS.
2. **P4.2 Join RECALL.**
   1. **P4.2.1** Profile: name, photo, area he rides in, which delivery or ride apps he works for.
   2. **P4.2.2** Vehicle: registration and insurance documents (photo upload), number plate.
   3. **P4.2.3** Identity check (KYC): Aadhaar through DigiLocker and PAN, through a KYC provider.
   4. **P4.2.4** Bank or UPI for payouts, checked with a ₹1 test deposit.
   5. **P4.2.5** Rider agreement signed on the phone, including the camera line: "This screen counts people. It records nothing."
   6. **P4.2.6** Screen loan: hand-off to the partner bank's form; the app only shows the result.
3. **P4.3 Fitting.** Pick a slot at the warehouse; at fitting, scan the screen's QR to link screen, bike and rider; run the fitting check (P2.14).
4. **P4.4 Today (home).** Screen status (on, playing, battery, signal), moving hours today, earnings today and this week, a short reminder of the 10-minute stop rule.
5. **P4.5 Earnings.** Day, week and month: moving hours × ₹25, share of sales, total. In the POC: progress to 150 verified hours for the full bonus. Monthly statement download.
6. **P4.6 Payouts.** Next payout date (every Monday), amount, bank, status, history, tax certificate when due.
7. **P4.7 Screen loan.** Loan amount, EMI (about ₹1,370), next due date, EMI holiday months, day-90 bonus status. Shown from the bank's data; RECALL never collects the EMI.
8. **P4.8 Screen care.** How to charge and look after the screen; report a problem (not turning on, damage, theft, accident) with a photo of the damage; book a repair or swap.
9. **P4.9 Help.** Common questions, WhatsApp chat, call, open requests and their status.
10. **P4.10 Alerts.** Payout sent, screen offline or low battery, repair booked. Silent while moving.
11. **P4.11 Profile and settings.** Language, documents, change bank (checked again), leave RECALL (return-the-screen steps), and **delete my account** (Prateek, 27 Oct 2026; also required by Google Play, with a web page for it): the request is logged, staff settle the screen, money and loan first, then his personal details (name, phone, photos, papers, bank details) are erased or blanked; only what the law says must be kept (pay and tax records) stays, for the time open question 18 sets.

### What the app does not do

No ad content, no brand names of who is playing, no live tracking of the rider by the app itself: position comes only from the screen box, and only while the screen is on.

## Brand portal (P5)

The brand portal is the 9-screen simple product from rulebook v5.4: pick, pay, upload, get one report. The current design sample is on the RECALL design canvas; it will be redrawn in the new colours (section 9) before we build.

1. **P5.1 Sign in.** Mobile number and a code on WhatsApp; email sign-in for agencies.
2. **P5.2 Your business.** GST number (filled from the GST record), name, type, invoice email. One free week offered to new businesses.
3. **P5.3 My campaigns.** Every booking with one of Scheduled, Running or Done; "Book again" on each.
4. **P5.4 Book.**
   1. **P5.4.1** Areas picked on our map (RECALL-drawn shapes only).
   2. **P5.4.2** Hours as single hours or ready-made picks (morning rush, lunch, evening rush, dinner, late night), price band shown on each.
   3. **P5.4.3** Days and number of weeks (start at least 15 days after booking; sooner only through RECALL's team); 5 to 100 bikes.
   4. **P5.4.4** Optional monthly repeat: 6 months 8% off, 12 months 12% off.
   5. **P5.4.5** Live summary: bike-hours, plays promised, price, GST, total; blocks the next step under ₹15,000.
5. **P5.5 Your ads.** Template (logo, headline up to 30 characters, offer line up to 40, optional code and QR, 3 colour themes) or own file (a 15 s video, or a carousel of 2–5 pictures shown in turn for 15 s; 1280 × 640, no sound, up to 30 MB). Own files are the main path; templates are for brands with no ad. 2 to 5 ads; "make another version for me" button; best-practice tips; automatic rule check (no flashing, size, length).
6. **P5.6 Review and pay.** Line-by-line summary, the five plain rules (promise, edge, make-ups, late ads, report) with one tick box, pay in full by UPI, card or net banking; GST invoice at once.
7. **P5.7 Final report.** Plays delivered, different bikes, heat map, busiest streets, made-up plays, people (approximate); PDF and WhatsApp share; "Book again".
8. **P5.8 Invoices.** Invoices and credit notes, download one or all for the year.
9. **P5.9 Help and account.** Questions and answers, WhatsApp and call to the account manager, business details, team (owner, can book), ad rules.

**Agencies (P5.10).** One agency login can manage many brands; the agency's 10% is worked out and shown on its own statement, never on the brand's invoice.

**Messages (P5.11).** Only two messages per campaign, by WhatsApp and email: "Booked and paid" and "Done, here is your report". Plus reminders if ads are missing 9 and 7 days before start.

## Admin portal (P3)

The admin portal is where RECALL runs the business: fleet, areas, sales, ads, money and support. Every person sees only what their role allows, and every change is logged.

| Step | Screen | What it does | Main users |
| --- | --- | --- | --- |
| P3.1 | Sign-in and roles | Staff sign-in with two-step check; super admin (everything, sets permissions, prices and rules, payout approval, full audit log) and admins with permission areas: Sales, Ad review, Operations, Finance, Support; a read-only role; refunds and discounts need a super admin's sign-off (Prateek, 22 Oct 2026) | All |
| P3.2 | Today | Bikes online and moving now, hours sold vs delivered today, make-ups due, refunds this week, alerts | Founder, ops |
| P3.3 | Fleet map | Every screen live on the map, filter by area and status; click a bike for its history, health and commands | Ops, tech |
| P3.4 | Screens | Stock, fitting, linked bike and rider, version, health, repairs, swaps, updates rollout | Ops, tech |
| P3.5 | Areas | Draw and edit area shapes on the map, edge zone, version history, check for overlaps; add areas and turn them on or off (super admin only) | Ops, founder |
| P3.6 | Prices and rules | Price bands, offers, floor, minimums, ad deadline, trial rules; every change versioned | Founder, finance |
| P3.7 | Inventory calendar | Area × hour grid: bike-hours sold, usual bikes seen, delivered; optional manual limit; holds for a client (hours, days, bikes; no money; end at a set time; turn into a booking) | Sales, ops |
| P3.8 | Brands and bookings | Brand accounts, agencies, book on a brand's behalf with a payment link for any start date including last-minute (portal brands need 15 days), booking timeline, cancel, notes | Sales |
| P3.9 | Ad review | Queue of uploaded ads with the automatic checks; approve or reject with a reason; approve on short notice (after the 7-day deadline) with a logged reason | Ad review |
| P3.10 | Delivery and make-ups | Each booking line live: plays, bikes, shortfall, make-ups booked, refunds due | Ops, sales |
| P3.11 | Riders | Applications, KYC, documents, agreement, fitting slots, status, earnings, notes, leaving | Ops, support |
| P3.12 | Payouts | Weekly payout run: review, hold, approve, send; failures and retries | Finance |
| P3.13 | Money | Payments, invoices, credit notes, refunds, agency and aggregator statements, GST summary, exports | Finance |
| P3.14 | Reports | Final reports for every campaign, re-send, business dashboards (fill, revenue, refunds, moving hours) | Founder, sales |
| P3.15 | Support | Brand and rider requests in one inbox with WhatsApp history | Support |
| P3.16 | Audit log | Who changed what and when, searchable, cannot be edited | Founder, tech |
| P3.17 | Settings | Staff, roles, message templates, cities, connections to outside services, fitting centres (any number), support numbers and hours, the rider pay zone, the screen-loan bank | Founder, tech |

## New brand colours and design system

The new look is **"Night Signal"**: deep midnight surfaces with one electric volt-lime accent, like a lit screen on a dark road. It replaces the old amber, which sat too close to Rapido's yellow. None of the colours below is the main colour of Swiggy, Zomato, Ola, Uber, Rapido, Zepto, Blinkit, PhonePe or Paytm.

| Token | Colour | Hex | Use | Contrast |
| --- | --- | --- | --- | --- |
| Midnight | Near-black blue | #0A0E17 | Main dark surface, app bars, hero areas | Paper on it 17.6 : 1 |
| Graphite | Dark slate | #161B26 | Cards on dark, the bike-screen frame | — |
| Volt | Electric lime | #C8F54A | The one accent: main buttons, live states, highlights. Always with Midnight text | Midnight on it 15.3 : 1 |
| Volt deep | Olive | #4F6B00 | Accent text and links on light pages | 5.6 : 1 on Paper |
| Ion | Electric periwinkle | #6E7BFF (dark) / #3B47D9 (light) | Data, charts, maps, links | 5.5 : 1 / 6.2 : 1 |
| Mint | Signal green | #3DDC97 (dark) / #137A4E (light) | Done, delivered, paid | 10.9 : 1 / 4.9 : 1 |
| Flare | Warm coral | #FF6B4A (dark) / #C2341B (light) | Errors, shortfalls, alerts | 6.9 : 1 / 5.0 : 1 |
| Paper | Cool off-white | #F4F5F0 | Main light surface for portals | — |
| Ink | Deep ink | #0E121B | Text on light | 17.1 : 1 on Paper |
| Mist | Grey | #A3AAB8 (dark) / #5B6272 (light) | Quiet text, labels | 8.3 : 1 / 5.6 : 1 |

**Type.** Anek Latin for headings and text, with its sister Anek Telugu and Anek Devanagari so English, Telugu and Hindi look like one family. IBM Plex Mono for numbers in tables and bills. No Inter, no Space Grotesk: they make a product look template-made.

**Character.** Sharp 6 px corners on controls and 14 px on cards; thin 1 px lines; data in mono; one volt element per screen, never more; real photos of Hyderabad streets and riders, never stock illustrations.

**Steps.**

1. **P0.3.1** Write the colours, type, spacing and corners as code tokens shared by all apps (light and dark).
2. **P0.3.2** Build the RECALL design system (buttons, inputs, chips, tables, cards, map styles, chart colours) as a living design-system artifact.
3. **P0.3.3** New logo mark and app icon in Night Signal.
4. **P0.3.4** Redraw the 9 brand screens, then rider and admin screens, page by page, for your approval before code.

## External services to plug in later

Eleven outside services are needed. Each gets an adapter in the code with a working fake from day one, so the whole platform runs and is tested without any keys. Going live = sign the contract, add the keys, run the adapter's tests. Providers listed are candidates to compare at that time, not decisions.

| # | Need | Adapter in code | Candidates | Needed by | You must provide |
| --- | --- | --- | --- | --- | --- |
| 1 | Cloud hosting | Infrastructure files | AWS Mumbai | P1 cloud test (Mar 2027) | Company AWS account |
| 2 | Map search and street names | `maps` | Google Maps Platform, Mapbox, Ola Maps, MapmyIndia | P3 | Account and key |
| 3 | Base map tiles | `tiles` | OpenStreetMap data with MapLibre (free), or a paid style | P3 | Nothing if open data |
| 4 | WhatsApp messages and sign-in codes | `messaging.whatsapp` | Meta WhatsApp Cloud API direct, or Gupshup, Interakt, AiSensy | P4 | Verified business number, approved templates |
| 5 | SMS backup codes | `messaging.sms` | MSG91, Twilio | P4 | DLT registration (Indian SMS rule) |
| 6 | Email | `messaging.email` | Amazon SES, Postmark | P5 | Domain set-up |
| 7 | Brand payments | `payments` | Razorpay, Cashfree, PayU | P5 | Merchant account (needs company KYC) |
| 8 | Rider payouts | `payouts` | RazorpayX, Cashfree Payouts | P4 | Payout account, funded |
| 9 | Rider KYC and bank check | `kyc` | DigiLocker through a KYC provider (e.g. Signzy, IDfy, HyperVerge), penny-drop check | P4 | Contract |
| 10 | GST lookup and e-invoices | `gst` | A GST Suvidha Provider (e.g. ClearTax, Masters India) | P5 | GSTIN, GSP account |
| 11 | E-sign of rider agreement | `esign` | Aadhaar e-sign through Digio, Leegality | P4 | Contract, final agreement text |

Also needed, but not code: the screen vendor's SDK (P2), 4G SIMs with a business data plan (P2), and the partner bank's loan hand-off link or API (P4.2.6).

## Testing, quality and robustness

Nothing merges without passing its tests, and the money and play-count code is tested hardest because a bug there costs real money or trust.

| Layer | What is tested | How | Bar |
| --- | --- | --- | --- |
| Unit | Every rule: prices, floor, minimums, edge 10%, make-up order, rider pay, GST, rounding | Automatic tests on every change | 95%+ of engine and ledger code covered |
| Property | Ledger always balances; no play counted twice; plays never exceed 240 per bike-hour | Random-input tests (thousands of cases per run) | Zero failures |
| Simulation | Whole days with 200, 2,000 and 15,500 fake bikes; rain, crowds, outages | Fleet simulator, fixed random seed | Every deliverable booking delivered; results repeatable |
| Contract | Each outside-service adapter against its fake and, later, the provider's test mode | Shared test suite per adapter | Same behaviour from fake and real |
| End to end | Brand books and pays, ads approved, bikes play, report arrives; rider joins, earns, is paid | Browser and phone automation | Passes before every release |
| Device | Player on emulator, then on the sample unit: 72-hour run, signal cuts, power cuts, heat | Hardware test bench and road test | No lost plays; restarts under 5 s |
| Load | 15,500 screens sending every 30 s; payout run for 15,500 riders | Load generator | Under 1 s for app screens; no message backlog |
| Security | Sign-in, roles, screen certificates, signed plays, data access | Automatic scans + outside audit before POC | No high-risk findings open |

**Release rules.** Every change goes through a test copy first. Screens update in stages (1%, 10%, all). Every release can be undone in one step. Backups every day, tested by a monthly restore.

## Constraints and risks

I can write, test and document every line of software here. What I cannot do is touch the physical world, sign up for services in your name, or remember across conversations without written records.

| # | Constraint | Effect | What we do about it | Needs you |
| --- | --- | --- | --- | --- |
| 1 | I start each conversation without memory of the last | Work could drift or repeat | This plan + the repository's work log and decision log are my memory; I read them first every time | Keep using the same plan and repository |
| 2 | This workspace is temporary | Code left only here can be lost | Code goes to a GitHub repository after every step | A GitHub account and a private repository |
| 3 | No real screen, bike or road | I cannot prove the player on hardware | Emulator + fleet simulator now; sample unit on a test bench; your team runs the road test | One sample screen kit with SDK; a technician |
| 4 | I may not create accounts or enter passwords and payment details | I cannot open AWS, Razorpay, WhatsApp, KYC accounts | Fakes for everything; you create accounts and put keys in the secret store | Company accounts and keys (after incorporation) |
| 5 | People-count accuracy depends on real street footage | The counting model needs tuning | Start from a ready-made person-detection model; tune on the test bench with consent; counts stay "approximate" | Legal check 9 (DPDP) before any street test |
| 6 | Legal and tax rules (DPDP, ad permits, GST e-invoice, TDS on rider pay, gig-worker levy) | Wrong rules mean fines | Every rule is a setting, not hard code; marked "confirm with CA / lawyer" in the decision log | Your CA and lawyer to confirm |
| 7 | Play Store publishing and screen certificates need company accounts | Apps cannot reach riders | Rider app first shared as a direct install for the POC; screens installed at our warehouse | Google Play developer account |
| 8 | Very large code in one go is error-prone | Bugs hide in big changes | Small steps, each with tests, each reviewed by a second agent before merge | Your approval at each checkpoint |

**Where to build.** Plans, designs, documents and decks are best made here in Cowork. The coding phases (P1 onward) are better in **Claude Code**: it works directly in a real repository, runs long builds and tests, uses git, keeps files between sessions and can install the Android tools. Recommended set-up: this plan stays the source of truth; the code lives in one GitHub repository that Claude Code works on.

## Roadmap

The engine is done and proven by the end of February 2027, the POC is ready by 31 July 2027, and brands self-serve from November 2027. We start now, five months before the CTO joins, so the team inherits working, tested code.

&#91;embedded content: build roadmap · 9 phases, 4 gates\]

Phases overlap on purpose: each starts once the part it depends on is stable, not finished.

| Step | What | Status | Target |
| --- | --- | --- | --- |
| P0.1 | This build plan | Done | Oct 2026 |
| P0.2 | Repository, automatic checks, record files | Done | Oct 2026 |
| P0.3 | Night Signal design system, logo, screens redrawn | Done | Oct 2026 |
| P1.10 | Fleet simulator (built alongside the engine) | Done | Nov 2026 onward |
| P1.1–P1.2 | Areas and GPS | Done | Nov 2026 |
| P1.3 | Inventory, prices, bookings | Done | Dec 2026 |
| P1.4 | Ad scheduler | Done | Dec 2026 – Jan 2027 |
| P1.5–P1.6 | Play counting, make-ups, refunds | Done | Jan 2027 |
| P1.7 | Ledger, GST, rider earnings, payouts | Done | Jan – Feb 2027 |
| P1.8–P1.9 | People counts, final report | Done | Feb 2027 |
| P2.1–P2.8 | Player on emulator | Done | Jan – Feb 2027 |
| P2.9–P2.14 | Counter, health, updates, fitting check on the sample unit | Code done except the people counter (P2.9); proof on the sample unit blocked | Mar – Apr 2027 |
| P3 | Admin portal | Done | Feb – May 2027 |
| P4 | Rider app | Done (phone notifications and real sign-in messages wait for the outside accounts, P6) | Mar – Jun 2027 |
| P6 | Real integrations (needs company accounts) | Blocked | Mar – Jul 2027 |
| P7 | Hardening, load test, security audit, POC readiness | Doing (P7.1–P7.3 done; P7.4–P7.5 next; road test needs bikes) | Jun – Jul 2027 |
| P5 | Brand portal for self-serve | Done (real payments, GST lookups and messages wait for the outside accounts, P6) | Jul – Oct 2027 |

## Records for a human takeover

A new engineer should be able to read four files and start work the same day. The repository carries them, and every step updates them.

| File | What it holds | Updated |
| --- | --- | --- |
| `README.md` | What RECALL is, how to run everything on a laptop in one command, where things live | When set-up changes |
| `docs/ARCHITECTURE.md` | Services, data model, the device link, diagrams, why each choice was made | Every phase |
| `docs/DECISIONS.md` | One entry per decision: date, choice, options weighed, reason, who decided (e.g. "no sell cap, 21 Oct 2026, founder") | Every decision |
| `docs/WORKLOG.md` | Dated entries per step id: what was built, tests added, open issues, next step | Every step |
| `docs/RUNBOOKS/` | How to: deploy, roll back, add an area, run payouts, replace a screen, handle an outage | When each operation exists |
| `docs/API.md` | Every API and device message, generated from the code | Every change, automatically |

**Repository layout (monorepo).** `apps/brand`, `apps/admin`, `apps/rider`, `apps/player` (Android), `services/api`, `services/gateway`, `services/scheduler`, `services/ledger`, `services/workers`, `packages/domain` (shared rules and types), `packages/design` (Night Signal tokens), `packages/adapters` (outside services with fakes), `tools/simulator`, `infra/`.

## Change log

| Date | Version | Change |
| --- | --- | --- |
| 22 Oct 2026 | 1.9 | Prateek: forecast only after the POC (a price-book setting, POC mode first); 6/12-month deals: no discount on Lite hours, hours spread about equally over the months (±20%, a setting), discount on the bill; aggregator ads are free. |
| 22 Oct 2026 | 1.8 | Prateek: sell only what an area can deliver (supply forecast, P1.3.7; replaces "no sell cap"); drafts reserve nothing, offers and suggestions when a request doesn't fit; the 40 RECALL spots: make-ups → aggregator ads → RECALL ads; 6-month deals priced on total hours with the discount on the bill; drafts are always paid at the prices in force. |
| 22 Oct 2026 | 1.7 | Prateek's answers: POC pay zone 15 km around Hitech City; after the POC, the areas that are on (plus exceptions); POC pay once a month after it ends; TDS on rider pay; settings for fitting centres, support numbers and hours (10 am–7 pm), the loan bank (Dhanlaxmi Bank). |
| 22 Oct 2026 | 1.6 | P1.1.6 and P3.5: a super admin adds areas and turns them on or off (Prateek). |
| 22 Oct 2026 | 1.5 | P0.3 done: all screens approved (brand 9, rider 12, admin 16). P1.7.4: cuts on delivered value (Prateek). P1.1, P1.2 and P1.10 started. |
| 22 Oct 2026 | 1.4 | P1.7.6: founding bonus only at 150+ moving hours, no part bonus (Prateek's decision of 22 Oct, already in DECISIONS; the plan line had been missed). |
| 22 Oct 2026 | 1.3 | P3: super admin, admins with permission areas and a read-only role; super admin sign-off for refunds and discounts; client holds; admin bookings for any start date (portal brands 15 days); short-notice ad approval (Prateek). |
| 22 Oct 2026 | 1.2 | P5.5: brands upload their own video or a picture carousel as the main path; templates optional; colour and legibility advice is best practice, not enforced (Prateek). P0.2, P0.3.1–P0.3.3 done. |
| 22 Oct 2026 | 1.1 | P0.3 started: Night Signal applied to the RECALL design system (colours, Anek type, recoloured Afterimage logo, all previews), the investor deck (Google Slides and the PowerPoint in Recall Final), and all 12 screens on the design canvas. Price band name fixed to "Lite". |
| 22 Oct 2026 | 1.0 | First full build plan: build order, architecture, the six engines, screen, rider app, brand portal, admin portal, Night Signal colours, outside services, testing, constraints, roadmap, records. Based on rulebook v5.4 and model v5.3. |
