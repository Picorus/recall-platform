# RECALL model v5.3 (19 Oct 2026) — THE single source of truth

v5.3 = v5.2 (scratchpad/MODEL_V52.md) + an AI camera on EVERY screen. Everything in MODEL_V52.md stays true EXCEPT the items listed here; where they differ, v5.3 wins.
Model script: scratchpad/ue/m16.py. Monthly data: scratchpad/ue/v53_plan.json, v53_55.json, scratchpad/v53_monthly.csv (new fields: camera = camera cash at fitting, dep = camera write-off in profit). Tables: scratchpad/v53/month_table.md, per100_month.md, per100_year.md. Chart data: scratchpad/v53/gen.json.

## The decision (19 Oct 2026)
- Every screen carries an AI camera module (a small camera + a small AI chip), on all bikes (the old 1-in-5 plan is dropped).
- The camera counts people on the bike itself. Each picture is held in the chip's memory for well under a second, turned into a number, then deleted. Video is never stored, never sent and never seen by anyone. Only the count leaves the bike, encrypted, with time and place: e.g. "Madhapur, 17:10–17:11, about 40 people facing the screen".
- No face recognition, no identifying anyone, no number-plate reading. A sticker on every screen: "This screen counts people. It records nothing." A line in the rider agreement. Legal check 9 (DPDP Act 2023) confirms the set-up before the POC.
- Counts are proof in brand reports, never what we bill. Billing stays bike-hours.
- Cost: about ₹3,000 + GST per camera module (estimate; to be confirmed with sample quotes; an earlier quote for a plain 2 MP camera was ₹2,700–3,800). The camera belongs to RECALL; the rider's screen loan stays ₹31,000 and his EMI (~₹1,370) is unchanged.
- POC: 210 kits now ₹34,000 each (screen + camera) → ₹71.4 L (was ₹65.1 L); GST on kits ₹12.9 L (was ₹11.7 L), paid Jul, back Oct 2027.
- After the POC: ₹3,000 cash per new bike at fitting (2028 ₹54 L, 2029 ₹1.3 Cr, 2030 ₹1.8 Cr, 2031 ₹0.9 Cr). In profit, written off over 36 months (₹83 a camera a month): 2028 ₹10 L, 2029 ₹39 L, 2030 ₹97 L, 2031 ₹1.3 Cr. About ₹0.3 of every ₹100 billed.
- Power: the camera and AI chip draw about 1–2 W against the screen's ~50 W average — the 11-hour battery holds.
- Data and cloud: a count is a few bytes; no change to SIM or cloud costs.
- Platform build: the ₹1.5 L "audience-count analytics" line now means fitting a ready-made people-counting model onto the AI chip and the counts dashboard; the CTO confirms it on the 2-week road test (April 2027).
- Tech rule (2) is now: "Cameras count on the bike; video is never stored or sent; only encrypted counts leave the bike; no face recognition." Replace every "no cameras" / "audience estimates" wording with this.

## How the chip counts (plain words, for docs and Q&A)
1. The camera takes a small, low-resolution picture of the street behind the bike, a few times a second.
2. The AI chip runs a small trained program (a person-detection model) that marks the shape of each person in the picture — head and shoulders — and checks which way they face.
3. It adds people facing the screen, and avoids counting the same person twice in the next pictures by following each shape for a moment.
4. The picture is then wiped from memory; it never touches storage. Only "how many people, this minute, here" is kept.
5. Once a minute the screen sends those numbers, encrypted, with the GPS location, to our platform. Reports show "about 1,200 people saw your ad in Madhapur this week".
The counts are estimates (rain, glare, crowds and night lower accuracy), so they are proof in reports, never the bill.

