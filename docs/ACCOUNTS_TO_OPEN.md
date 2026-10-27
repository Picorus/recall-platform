# Accounts to open (for Prateek)

The software uses a stand-in for every outside service today. To go live, each one needs a real company account. This page says which ones, why, and in what order.

**The order matters.** Some take weeks to approve, so start those first. Opening an account is free for almost all of these; you pay as you use them.

**Never paste keys or passwords into chat.** When an account is ready, tell me. We put its keys straight into the server's secret store together.

## Week 1: start these now (slowest approvals)

| # | What | Why we need it | Suggested providers (any one) | What they will ask you for | Typical wait |
|---|---|---|---|---|---|
| 1 | **Company papers ready** | Every provider below checks the company first | none | Certificate of incorporation, PAN, GSTIN, current bank account, registered address, director's ID | none |
| 2 | **WhatsApp Business API** | Sign-in codes, booking and report messages to brands, rider alerts | Gupshup, Interakt, or Meta directly | Verified Facebook Business Manager, a phone number used only for this, website, message templates | 1–3 weeks (templates are approved one by one) |
| 3 | **SMS with DLT registration** | Sign-in codes when someone has no WhatsApp. Indian law (TRAI DLT) needs the company, sender name and every message wording registered | MSG91 or Gupshup (they help with DLT) | Company papers, a 6-letter sender name (e.g. RECALL), each SMS wording | About 1 week |
| 4 | **Payments from brands** | Brands pay for campaigns by link, card or UPI | Razorpay or Cashfree | Company papers, bank account, website with prices, terms and refund policy | 2–7 days |
| 5 | **Payouts to riders** | Weekly rider pay straight to their bank, plus the ₹1 check that a bank account is really theirs | RazorpayX or Cashfree Payouts (same company as #4 is simplest) | Same papers; a current account | 3–10 days |

## Week 1–2: quick to open

| # | What | Why | Suggested | Notes |
|---|---|---|---|---|
| 6 | **AWS (Amazon's cloud)** | The servers, database, ad files and backups. Email (Amazon SES) and screen certificates live here too | AWS, Mumbai region (data stays in India) | Use a company card. Turn on two-step sign-in for the main login. Add me as a separate user later, never the main login. |
| 7 | **Domain name** | The addresses people visit: e.g. book.recall.in for brands, admin.recall.in for staff | Any registrar (GoDaddy, Namecheap, or AWS) | If RECALL already owns one, just tell me which |
| 8 | **Rider ID checks and e-sign** | Check a rider's Aadhaar or PAN, and have them sign the rider agreement on their phone | Digio (does both), or Signzy + Leegality | Company papers. They charge per check or per signature. |
| 9 | **GST number lookup** | Brands' GST details are filled in from the government record, not typed | A GST Suvidha Provider: Masters India or ClearTax | Company GSTIN |
| 10 | **Google Play developer account** | Publish the rider app | Google Play Console | One-time USD 25. Open it as an organisation (needs a D-U-N-S number, free, about 1 week). |
| 11 | **Expo account** | Build the rider app for phones | expo.dev (free plan is enough to start) | Use the company email |
| 12 | **Firebase (Google)** | Phone notifications to riders | Firebase, free | Same Google account as #10 |
| 13 | **Map tiles** | The background map on the staff fleet map and in reports | MapTiler, or another OpenStreetMap-based service | Free plan to start |

## Not accounts, but also needed

| What | From whom | Why |
|---|---|---|
| RECALL's legal name, GSTIN and address | You | Printed on every tax invoice. Until then invoices say "not a valid tax invoice". |
| Your accountant's OK on the GSTIN rule | Your accountant | Whether to print a brand's GSTIN when it comes from the GST record (decided 27 Oct, waiting for their OK) |
| One sample screen, with its maker's software kit (SDK) | The screen vendor | To prove the player on real hardware and finish the people counter (P2.9) |
| Bikes and riders for 2 weeks | Your team | The road test before the trial launch |

## What I do when each one is ready

For each account, I plug the real service in behind the stand-in already built, then test it with small real amounts (₹1 payments, a message to your own phone). The rest of the system does not change.
