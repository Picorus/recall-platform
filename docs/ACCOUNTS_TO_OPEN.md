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

## What they cost (estimates, October 2026)

These numbers are for planning and for investors. They are **not quotes**: get a written quote before signing. Prices exclude 18% GST unless they say otherwise. Dollars are converted at about ₹88.

**Assumptions for the POC:** about 200 bikes and riders, about 40 brands, riders paid weekly.

### One-time (setting up)

| Item | Estimate | Basis |
|---|---|---|
| WhatsApp, payments, payouts, email, maps, Firebase accounts | ₹0 | No setup fee on standard plans |
| SMS DLT registration (the company and its sender name) | about ₹6,000 | Charged once by the telecom operator's DLT portal; estimate, confirm with the SMS provider |
| Google Play developer account | about ₹2,200 (USD 25) | Google's one-time fee |
| Domain name | ₹1,000–2,000 a year | Depends on the name |
| Rider ID check + e-sign, 200 riders | ₹10,000–26,000 | About ₹50–130 a rider for both together; no official price list, get a quote |
| Rider bank check (₹1 test), 200 riders | about ₹1,000 | A few rupees each; confirm with the payouts provider |
| **Outside security audit** (the plan asks for one before the POC) | ₹1–3.5 lakh | Indian market range for a manual test of a web app with several roles, one retest included |
| **Total one-time** | **about ₹1.2–3.9 lakh** | Mostly the security audit |

### Monthly during the POC

| Service | Estimate a month | Basis |
|---|---|---|
| AWS servers: API, websites, screen gateway and broker, file storage, load balancer, email (SES) | ₹20,000–30,000 | About 4 small servers (2 cores, 8 GB, about ₹3,700 each) plus storage, network and a smaller staging copy |
| Database (TimescaleDB, managed on AWS) | ₹20,000–35,000 | About 2 cores, 8 GB; metered by the hour. Running it on our own server instead: about ₹8,000–12,000, but more work. Get a quote from Tiger Data (Timescale). |
| WhatsApp messages (sign-in codes, booking and report messages, rider alerts) | ₹2,000–4,000 | About 5,000 messages at ₹0.115 each (Meta's India rate for utility and sign-in messages), plus the provider's platform fee of about ₹1,000–3,000 |
| SMS (only when someone has no WhatsApp) | under ₹500 | About ₹0.15–0.18 per SMS |
| Rider payouts | about ₹5,000–6,000 | About 870 transfers a month (200 riders weekly) at about ₹6 each |
| GST number lookup | about ₹300 | About ₹3,500 a year for 5,000 lookups |
| Map tiles | about ₹2,200 (USD 25) | MapTiler Flex plan |
| Rider app builds (Expo) | ₹0–1,700 | Free plan is enough for direct installs; Starter about USD 19 when needed |
| Phone notifications (Firebase) | ₹0 | Free |
| **Total monthly, POC** | **about ₹50,000–80,000** | Plus the payment fee below |
| **Brand payments** | **2.36% of what brands pay** (2% + GST) | ₹2,360 for every ₹1 lakh collected. New accounts are often charged 0% for their first 90 days or ₹5 lakh. Lower rates can be negotiated above ₹5 lakh a month. |

### At the full fleet (15,500 bikes), roughly

| Service | Estimate a month | Note |
|---|---|---|
| AWS servers and database | ₹2–3 lakh | The load test (P7.2): two gateways and a database of at least 4 cores, plus room to spare |
| Rider payouts | ₹4–5 lakh weekly, or about ₹1 lakh monthly | Paying monthly instead of weekly cuts this by about three quarters. Ask for volume pricing. |
| WhatsApp | ₹20,000–40,000 | About 2 lakh messages; volume discounts of up to 30% apply |
| New-rider ID checks | per rider, as they join | ₹50–130 each |
| Brand payments | 2.36% or less | Negotiated rate at this volume |

**Not included here:** the screens themselves, 4G SIM data plans, rider loans, salaries, the accountant's and lawyer's fees, and insurance.

Sources for the rates above (third-party pages are marked; confirm each before budgeting):
- [Razorpay pricing](https://razorpay.com/blog/cheapest-payment-gateway-for-businesses-in-india/) (Razorpay's own blog)
- [RazorpayX payouts](https://www.razorpay.com/x/payouts)
- [WhatsApp rates in India](https://baat.ai/blog/whatsapp-api-pricing-india) (third-party)
- [SMS OTP pricing in India](https://www.messagecentral.com/blog/sms-otp-pricing-india) (third-party)
- [KYC vendors compared](https://productgrowth.in/insights/fintech/kyc-vendors-compared/) (third-party)
- [GSTIN lookup pricing](https://gstzen.in/gst-validator-api-pricing-details)
- [MapTiler pricing](https://www.maptiler.com/cloud/pricing/)
- [Expo pricing](https://expo.dev/pricing.md)
- [Tiger Data (Timescale) pricing](https://tigerdata.com/pricing)
- [AWS Mumbai server prices](https://www.doit.com/compute/spot/ap-south-1/m7g.medium) (third-party)
- [Security audit costs in India](https://www.getastra.com/blog/security-audit/vapt-cost-pricing/) (third-party)

## What I do when each one is ready

For each account, I plug the real service in behind the stand-in already built, then test it with small real amounts (₹1 payments, a message to your own phone). The rest of the system does not change.
