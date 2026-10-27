# Backups, restore and rolling back a release

P7.4. Plain steps for keeping the data safe and undoing a bad release.

## What is in place

- **A backup tool.** One command copies the whole database to one file, with a fingerprint (SHA-256) saved beside it.
- **A restore tool.** It refuses a file whose fingerprint does not match, and it never writes over an existing database: it always restores into a new one. It follows TimescaleDB's steps for the time-split tables (plays, minute summaries, screen health).
- **A restore drill.** It backs up, restores into a copy, and checks the copy holds exactly the same data (every table's rows, the ledger's totals per account, the migrations applied), then drops the copy. A backup only counts once it has been restored, so the drill proves it.
- **Every release can be undone in one step.** Database changes only ever add (a check refuses anything else: no column dropped, renamed or retyped, no column made required, and a new required column always has a default). So the release before always runs on the newer database.
- **Screen player updates** already have their own Roll back button (Admin → Screens → Rollout, P2.13).

## Commands

Run them from the repository with `DATABASE_URL` pointing at the database. They need `pg_dump` and `pg_restore` version 16.

| What | Command |
|---|---|
| Back up | `pnpm --filter @recall/db backup -- --out recall-2027-08-24.dump` |
| Restore into a new database | `pnpm --filter @recall/db backup -- --restore recall-2027-08-24.dump --into recall_restored` |
| Restore drill (prove it works) | `pnpm --filter @recall/db backup -- --drill` |

After a restore, point the API at the new database (its `DATABASE_URL`) only after checking it. The old one stays untouched until you decide.

## Rolling back a release (one step)

1. Redeploy the previous release's images (every release is tagged, and the previous tag is kept).
2. Leave the database as it is. The previous release runs on it, because database changes only add.
3. Never undo a migration by hand. If data was written wrongly, correct it with a reversing entry, logged (hard rule 3: nothing is deleted).

## Before going live (needs AWS, P6)

- **Choose where the database runs.** Amazon's managed database (RDS) does not support TimescaleDB, which RECALL uses for plays. There are two choices:
  - **Timescale's own cloud on AWS** (recommended for a small team): automatic daily backups and restore to any minute. Check that it offers the Mumbai region.
  - **PostgreSQL on our own AWS server**, with continuous backups to S3 (pgBackRest). Cheaper, but more work for us.
- **A second copy, whichever is chosen.** A daily backup with the tool above, to S3 in a separate AWS account, kept 30 days (90 for month-ends: rider pay and GST).
- **A restore drill every week**, run automatically; a failure alerts the team.
- **Write down how long a restore takes** at full size. The test fleet's database should restore in minutes; measure it on the POC data.
