# RECALL model v5.2 (18 Oct 2026) — THE single source of truth

Replaces v5.1 (MODEL_V5.md) and every earlier model wherever they differ. When an older doc says something different, v5.2 wins.
Master document: "RECALL — Unit economics and cash plan (final)", Claude Doc https://claude.ai/code/artifact/ac02f3a6-c629-4829-9677-94a88ff9dcb6 (updated to v5.2 by the main session).
Write plain, short English. ₹, L = lakh, Cr = crore. Round numbers for the reader (per bike to ₹100, months to ₹1 L, years to ₹1 Cr or 0.1 Cr below 10).
Model script: scratchpad/ue/m15.py (scenario() defaults = plan). Monthly data (₹ lakh, Oct 2026–Dec 2031): scratchpad/ue/v52_plan.json, v52_55.json, scratchpad/v52_monthly.csv. Same fields as v5.1 plus: tech (tech line total), techteam (tech team pay), techpeople, platform (cloud, storage, AI tokens, tools), sim (screen SIM data), build (one-time platform build), ri (salary raise index). "team" is now NON-TECH team and office (incl. founder). "perbike" now = warranty, insurance, permits, refits, support desk (platform and SIM moved to tech).
Ready-made markdown tables: scratchpad/v52/month_table.md (month by month bank), v52/per100_month.md, v52/per100_year.md. Chart data: scratchpad/v52/gen.json (keys bank, profit).

## What changed from v5.1 (the five decisions of 18 Oct 2026)
1. Founder salary ₹2.5 L a month from January 2027 (was ₹2 L from February). No raises for the founder in the plan.
2. The founder spends nothing out of pocket. The ~₹6.5 L of costs before the seed (legal checks, company set-up, pitch) are billed to RECALL and paid from the seed at close in January 2027. Money in the bank is never below zero.
3. Tech is its own line: tech team at real pay + platform running + screen SIM data. CTO ₹4.5 L a month (was ₹3.5 L). Before, engineers sat inside "team, tech, office" at the ~₹1 L average; now they are counted at what they really cost.
4. Salary raises: 10% every April from April 2028, compounding (×1.10 Apr 2028, ×1.21 Apr 2029, ×1.33 Apr 2030, ×1.46 Apr 2031) on all staff pay: tech team, non-tech team (not founder), field technicians, support desk. Rider pay is earnings, not salary, and is unchanged.
5. Seed raised to ₹5 Cr (was ₹4.5 Cr) so the least money in the bank stays at ₹1.87 Cr. Round 2 stays ₹3 Cr (March 2028). Total ₹8 Cr. With ₹4.5 Cr the low would be ₹1.37 Cr — less than one month of spending at that point.
Effect: first profitable month April 2028 (was March); profit per bike at 2,000 bikes ₹5,000 (was ₹6,200); break-even share sold 51% at 2,000 bikes (was 46%); 2031 profit before tax ₹149 Cr (was ₹171 Cr).

## What RECALL is
Moving LED screens (28-inch, P2.5) on delivery and bike-taxi two-wheelers in Hyderabad. Brands pay only for GPS-verified moving bike-hours, never per view. Video, geofenced hours, per-hour proof-of-play and audience analytics (estimates, no cameras).

## Selling (unchanged)
- Business day 8 am–2 am, six 3-hour windows. Peak ₹300 a full bike-hour (₹30 a share): W1 08–11, W4 17–20, W5 20–23. Normal ₹250 (₹25 a share): W2 11–14, W3 14–17. Lite ₹220 (₹22 a share): W6 23–02. Day-average list ≈ ₹275.
- One bike-hour = 240 spots of 15 s: 10 brand shares × 20 plays (200) + 40 RECALL spots. ₹250 an hour = ₹1.25 a play.
- Brands buy a share or the full hour, delivered anywhere in the 3-hour window; shortfall replayed from RECALL spots, else refunded. Bookings close 15 days before go-live; creatives 7 days before. No deal below ₹22 a share.
- Revenue counted: ₹250 × 70% sold = ₹175 billed per moving bike-hour. Cuts: 10% agency on every deal + 2% aggregator (Swiggy, Zomato, Ola, Uber etc.) on referred brands; plan budgets 12% on everything → we keep ₹154 per moving hour, ₹32,300 a bike a month.
- Moving hours: 210 a bike a month (10-minute stop rule). Rider paid hours capped at 260 a month.

