# Work log

Newest first. Each entry: date · step id · what changed · tests · open issues · next.

## 26 Oct 2026 · P3.6 · Prices and rules
- P3.5 merged (PR #50). Slow test groups (report PDF, scheduler property tests) now have 20 s on the CI machine.
- **The editor** (`packages/domain/src/price-editor.ts`): `applyPriceChange` makes the next price book version from the current one (or, when none was ever saved, the plan's book) with only the asked settings changed: band prices, which band each start hour sells in, deal offers, the deal spread, the floor, minimum bikes and spend, the portal lead time, the ad deadline, the trial length and bike-hours. Every other setting (plays, make-ups, rider pay, taxes, reports) is carried over. `checkPriceChange` = the price book rules plus page rules (limits against typing slips, ads due before the portal lead time, offers 2–36 months). `describePriceChange` gives each change in words (before → after).
- **Records**: each price book version keeps why it was saved (migration 0031); `priceBookRecords` gives every version with who, when and why.
- **API** (`services/api/src/prices-api.ts`): `GET /prices` (every version with what changed; the one in force; the plan's book while none is saved), `POST /prices/check` (problems and changes, nothing saved), `POST /prices` (super admin, with a reason). A change starts now; the page sends the version it showed, so a save made meanwhile by someone else means "reload", never an unseen overwrite. Unknown settings are refused, not ignored.
- **Admin site**: the Prices page (Sales, Finance and super admins see it): bands and hours, offers (add, remove), floor, booking rules, trial; Check shows the rules' verdict and a before/after table; Save with a reason; every version listed with who, when, why and what changed. Before the first version, a super admin starts with the plan's prices. Typed rupees and percents are read exactly (no float).
- Tests: domain 5 (first version is the plan's book; only asked settings change; refusals; any mix of hours keeps each hour in one band, property test; words); API 5 (who may look and save; a change checked then saved from now; refusals with why; two saves at once; a version set for later blocks, versions cannot be edited or deleted); admin unit 3; browser 1 (start with the plan's prices, a price under the floor refused by Check, a change saved and listed).
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
