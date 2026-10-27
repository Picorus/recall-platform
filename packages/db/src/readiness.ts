// P7.5: is the system ready for the POC? Each item is a yes or no read from the live database (and
// the outside services the API was started with), with what to do when it is no. It changes
// nothing. The things no database can show (the road test, legal checks, the sample screen) are on
// the list in docs/POC_READINESS.md.
import {
  companySet,
  modeAt,
  priceBookAt,
  publishedAt,
  STAFF_AREAS,
  type StaffArea,
} from '@recall/domain';
import type { Pool } from 'pg';
import { allAreaVersions } from './areas.js';
import { businessModes } from './business-mode.js';
import { priceBooks } from './bookings.js';
import { screenList, stockCounts } from './screen-list.js';
import { setting } from './settings.js';
import { staffList } from './staff.js';

export interface ReadinessItem {
  readonly item: string;
  readonly ok: boolean;
  /** What stands now, in words. */
  readonly now: string;
  /** What to do when it is not ready. */
  readonly todo: string;
}

/** The POC's size (the plan: about 200 bikes and riders). */
export interface PocTargets {
  readonly screens: number;
  readonly riders: number;
}
export const POC_TARGETS: PocTargets = { screens: 200, riders: 200 };

/** One outside service as the API reports it (on, a stand-in, or off). */
export interface ServiceState {
  readonly service: string;
  readonly state: 'on' | 'stand-in' | 'off';
}

export async function pocReadiness(
  pool: Pick<Pool, 'query'>,
  services: readonly ServiceState[],
  now: number,
  targets: PocTargets = POC_TARGETS,
): Promise<ReadinessItem[]> {
  const at = new Date(now * 1000).toISOString();
  const items: ReadinessItem[] = [];
  const add = (item: string, ok: boolean, nowText: string, todo: string) =>
    items.push({ item, ok, now: nowText, todo });

  const company = await setting(pool, 'company');
  add(
    "RECALL's company details",
    companySet(company),
    companySet(company) ? company.legalName : 'not filled in',
    'Settings → Company: legal name, GSTIN and address (printed on every tax invoice)',
  );

  const book = priceBookAt(await priceBooks(pool), at);
  add(
    'Prices in force',
    book !== undefined,
    book ? `price book v${book.version}` : 'none',
    'Prices: save and publish a price book',
  );

  const versions = await allAreaVersions(pool);
  const live = [...new Set(versions.map((v) => v.areaId))].filter(
    (id) =>
      publishedAt(
        versions.filter((v) => v.areaId === id),
        at,
      )?.active,
  );
  add(
    'Areas on sale',
    live.length > 0,
    `${live.length} area${live.length === 1 ? '' : 's'} published and on`,
    'Areas: publish the launch areas and turn them on',
  );

  const mode = modeAt(await businessModes(pool), now);
  add(
    'Business mode is POC',
    mode === 'poc',
    mode,
    'Settings → Business mode: POC (rider pay and supply rules for the POC)',
  );

  const staff = (await staffList(pool)).filter((s) => s.active);
  const supers = staff.filter((s) => s.access.role === 'super-admin');
  const covered = (area: StaffArea) =>
    staff.some(
      (s) =>
        s.access.role === 'super-admin' ||
        (s.access.role === 'admin' && s.access.areas.includes(area)),
    );
  const missing = STAFF_AREAS.filter((a) => !covered(a));
  add(
    'Two super admins',
    supers.length >= 2,
    `${supers.length} active`,
    'Staff: add a second super admin (one away must not stop payouts or refunds)',
  );
  add(
    'An admin for every area',
    missing.length === 0 && staff.some((s) => s.access.role === 'admin'),
    missing.length === 0 ? `${staff.length} staff` : `no admin for ${missing.join(', ')}`,
    'Staff: add admins for sales, ad review, operations, finance and support',
  );

  const centres = (await setting(pool, 'fittingCentres')).filter((c) => c.on);
  add(
    'A fitting centre open',
    centres.length > 0,
    `${centres.length} open`,
    'Settings → Fitting centres: add one and turn it on',
  );
  const support = await setting(pool, 'support');
  add(
    'Support phone numbers',
    support.phones.length > 0,
    `${support.phones.length} number${support.phones.length === 1 ? '' : 's'}`,
    'Settings → Support: the numbers brands and riders call',
  );

  const counts = stockCounts(await screenList(pool, now));
  const screens = counts.onBike + counts.inStock;
  add(
    `${targets.screens} screens ready`,
    screens >= targets.screens,
    `${counts.onBike} on bikes, ${counts.inStock} ready in stock`,
    'Enrol screens at the warehouse (each gets its certificate)',
  );
  const riders = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT DISTINCT ON (rider_id) status FROM rider_steps ORDER BY rider_id, seq DESC
     ) s WHERE status IN ('approved', 'active')`,
  );
  const ridersOk = Number(riders.rows[0]?.n ?? 0);
  add(
    `${targets.riders} riders approved`,
    ridersOk >= targets.riders,
    `${ridersOk} approved or riding`,
    'Riders: approve riders (ID, bank and agreement checked)',
  );

  for (const s of services)
    add(
      s.service,
      s.state === 'on',
      s.state === 'on' ? 'connected' : s.state === 'stand-in' ? 'stand-in (laptop only)' : 'off',
      'Open the account (docs/ACCOUNTS_TO_OPEN.md) and put its keys in the secret store',
    );
  return items;
}