## POC (unchanged)
40 brands × ₹2.5 L a month × 3 months (Aug–Oct 2027) = ₹3 Cr. 200 bikes. Agency cut in POC 4.5%. Hyderabad geofence from day one.

## Riders (unchanged)
- POC flat ₹8,000 / ₹10,000 / ₹12,000 (base ₹2,000/₹4,000/₹6,000 + ₹6,000 founding bonus; bonus in full only for 150+ verified moving hours, pro rata 100–150, nothing below 100). Day-90 bonus ₹3,000 into the screen loan.
  - **Changed 22 Oct 2026 (Prateek):** the bonus needs 150 moving hours minimum; no part bonus below 150. Only moving hours as RECALL calculates them count, inside Hyderabad during the POC (radius to be confirmed). See DECISIONS.
- After POC: ₹25 a moving hour + 25% of what his hours sell ≈ ₹13,350 a month; ≈ ₹12,000 in hand during the 36-month EMI (≈ ₹1,370) after a 3-month holiday.
- Screens: RECALL buys (₹31,000 + GST), sells to rider; partner bank lends to the rider and pays RECALL as seller; loans/EMIs never on RECALL's books; 5% first-loss deposit ₹1,830 per new bike; ₹46.5 L back for ~150 POC screens in Nov 2027; ~2 months of screen stock held.
- Rider pay ≈ 37% of every ₹100 billed. Total rider pay: 2028 ₹19 Cr, 2029 ₹67 Cr, 2030 ₹161 Cr, 2031 ₹233 Cr.

## Costs
- Before the seed (Oct–Dec 2026): ₹6.5 L of legal checks, company set-up and pitch costs, paid by RECALL from the seed at close (Jan 2027). Founder pays nothing.
- January 2027 (seed month): ₹9 L = those ₹6.5 L + founder salary ₹2.5 L.
- Before the POC (Feb–Jul 2027): ₹2.44 Cr. Items (₹ L): 200 LED kits + 5% spares 65.1; one-time platform build 25.0; CTO from March (₹4.5 L a month) 22.5; 3 engineers from April 18.0; founder ₹2.5 L a month 15.0; sales lead (from Feb) + 2 executives (from May) 12.6; warehouse fit-out 10.0; platform running during build (cloud, creative storage, AI tokens, tools) 8.5; warehouse deposit 8.0; legal 8.0; office 6.0; sales collateral 5.0; product designer (contract) 4.0; ops lead + warehouse manager 4.5; warehouse rent Jun–Jul 3.6; hiring fees 3.0; device samples/road test 3.0; rider recruitment 2.6; spare batteries + tools 2.5; fitting crew 1.5; buffer 10% (ex screens) 16.0; total 244.4. Of this, tech = 78.0 (CTO 22.5, engineers 18.0, designer 4.0, build 25.0, running 8.5). GST on screens ₹11.7 L paid Jul, back Oct.
- POC (Aug–Oct 2027): ₹1.95 Cr. Rider pay 60.9; tech team (CTO + 4 engineers) 31.5; non-tech team (founder, ops, sales, 2 account managers, finance) 24.3; brand creative/launch/reports/marketing 8.1; warehouse running 7.7; screen SIMs, cloud, licences 6.3; field team 5.8; day-90 bonus 4.5; AI tokens + support-desk tools 3.0; office 3.0; insurance 3.0; permits 3.0; support desk 2 agents 1.8; screen loss 1.2; buffer 17.3; agency 4.5% 13.5; total 194.9.
- After the POC, per bike a month: warranty ₹250, insurance ₹120, permits/ad-tax provision ₹300, refits ₹60, support desk ₹60 (+ raises), field ops ₹900 (technician part + raises; + ₹3 L a month per city hub). Per-bike costs 30% higher in 2027–28, 15% higher in 2029. Onboarding ₹2,500 per new bike. Sales team 8%, gateway + bad debt 3%, marketing 3% in 2028 then 2%. Buffer 10% of costs 2027–28, 7% 2029, 5% after. Tax 25.17% after past losses are used. Interest on cash NOT counted. New city launch ₹75 L (Mumbai ₹1 Cr).
- Non-tech team and office: founder ₹2.5 L + other staff at ~₹1 L a person all-in (2027 pay), with 10% raises every April from 2028. Non-tech people (incl. founder): end-2027 29, 2028 51, 2029 114, 2030 188, 2031 220. A month: ₹30 L (Dec 2027), ₹57 L (Dec 2028), ₹1.39 Cr (Dec 2029), ₹3.2 Cr (Dec 2031).