## Numbers that change (v5.2 → v5.3)
- Before the POC (Feb–Jul 2027): ₹2.51 Cr (was ₹2.44 Cr). Kits line: "200 LED kits + 5% spares, each with an AI camera" 71.4. Buffer 16.0. Total 250.7. Tech inside it still 78.0.
- POC (Aug–Oct 2027): unchanged ₹1.95 Cr.
- Seed ₹5 Cr + round 2 ₹3 Cr = ₹8 Cr (unchanged). Lowest money in the bank ₹1.71 Cr (Feb 2028) (was ₹1.87 Cr). With a ₹4.5 Cr seed it would be ₹1.21 Cr. First profitable month: April 2028 (only just, ~₹2.6 L).
- Most cash used: ₹3.4 Cr (70%), ₹4.4 Cr (60%), ₹6.4 Cr (55%), ₹9.3 Cr (50%, if we kept adding bikes). At 50% round 2 would have to be ₹4.5 Cr (was ₹4 Cr).
- Stress test (tech pay +30%, cloud and screen data ×2 to Feb 2028, ≈ +₹80 L with buffer): low falls from ₹1.71 Cr to about ₹0.9 Cr — still positive.

### MAIN TABLE: money in the bank at each milestone (₹ lakh)
| # | Milestone | When | Money raised | Money spent | (founder salary inside) | Money earned | Money in the bank | Bikes |
| 1 | Before seed (RECALL pays these from the seed) | Oct–Dec 2026 | — | 0 | — | 0 | 0 | 0 |
| 2 | Seed round 1 | Jan 2027 | 500 | 9 | 2.5 | 0 | 491 | 0 |
| 3 | Platform built, just before POC | Feb–Jul 2027 | — | 264 | 15 | 0 | 227 | 200 fitted |
| 4 | POC ends | Aug–Oct 2027 | — | 182 | 7.5 | 300 | 345 | 200 |
| 5 | Cooling period ends | Nov–Dec 2027 | — | 293 | 5 | 176 | 228 | 200 |
| 6 | 2 months of main business | Jan–Feb 2028 | — | 332 | 5 | 275 | 171 | 500 |
| 7 | Round 2 + 3 months of main business | Mar 2028 | 300 | 220 | 2.5 | 210 | 461 | 650 |
| 8 | 6 months of main business | Apr–Jun 2028 | — | 898 | 7.5 | 922 | 485 | 1,100 |
| 9 | 1 year of main business | Jul–Dec 2028 | — | 2,862 | 15 | 3,153 | 776 | 2,000 |
| | Total to Dec 2028 | | 800 | 5,059 | 60 | 5,036 | 776 | |
Feb–Jul spent includes ₹12.9 L GST on screens (back in Oct, inside POC).

### If sales are slower (₹ lakh)
| Share sold | Least money in bank | Least after round 2 | Dec 2028 | Most cash used | First profitable month |
| 70% plan | 171 (Feb 2028) | 457 (Apr 2028) | 776 | ₹3.4 Cr | Apr 2028 |
| 60% | 139 (Feb 2028) | 358 (Jul 2028) | 441 | ₹4.4 Cr | Jul 2028 |
| 55% | 122 (Feb 2028) | 157 (Mar 2029) | 251 | ₹6.4 Cr | Sep 2028 |
| 50%, if we kept adding bikes anyway | 106 (Feb 2028) | −131 (Mar 2029) | 61 | ₹9.3 Cr | Mar 2029 |
₹8 Cr keeps at least ₹1.6 Cr in the bank after round 2 down to 55% sold. Below 55% the bike gate stops adding bikes; growing anyway at 50% would need a ₹4.5 Cr round 2.

