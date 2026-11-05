# Tech costs: subscriptions only (Prateek, 4 Nov 2026)

The platform is built (see `BUILD_PLAN.md` and `POC_READINESS.md`). From now on the model's tech line holds only what we pay outside services to run it. There are no outside developers and no tech team in the line.

**All numbers are estimates** from list prices (late 2026). Check them against real quotes when each account is opened (`ACCOUNTS_TO_OPEN.md`). Amounts are before GST.

## During the POC (200 bikes, 40 brands, about 230 riders and staff)
| Service | What for | Estimate a month |
|---|---|---|
| Cloud hosting (Mumbai region) | API, gateway, workers; managed PostgreSQL with backups; Redis; the MQTT broker on our own server | ₹25,000–40,000 |
| File storage + CDN | Ad files to screens, reports, invoices | ₹2,000–5,000 |
| Maps (tiles + street names) | Staff fleet map, brand area map, reports | ₹4,000–8,000 |
| WhatsApp messages (through a provider) | Sign-in codes, rider and brand notices (about ₹0.15 a message + provider fee) | ₹3,000–8,000 |
| SMS backup codes (DLT registered) | When WhatsApp fails | ₹500–1,500 |
| Email | Brand codes, invoices | ₹0–500 |
| GST lookups and e-invoices (GSP) | GSTIN checks, e-invoice numbers | ₹2,000–5,000 |
| Error alerts and logs | Knowing when something breaks | ₹2,000–6,000 |
| Code hosting and checks (GitHub) | The code and its automatic tests | ₹2,000–4,000 |
| Domain, certificates | recall web addresses | about ₹200 |
| **Fixed total** | | **about ₹40,000–80,000** |

**Per-use costs.** These grow with the business.

| Service | Rate (estimate) | POC month |
|---|---|---|
| Rider payouts (bank transfer API) | ₹5–10 a payout; weekly × 200 riders ≈ 870 a month | ₹4,000–9,000 |
| Rider KYC (PAN, DigiLocker) + bank check | ₹15–40 a rider, once | about ₹8,000 once |
| E-sign (rider agreement, brand terms) | ₹30–60 a signature, once | about ₹12,000 once |
| Brand payments by **bank transfer** (virtual account) | about ₹5–10 a payment | under ₹1,000 |

**Brand payments: use bank transfer, not cards.** A card, netbanking or UPI gateway at about 2% would cost about ₹2.4 L a month on POC fees (40 × ₹2.95 L). A bank-transfer virtual account costs a few rupees a payment. The payment links stay for small brands after the POC.

**POC estimate:**
- about ₹0.6–1.0 L a month, or about ₹2–3 L for the three months;
- plus about ₹0.2 L once for KYC and e-sign.

## Before the POC (Feb–Jul 2027)
- **Accounts open, little traffic:** about ₹30,000–50,000 a month, so about ₹2–3 L for the six months.
- **One-time:** about ₹0.5 L for the Google Play account ($25), DLT registration, the WhatsApp template set-up, and a sample of devices for the road test.

**Before-POC tech: about ₹3 L.** The model had ₹78 L.

**Security audit:** an outside firm checks the platform before go-live, one payment of about ₹2 L in Jun 2027 (quotes run ₹1–3.5 L). It is its own line in the model, outside tech (Prateek, 4 Nov 2026).

## After the POC (rough, for the model)
Fixed costs grow slowly: about ₹1.5–2.5 L a month at 2,000 bikes, and about ₹4–6 L at 15,500.

Per-use costs grow with riders and brands:
- payouts: ₹5–10 each, weekly;
- messages: about ₹0.15 each;
- KYC and e-sign: once per new rider.

**About ₹60–120 a bike a month at scale, all in.** That is under 0.5% of the ₹32,300 a bike a month that we keep. The xlsx (`RECALL_Financial_Model_v5.3.xlsx`, not in this repo) should replace its "Tech: engineers, platform" rows with this.

Not in this line:
- **Screen SIM data:** already in the screen and field lines.
- **AI tokens and support-desk tools:** a separate line in the model.