## Tech (new, own line)
- Tech team (pay a month before raises; +10% for benefits, laptops and tools after the POC; 10% raises every April from 2028):
  - Mar 2027: CTO ₹4.5 L. Apr–Jul 2027: + 3 engineers at ₹1.5 L (+ product designer on contract Apr–May ₹2 L a month). POC (Aug–Oct 2027): CTO + 4 engineers (₹10.5 L a month).
  - Nov 2027: 6 people (CTO, 4 engineers, 1 tester). Jan 2028: 9 (CTO, 6 engineers, tester, designer). Jul 2028: 11 (+ data and DevOps engineers). 2029: 15 (+ engineering manager, 9 engineers, 2 testers, data analyst, designer). 2030: 21. 2031: 24.
  - Tech team cost a month: ₹12 L (Dec 2027), ₹23 L (Dec 2028), ₹35 L (Dec 2029), ₹67 L (Dec 2031).
- One-time platform build ₹25 L (Mar–Jul 2027): outside developers ~₹15 L (6–8 developer-months), screen software and remote updates ₹3 L, maps/payments/WhatsApp/GST-invoice set-up ₹1.5 L, security audit ₹2 L, audience-count analytics ₹1.5 L (estimates, no cameras), test phones and SIMs ₹1 L, AI coding tools ₹1 L.
- Platform running: ₹8.5 L during the build; ~₹1.8 L a month in the POC (cloud, AI tokens, support tools); then ₹3 L a month fixed + ₹60 a bike (×1.3 2027–28, ×1.15 2029): cloud servers and database, creative storage and downloads, AI tokens, software tools, monitoring, security audits. ₹4.6 L a month at 2,000 bikes, ₹7.4 L at 6,300, ₹11.8 L at 15,500.
- Screen SIM data: ₹150 a bike a month (×1.3 / ×1.15) — about 1–3 GB a month per screen because screens save ads and replay them.
- Tech totals (₹ L): 2027: team 101, build 25, running 20, SIM 5 = 151. 2028: 246 + 0 + 47 + 28 = 321. 2029: 415 + 0 + 70 + 85 = 571. 2030: 622 + 107 + 179 = 908. 2031: 780 + 134 + 245 = 1,160. First three years (2027–29): ₹10.4 Cr, about 73% of it people.
- Tech per ₹100 billed: 2027 ₹34 (build year), 2028 ₹6.2, 2029 ₹3.1, 2030 ₹2.1, 2031 ₹1.8. Dec 2028: ₹4.3 of every ₹100; ₹1,600 a bike a month; ₹7.5 a moving hour (of ₹175 billed). Cloud + SIM alone ≈ ₹2 a moving hour.
- Cloud storage: counted inside platform running. Data kept (with a backup copy): ~0.1 TB end-2027, ~1 TB end-2028, ~5 TB end-2029; cost ~₹2k, ₹6–10k and ~₹25k a month — under ₹0.02 of every ₹100. The hidden part is sending ads to screens (downloads), about ₹2 a bike a month.
- Tech rules: (1) screens save ads and replay them, never stream; (2) no cameras — audience counts are estimates, no video uploads (DPDP Act); (3) build our own simple remote screen updates, or pay no more than ₹50 a screen a month for a service (renting at ₹100–250 a screen would cost up to ₹9.5 L a month more by 2029); (4) CTO reviews the cloud bill every month; (5) rent commodity parts (maps, payments, WhatsApp, messaging), build what makes RECALL special (hours stopwatch, ad timetable, booking portal).
- Stress test: if tech pay ran 30% higher and cloud and screen data cost double up to Feb 2028 (≈ +₹80 L with buffer), the least money in the bank would fall from ₹1.87 Cr to about ₹1.05 Cr — still positive.

