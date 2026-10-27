# POC readiness

What must be true before the first real bike goes out in the POC (about 200 bikes and riders, about 40 brands). It has two parts:
- the plan's quality bars, each with its evidence;
- the go-live list.

**The automatic check.** `pnpm --filter @recall/api readiness` reads the live system and says, for each item it can see, ready or not yet, and what to do. Run it on the real system before launch; every line must say READY. It changes nothing.

Status: ✅ done · 🟡 done here, the real one waits on an account or hardware · ⬜ not started (needs you)

## The plan's quality bars

| Layer | Bar | Status | Evidence |
|---|---|---|---|
| Unit | 95%+ of engine and ledger code covered | ✅ | Money and play files: rules 95% of lines, database code 96%. Each file has a floor that CI enforces (P7.3). |
| Property | Ledger always balances; no play counted twice; never more than 240 plays per bike-hour | ✅ | Random-input tests with thousands of cases. The database also refuses an unbalanced entry and a second play under the same number. |
| Simulation | Whole days with 200, 2,000 and 15,500 fake bikes | ✅ | Fleet simulator (P1.10) on real Hyderabad roads; the scheduler proven at 2,000 bikes and run at 15,500 (P1.4.7) |
| Contract | Each outside service: fake and real behave the same | 🟡 | Every service has a fake with tests. Checking against each provider's test mode comes when its account opens (P6). |
| End to end | Brand books, pays, ads approved, plays, report; rider joins, earns, is paid | 🟡 | Browser tests: admin (17), brand portal (5), rider app. Today they run with the fakes; repeat them with the real services before launch. |
| Device | Player on emulator, then a 72-hour run on the sample unit (signal cuts, power cuts, heat) | 🟡 | Emulator done (P2). Sample unit test blocked: needs the sample screen. |
| Load | 15,500 screens every 30 s; payout run for 15,500 riders | ✅ | P7.2: about 500 messages a second per gateway (two gateways for the fleet); payout run 2.5 minutes |
| Security | No high-risk findings open; outside audit before POC | 🟡 | P7.1 internal review: none open. **An outside security audit is still needed** (a firm you hire; about 1–2 weeks). |

## Release rules

| Rule | Status | Evidence |
|---|---|---|
| Every change goes through a test copy first | ⬜ | Needs the AWS account: a second, smaller copy of the system (staging) |
| Screens update in stages (1%, 10%, all) | ✅ | P2.13, with pause and roll back on the Screens page |
| Every release can be undone in one step | ✅ | P7.4: database changes only add (CI checks it); redeploy the previous release |
| Backups every day, tested by a restore | 🟡 | P7.4: backup, restore and drill tools work. The daily schedule needs AWS and the database choice. |

## Go-live list

| # | Item | Who | Status |
|---|---|---|---|
| 1 | Company details (legal name, GSTIN, address) in Settings | You, then a super admin | ⬜ |
| 2 | Accountant's OK on the GSTIN rule; GST e-invoice and TDS rules confirmed | Your CA | ⬜ |
| 3 | Lawyer's check: DPDP (people counting, rider data), ad permits on vehicles, rider agreement | Your lawyer | ⬜ |
| 4 | Accounts opened (see `ACCOUNTS_TO_OPEN.md`) and connected | You, then me | ⬜ |
| 5 | AWS: production and staging, Mumbai; database choice (`RUNBOOKS/backup-restore.md`) | You, then me | ⬜ |
| 6 | Sample screen tested 72 hours; vendor's kit (SDK) in the player; people counter (P2.9) | Vendor, me | ⬜ |
| 7 | 200 screens enrolled at the warehouse, with 4G SIMs on a business data plan | Your team | ⬜ |
| 8 | Two super admins, and an admin for each area (sales, ad review, operations, finance, support) | You | ⬜ |
| 9 | Prices, launch areas published, business mode POC, fitting centres, support numbers | A super admin | ⬜ |
| 10 | 200 riders approved (ID, bank and agreement checked), screens fitted | Operations | ⬜ |
| 11 | Rider app installed on riders' phones (direct install for the POC, or Play Store) | Operations | ⬜ |
| 12 | 2-week road test with real bikes: plays, GPS, battery, heat, signal; numbers checked against the reports | Your team, me | ⬜ |
| 13 | Outside security audit, findings fixed | A firm you hire, me | ⬜ |
| 14 | A dry run: one test campaign booked, paid ₹1, played, reported and refunded on the real system | Me, with you | ⬜ |
| 15 | `pnpm --filter @recall/api readiness` says READY for every line | Me | ⬜ |

Items 1, 4, 8, 9 and 10 are what the automatic check can see. The rest are confirmed by hand and ticked here.