### Five years
| Year | Bikes (Dec) | Cities | Revenue we keep | Money earned | Money spent | Raised | PBT | PAT | Bank (Dec) |
| 2026 | 0 | — | 0 | 0 | 0 | — | 0 | 0 | 0 |
| 2027 | 200 | 1 | ₹4.3 Cr | ₹4.8 Cr | ₹7.5 Cr | ₹5 Cr | −₹2.3 Cr | −₹2.3 Cr | ₹2.3 Cr |
| 2028 | 2,000 | 1 | ₹46 Cr | ₹46 Cr | ₹43 Cr | ₹3 Cr | ₹4.0 Cr | ₹3.6 Cr | ₹7.8 Cr |
| 2029 | 6,300 | 2 | ₹160 Cr | ₹160 Cr | ₹140 Cr | — | ₹33 Cr | ₹25 Cr | ₹28 Cr |
| 2030 | 12,450 | 4 | ₹385 Cr | ₹385 Cr | ₹312 Cr | — | ₹98 Cr | ₹74 Cr | ₹101 Cr |
| 2031 | 15,500 | 5 | ₹557 Cr | ₹557 Cr | ₹444 Cr | — | ₹148 Cr | ₹111 Cr | ₹214 Cr |
Tax paid: 2028 ₹0.4 Cr, 2029 ₹8.4 Cr, 2030 ₹25 Cr, 2031 ₹37 Cr. Billed and rider pay unchanged. Headcount unchanged.

### One bike, one month (70% sold, rounded so each column adds up)
| | 2,000 bikes (Dec 2028) | 6,300 (Dec 2029) | 15,500 (Dec 2031) |
| Billed | 36,750 | 36,750 | 36,750 |
| We keep (88%) | 32,300 | 32,300 | 32,300 |
| Rider incl. gig fee | −13,500 | −13,500 | −13,500 |
| Tech: engineers, platform, screen data | −1,600 | −900 | −600 |
| Screen upkeep, support desk, camera write-off | −1,100 | −1,000 | −900 |
| Field ops | −1,200 | −1,200 | −1,300 |
| Sales team 8% | −2,600 | −2,600 | −2,600 |
| Gateway + bad debt 3% | −1,000 | −1,000 | −1,000 |
| Marketing | −900 | −600 | −600 |
| Team and office (non-tech) | −2,800 | −2,200 | −2,100 |
| New bikes and new cities | −200 | −500 | 0 |
| Buffer | −2,500 | −1,600 | −1,100 |
| Profit before tax | 4,900 (15%) | 7,200 (22%) | 8,600 (27%) |
| Profit after tax | 3,600 | 5,400 | 6,400 |
| Break-even share sold | 51% | 44% | 39% |
Profit per bike vs share sold (Dec 2028 / Dec 2029 / Dec 2031): 50% −400 / 1,700 / 3,100; 55% 900 / 3,100 / 4,500; 70% 4,900 / 7,200 / 8,600.

### Where every ₹100 billed goes (Dec 2028)
Agency 10, aggregator 2, rider 37, team and office 8, tech 4, field/screens/support/camera 7, sales+gateway+marketing 12, buffer 7, tax 3, profit 10. Per moving hour (₹175): 17, 4, 64, 13, 8, 13, 21, 12, 6, 17.
Year by year (agency/aggregator/riders/team & office/tech/field/sales & marketing/new cities/buffer/tax/profit): 2027 (Aug–Dec) 6/1/27/20/16/9/6/0/8/0/8; 2028 10/2/37/10/6/7/12/0/7/1/7; 2029 10/2/37/6/3/7/11/1/5/5/14; 2030 10/2/37/6/2/6/11/0/3/6/17; 2031 10/2/37/6/2/6/11/0/3/6/17.
The ₹2.6 Cr spent before the POC (Jan–Jul 2027) comes from the seed.

### Tech costs: unchanged from v5.2 (₹10.4 Cr over 2027–29). Cameras are hardware (screen line), not tech.

### Use of seed (₹5 Cr)
Pre-seed costs + founder Jan ₹9 L; before the POC ₹2.51 Cr (incl. 210 screens with cameras ₹71.4 L, tech ₹78 L); POC brings in more than it costs; screen stock ₹93 L in cooling; ≈ ₹1.7 Cr left at the lowest point.