## One bike, one month (70% sold, rounded)
| | 2,000 bikes (Dec 2028) | 6,300 (Dec 2029) | 15,500 (Dec 2031) |
| Billed | 36,750 | 36,750 | 36,750 |
| We keep (88%) | 32,300 | 32,300 | 32,300 |
| Rider incl. gig fee | −13,500 | −13,500 | −13,500 |
| Tech: engineers, platform, screen data | −1,600 | −900 | −600 |
| Screen upkeep and support desk | −1,000 | −900 | −800 |
| Field ops | −1,200 | −1,200 | −1,300 |
| Sales team 8% | −2,600 | −2,600 | −2,600 |
| Gateway + bad debt 3% | −1,000 | −1,000 | −1,000 |
| Marketing | −1,000 | −600 | −600 |
| Team and office (non-tech) | −2,800 | −2,200 | −2,100 |
| New bikes and new cities | −200 | −600 | 0 |
| Buffer | −2,500 | −1,600 | −1,100 |
| Profit before tax | 5,000 (15%) | 7,300 (22%) | 8,700 (27%) |
| Profit after tax | 3,700 | 5,400 | 6,500 |
| Break-even share sold | 51% | 43% | 39% |
Margins are of what we keep. An hour that moves but doesn't sell costs ₹25; an hour that sells adds ≈ ₹70 profit.
Profit per bike vs share sold (₹, Dec 2028 / Dec 2029 / Dec 2031): 50% −300 / 1,800 / 3,200; 55% 1,000 / 3,200 / 4,500; 70% 5,000 / 7,300 / 8,700.
Note: break-even at 2,000 bikes (51%) is now close to the 55% bike gate — the gate matters more.

## Where every ₹100 billed goes (Dec 2028, 2,000 bikes)
Agency 10, aggregator 2, rider 37, team and office 8, tech 4, field/screens/support 7, sales+gateway+marketing 12, buffer 7, tax 3, profit 10. Per moving hour (₹175): 17, 4, 64, 13, 8, 12, 21, 12, 6, 18.
Year by year (from Aug 2027; billed ₹ Cr 2027 4.5, 2028 52, 2029 182, 2030 437, 2031 633) — agency/aggregator/riders/team & office/tech/field/sales & marketing/new cities/buffer/tax/profit:
2027 (Aug–Dec): 6/1/27/20/16/9/6/0/8/0/8. 2028: 10/2/37/10/6/7/12/0/7/1/7. 2029: 10/2/37/6/3/6/11/1/5/5/14. 2030: 10/2/37/6/2/6/11/0/3/6/17. 2031: 10/2/37/6/2/6/11/0/3/6/18.
The ₹2.5 Cr spent before the POC (Jan–Jul 2027) comes from the seed.

## Funding: ₹8 Cr in two rounds
- Round 1 seed ₹5 Cr, Jan 2027 (talks Oct–Dec 2026). Pays the ₹6.5 L pre-seed costs, platform build, warehouse, 200 screens, POC and cooling months. Least money in the bank ₹1.87 Cr (Feb 2028).
- Round 2 ₹3 Cr, Mar 2028 (talks from Oct 2027 with POC data). Growth to 2,000 bikes, screen stock, bank deposits, Bengaluru launch.
- Most cash the plan uses: ₹3.2 Cr (70% sold); ₹4.1 Cr at 60%; ₹5.6 Cr at 55%; ₹8.5 Cr at 50%. At 50% sold the bike gate (55%) stops growth; if we grew anyway, round 2 would have to be ₹4 Cr.
- Use of seed (₹5 Cr): pre-seed costs ₹6.5 L + founder Jan ₹2.5 L; before the POC ₹2.44 Cr (tech ₹78 L incl. ₹25 L build and ₹8.5 L running; 200 screens ₹65 L; founder ₹15 L; warehouse ₹22 L; sales, legal, office, other + buffer); POC brings in more than it costs; cooling-period screen stock ₹93 L; ≈ ₹1.9 Cr left at the lowest point.

