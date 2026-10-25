# Open questions for Prateek

Things only Prateek can answer. The screens show them as [placeholders]; nothing is invented.
Answer whenever you like; each answer moves to `docs/DECISIONS.md` and the row is struck out here.
"Needed by" is the plan step that cannot finish without it.

## Still open
| # | Question | Where it shows | Needed by |
|---|---|---|---|
| 2b | After the POC: the exceptions to "only the areas that are on count for pay" | Admin Areas; rider pay | P4.5 |
| 5 | Fitting centre address(es) (any number can be added) | Rider Fitting | P4.3 |
| 6 | Support phone and WhatsApp numbers (hours: 10 am – 7 pm for now) | Rider Help; brand Help; admin Support | P3.15, P4.9 |
| 7 | Charging steps for the screen, once the equipment is final (from the screen maker) | Rider Your screen | P4.8 |
| 10b | TDS rate on rider pay and any gig-worker levy (ask your CA) | Admin Payouts; rider Payouts | P1.7.7 |

## To ask screen vendors before buying a sample (added 25 Oct 2026)
For a ready-made screen with its own Android box and receiving card. If all five answers are yes, our player app runs on it as it is (only the brightness link to the vendor's toolkit is extra work, about a week). If the box is locked to the vendor's own app or cloud, it can still play our ads and we read its play log, but we lose plays signed inside the box (our protection against fake counts) and people counting needs a separate small AI camera (about ₹2,500); about 2–3 weeks of work.

| # | Question for the vendor | Why it matters |
|---|---|---|
| V1 | Can we install our own Android app and make it the only app on the box (kiosk / "device owner")? Will you give ADB access, or a factory reset that allows it? | Our app must be the only app, start on power-up and never be closed (P2.2) |
| V2 | Which Android version does the box run? | Android 11 or newer is easiest; 8–10 works after a few days of changes |
| V3 | Does it have secure key storage (Android hardware keystore)? | Each play is signed inside the box with a key that cannot be copied (P2.1, P2.7) |
| V4 | Can our app read the GPS and use the 4G connection? | Area decisions, proof of where ads played, and the line to our cloud (P2.3, P2.8) |
| V5 | Can our app set the LED brightness, through your toolkit (SDK)? | Night dimming, never blinding riders behind (P2.10) |
| V6 | Can your own cloud be switched off, so the box takes orders only from RECALL? | No one else can change what plays |

## Answered 24 Oct 2026 (now in DECISIONS)
| # | Answer |
|---|---|
| ~~15~~ | POC rider pay follows the model v5.2 table (base ₹2k/4k/6k + founding bonus on monthly hours, ₹3,000 for finishing); a super-admin switch between POC and regular business, counted from that day; POC month 1 = the month first switched on |
| ~~13~~ | (a) Cuts are paid only on delivered money. (b) A cancellation refund not decided within 7 days counts as no refund |
| ~~14~~ | TDS is held back from cuts (we pay the partner after cutting TDS); the partner's GST is claimed back; our per-booking rounding is what goes in the books |
| ~~12~~ | Cancelled after paying: no refund by default; at least 72 hours before the first hour a super admin may refund 100%; later, no refund |

## Answered 22 Oct 2026 (now in DECISIONS)
| # | Answer |
|---|---|
| ~~1~~ | POC pay zone: within 15 km of Hitech City |
| ~~2~~ | After the POC: the areas that are on (Hitech City, Madhapur, Kondapur, Gachibowli, Jubilee Hills, …), more added as needed; exceptions still to set (2b) |
| ~~3~~ | Edge zone: 300 m by default, a setting per area (from the plan) |
| ~~4~~ | Loan bank: Dhanlaxmi Bank (can change later) |
| ~~8~~ | The screen is the rider's, paid by EMIs to the bank; defaults are the bank's matter; RECALL may buy equipment back if it wants |
| ~~9~~ | Chart colours stay |
| ~~10~~ | TDS is deducted from rider pay (rate: 10b) |
| ~~13~~ | 6/12-month deals: no discount on Lite; hours spread about equally over the months; discount on the bill |
| ~~14~~ | Aggregator ads are free |
| ~~11~~ | POC pay once a month, after the month ends |