## MAIN TABLE: money in the bank at each milestone (₹ lakh)
| # | Milestone | When | Money raised | Money spent | (founder salary inside) | Money earned | Money in the bank | Bikes |
| 1 | Before seed (RECALL pays these from the seed) | Oct–Dec 2026 | — | 0 | — | 0 | 0 | 0 |
| 2 | Seed round 1 | Jan 2027 | 500 | 9 | 2.5 | 0 | 491 | 0 |
| 3 | Platform built, just before POC | Feb–Jul 2027 | — | 256 | 15 | 0 | 235 | 200 fitted |
| 4 | POC ends | Aug–Oct 2027 | — | 183 | 7.5 | 300 | 352 | 200 |
| 5 | Cooling period ends | Nov–Dec 2027 | — | 293 | 5 | 176 | 235 | 200 |
| 6 | 2 months of main business | Jan–Feb 2028 | — | 323 | 5 | 275 | 187 | 500 |
| 7 | Round 2 + 3 months of main business | Mar 2028 | 300 | 216 | 2.5 | 210 | 481 | 650 |
| 8 | 6 months of main business | Apr–Jun 2028 | — | 885 | 7.5 | 922 | 518 | 1,100 |
| 9 | 1 year of main business | Jul–Dec 2028 | — | 2,839 | 15 | 3,153 | 833 | 2,000 |
| | Total to Dec 2028 | | 800 | 5,003 | 60 | 5,036 | 833 | |
Lowest money in bank: ₹1.87 Cr (Feb 2028). First profitable month: April 2028. Money spent Feb–Jul includes ₹11.7 L GST on screens (back in Oct, inside POC spent).

## If sales are slower (money in the bank, ₹ lakh)
| Share sold | Least money in bank | Least after round 2 | Dec 2028 | Most cash used | First profitable month |
| 70% plan | 187 (Feb 2028) | 481 (Mar 2028) | 833 | ₹3.2 Cr | Apr 2028 |
| 60% | 154 (Feb 2028) | 394 (Jun 2028) | 501 | ₹4.1 Cr | Jul 2028 |
| 55% | 138 (Feb 2028) | 235 (Mar 2029) | 311 | ₹5.6 Cr | Sep 2028 |
| 50% | −52 (Mar 2029) if growth continued | −52 (Mar 2029) | 121 | ₹8.5 Cr | Mar 2029 |
At 50% the bike gate pauses growth, so the last row is a "what if we ignored our own rule" case; with a ₹4 Cr round 2 it stays positive.

## Five years
| Year | Bikes (Dec) | Cities | Revenue we keep | Money earned | Money spent | Raised | PBT | PAT | Bank (Dec) |
| 2026 | 0 | — | 0 | 0 | 0 | — | 0 | 0 | 0 |
| 2027 | 200 | 1 | ₹4.3 Cr | ₹4.8 Cr | ₹7.4 Cr | ₹5 Cr | −₹2.2 Cr | −₹2.2 Cr | ₹2.3 Cr |
| 2028 | 2,000 | 1 | ₹46 Cr | ₹46 Cr | ₹43 Cr | ₹3 Cr | ₹4.1 Cr | ₹3.6 Cr | ₹8.3 Cr |
| 2029 | 6,300 | 2 | ₹160 Cr | ₹160 Cr | ₹138 Cr | — | ₹34 Cr | ₹25 Cr | ₹30 Cr |
| 2030 | 12,450 | 4 | ₹385 Cr | ₹385 Cr | ₹310 Cr | — | ₹99 Cr | ₹74 Cr | ₹104 Cr |
| 2031 | 15,500 | 5 | ₹557 Cr | ₹557 Cr | ₹443 Cr | — | ₹149 Cr | ₹112 Cr | ₹218 Cr |
Billed (before cuts): 2027 ₹4.5 Cr, 2028 ₹52 Cr, 2029 ₹182 Cr, 2030 ₹437 Cr, 2031 ₹633 Cr. Tax paid: 2028 ₹0.5 Cr, 2029 ₹8.5 Cr, 2030 ₹25 Cr, 2031 ₹38 Cr.
Headcount (tech + non-tech incl. founder; field technicians and support agents extra): 2027 6 + 29 = 35; 2028 11 + 51 = 62; 2029 15 + 114 = 129; 2030 21 + 188 = 209; 2031 24 + 220 = 244.

## Timeline
- Oct–Dec 2026: pitch; legal checks (ads on private bikes, lit rear screens, 8–12 weeks); partner bank via founder's contacts; CTO search. Costs (~₹6.5 L) billed to RECALL, paid at seed close. Founder pays nothing.
- Jan 2027: ₹5 Cr seed closes; founder salary ₹2.5 L a month starts. Feb 2027: sales lead joins and starts selling the POC.
- Mar 2027: CTO joins (₹4.5 L a month); platform build starts with outside developers. Apr: 3 engineers; device samples, 2-week road test. May: ops lead, 2 sales execs.
- Feb–Jul 2027: sign 40 founding brands at ₹2.5 L a month; pre-sell Nov–Dec hours.
- Jun 2027: warehouse opens; 200 screens ordered. Jul 2027: fitting, 20-bike dry run; GST on screens paid (back Oct).
- Aug–Oct 2027: POC live. Oct 2027: round 2 talks start; day-90 bonus.
- Nov–Dec 2027: cooling — ~150 riders take screens on bank loans (₹46.5 L back), 3-hour-window selling starts, ₹93 L screen stock, EMI holiday Nov–Jan.
- Jan 2028: main business; Hyderabad +150 bikes a month → 2,000 by Dec 2028. Mar 2028: ₹3 Cr round 2. Apr 2028: first profitable month; first salary raises (10%).
- 2029: Hyderabad +200 a month to 5,000 (Mar 2030); Bengaluru Apr 2029. 6,300 bikes. 2030: Pune Jan, Chennai Apr. 12,450 bikes. 2031: Mumbai Jan. 15,500 bikes in 5 cities.
- New city opens only after the cities before it are profitable 3 months in a row.

## Brands (unchanged)
Hyderabad pool ~2,600–4,100 (our estimate). Target Dec 2028 ≈ ₹7.5 Cr billed a month = 15 large (₹10 L) + 100 mid (₹3 L) + 600 small (₹50,000) ≈ 715 brands. Winning and keeping brands ≈ ₹21 of every ₹100 billed (agency 10%, aggregator 2%, sales 8% of kept, marketing 2–3%) + discount room ≈ 9%.

## Rules that protect the plan
Bike gate 55% (break-even at 2,000 bikes is 51%, so the gate is close — watch it monthly). Rider paid hours cap 260. Geofence. Refunds for shortfall. Booking gate 15/7 days. New city only after previous cities profitable 3 months running. No deal below ₹22 a share. Golden rule paused until the first profitable month (Apr 2028), then every city every year. Tech rules as above (save-and-replay, no cameras, own remote updates, monthly cloud review). Salary raises 10% each April, budgeted.

## Competitor reference (keep short)
AdOnMo FY25 revenue ₹134.4 Cr, loss ₹33.1 Cr (Inc42); ~50,000 mostly fixed screens. Gojek GoScreen (Jakarta, 2020): motorbike top-box screens, sold reach not hours; a side project for Gojek, no public news since 2021.

## Risks to be honest about
Fill (70%) is the key assumption — break-even 51% at 2,000 bikes. Regulatory (ads on private two-wheelers, lit rear screens, GHMC permits). Rider supply/churn; bank partner; screen durability; GPS fraud; aggregator policies. Tech: build overrun (₹25 L is lean — basic version only), rented screen-management costs, cloud overruns (small in rupees), CTO hiring at ₹4.5 L a month.

## Stale files that must not confuse investors
Google Doc 1vypP_YN57BsHKAabwg2lk56GO4DQm0rpxlIEuiJ5Ta8 and Google Sheet 1oMYoJSHJSJljcgM-QdX6LSuYTX8gXMyDZCyaijB5VE4 (already renamed "[OLD – superseded…]").
