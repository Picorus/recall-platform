// P2.4.2: the ad files each screen must keep, for the cloud to send on down/files (the list format
// and its checks: @recall/domain ad-files.ts). A screen may ride into any area of the city and play
// any booking there (the screen's own pick, P1.4.3), so every screen gets every file it may need:
//  - the approved ads a regular booking runs, from 24 hours before its first hour (or as soon as its
//    ads are approved, if later) until the end of its last hour plus a day (a make-up can play the
//    same hour the next day, P1.6), kept until then;
//  - while the POC is scheduled or running, the POC brands' approved ads and RECALL's own ads, kept
//    until the end of the last POC month that uses them;
//  - RECALL's own approved ads at any time: they fill RECALL's spots and areas with no booking (P2.5),
//    kept a couple of days ahead (each list moves that on).
// Files playing now come first, then the soonest needed; at most MAX_AD_FILES (600) go in one list,
// the rest wait for a later list (`left` says how many; the gateway logs it for staff). A choice of
// ads changed in the last 30 minutes keeps the earlier ads listed until then (screens take a new
// plan with their next hello). The links are signed by the file store for a few hours only: a box
// gets fresh ones with every hello.
import {
  adFilesText,
  parsePocRef,
  adFileProblem,
  MAX_AD_BYTES,
  MAX_AD_FILES,
  MAX_KEEP_SECONDS,
  type AdFile,
} from '@recall/domain';
import type { PoolClient } from 'pg';
import { ADS_CHANGE_GRACE_SECONDS, pocPlans, RECALL_OWN_ACCOUNT } from './poc.js';

type Q = Pick<PoolClient, 'query'>;

/** A file the screens need, before its link is signed. */
export interface NeededFile {
  readonly ad: string;
  /** The file's key in the store: its SHA-256. */
  readonly sha256: string;
  readonly bytes: number;
  /** Keep it until then (UTC seconds). */
  readonly keepUntil: number;
  /** First needed then (UTC seconds): the list is in this order. */
  readonly needFrom: number;
}

/** Sent this long before a booking's first hour (P1.4.1). */
export const FILES_AHEAD_SECONDS = 24 * 3600;
/** A booking's files are kept this long after its last hour (its make-ups, P1.6). */
export const MAKE_UP_KEEP_SECONDS = 24 * 3600;
/** How long a download link works: the box gets fresh links with each hello (every 15 minutes). */
export const LINK_SECONDS = 6 * 3600;
/** RECALL's own ads are kept this far ahead of the day the list is made. */
const OWN_KEEP_DAYS = 3;

/** Booking steps whose ads play (or may play a make-up: a report may be sent before it, m4). */
const PLAYING = ['ads-approved', 'running', 'done', 'report-sent'];

/**
 * Every file the screens need at `now` (UTC seconds), soonest first and at most MAX_AD_FILES, and how
 * many more were left out. The same for every screen.
 */
export async function neededAdFiles(
  c: Q,
  now: number,
): Promise<{ files: NeededFile[]; left: number }> {
  const want = new Map<string, { keepUntil: number; needFrom: number }>();
  const add = (ad: string, keepUntil: number, needFrom: number) => {
    const w = want.get(ad);
    want.set(ad, {
      keepUntil: Math.max(w?.keepUntil ?? 0, keepUntil),
      needFrom: Math.min(w?.needFrom ?? Number.MAX_SAFE_INTEGER, needFrom),
    });
  };
  // Regular bookings: their latest choice of ads, while they play (a cancelled one drops out).
  // Review S4: a choice changed in the last ADS_CHANGE_GRACE_SECONDS keeps the ads of the one
  // before it on the list until then (screens take a new plan only with their next hello).
  const books = await c.query<{
    first: string;
    last: string;
    ad_ids: string[];
    prev: string[] | null;
    changed: string;
  }>(
    `SELECT extract(epoch FROM b.first_hour_at)::bigint AS first,
            extract(epoch FROM b.last_hour_ends_at)::bigint AS last, s.ad_ids,
            (SELECT p.ad_ids FROM booking_ad_sets p
              WHERE p.booking_id = b.booking_id AND p.version = s.version - 1) AS prev,
            extract(epoch FROM s.set_at)::bigint AS changed
       FROM bookings b
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                      ORDER BY seq DESC LIMIT 1) st ON true
       JOIN LATERAL (SELECT ad_ids, version, set_at FROM booking_ad_sets x
                      WHERE x.booking_id = b.booking_id ORDER BY version DESC LIMIT 1) s ON true
      WHERE st.state = ANY($2)
        AND b.first_hour_at <= to_timestamp($1::bigint + $3::bigint)
        AND b.last_hour_ends_at > to_timestamp($1::bigint - $4::bigint)`,
    [now, PLAYING, FILES_AHEAD_SECONDS, MAKE_UP_KEEP_SECONDS],
  );
  for (const b of books.rows) {
    for (const ad of b.ad_ids)
      add(ad, Number(b.last) + MAKE_UP_KEEP_SECONDS, Math.max(now, Number(b.first)));
    const graceEnd = Number(b.changed) + ADS_CHANGE_GRACE_SECONDS;
    if (graceEnd > now) for (const ad of b.prev ?? []) add(ad, graceEnd, now);
  }
  // The POC months (scheduled or running): their brands' ads and RECALL's own.
  const plans = await pocPlans(c, now);
  for (const p of plans) {
    for (const ad of [...p.brands.flatMap((b) => b.ads), ...p.recallAds])
      add(ad, p.endsAt, Math.max(now, p.startsAt));
  }
  // A POC brand playing now whose ads changed within the grace: its earlier ones too (S4).
  const paidBrands = [
    ...new Set(
      plans.flatMap((p) =>
        p.brands.filter((b) => b.ads.length > 0).map((b) => parsePocRef(b.ref)?.brandId ?? ''),
      ),
    ),
  ];
  if (paidBrands.length > 0) {
    const changed = await c.query<{ prev: string[]; changed: string }>(
      `SELECT p.ad_ids AS prev, extract(epoch FROM n.set_at)::bigint AS changed
         FROM poc_ad_sets n JOIN poc_ad_sets p ON p.brand_id = n.brand_id AND p.version = n.version - 1
        WHERE n.brand_id = ANY($1) AND n.set_at > to_timestamp($2::bigint - $3::bigint)
          AND n.set_at <= to_timestamp($2::bigint)
          AND n.version = (SELECT max(version) FROM poc_ad_sets x WHERE x.brand_id = n.brand_id)`,
      [paidBrands, now, ADS_CHANGE_GRACE_SECONDS],
    );
    for (const x of changed.rows)
      for (const ad of x.prev) add(ad, Number(x.changed) + ADS_CHANGE_GRACE_SECONDS, now);
  }
  // RECALL's own ads, always (RECALL's spots, areas with no booking).
  const own = await c.query<{ ad_id: string }>(
    `SELECT a.ad_id FROM ads a JOIN ad_reviews r USING (ad_id)
      WHERE a.brand_id = $1 AND r.decision = 'approved' AND a.outcome <> 'fail'
      ORDER BY a.uploaded_at, a.ad_id LIMIT 100`,
    [RECALL_OWN_ACCOUNT],
  );
  const day = Math.floor(now / 86_400) * 86_400;
  for (const x of own.rows) add(x.ad_id, day + OWN_KEEP_DAYS * 86_400, now);
  // Only files a reviewer approved (and no automatic check failed), whatever chose them.
  const ids = [...want.keys()];
  const files = await c.query<{ ad_id: string; file_key: string; bytes: string }>(
    `SELECT a.ad_id, a.file_key, a.bytes FROM ads a JOIN ad_reviews r USING (ad_id)
      WHERE a.ad_id = ANY($1) AND r.decision = 'approved' AND a.outcome <> 'fail'`,
    [ids],
  );
  const all: NeededFile[] = [];
  for (const f of files.rows) {
    const w = want.get(f.ad_id);
    const bytes = Number(f.bytes);
    if (!w || bytes < 1 || bytes > MAX_AD_BYTES) continue;
    all.push({
      ad: f.ad_id,
      sha256: f.file_key,
      bytes,
      // Never past what a box accepts (a list's time + 400 days).
      keepUntil: Math.min(w.keepUntil, now + MAX_KEEP_SECONDS),
      needFrom: w.needFrom,
    });
  }
  // Playing now first (needed from now), then the soonest needed (review S2).
  all.sort((a, b) => a.needFrom - b.needFrom || (a.ad < b.ad ? -1 : a.ad > b.ad ? 1 : 0));
  return { files: all.slice(0, MAX_AD_FILES), left: Math.max(0, all.length - MAX_AD_FILES) };
}

/** Signs each file's download link (HTTPS, until `now` + LINK_SECONDS); a file the box would refuse is
 * left out. */
export function signAdFiles(
  needed: readonly NeededFile[],
  readLink: (key: string, until: number) => string,
  now: number,
): AdFile[] {
  const until = now + LINK_SECONDS;
  const out: AdFile[] = [];
  for (const f of needed) {
    const file: AdFile = {
      ad: f.ad,
      sha256: f.sha256,
      bytes: f.bytes,
      url: readLink(f.sha256, until),
      keepUntil: f.keepUntil,
    };
    if (adFileProblem(file, now * 1000) === undefined) out.push(file);
  }
  return out;
}

/** Whether this screen is one of ours (enrolled): only those get files. */
export async function isEnrolledScreen(c: Q, screenId: string): Promise<boolean> {
  return (await c.query('SELECT 1 FROM screens WHERE screen_id = $1', [screenId])).rows.length > 0;
}

/** The files one screen must keep at `now`, with signed links (none for a screen we do not know). */
export async function screenAdFiles(
  c: Q,
  screenId: string,
  now: number,
  readLink: (key: string, until: number) => string,
): Promise<AdFile[]> {
  if (!(await isEnrolledScreen(c, screenId))) return [];
  return signAdFiles((await neededAdFiles(c, now)).files, readLink, now);
}

/** Every enrolled screen (for sending each its new list when the files change). */
export async function enrolledScreens(c: Q): Promise<string[]> {
  const r = await c.query<{ screen_id: string }>(
    'SELECT screen_id FROM screens ORDER BY screen_id',
  );
  return r.rows.map((x) => x.screen_id);
}

/**
 * The list text for a screen (made at `madeMs`). Should the links make it longer than a box reads
 * (1 MB), the files needed last are left off until it fits, and `log` says so: they come in a later
 * list, never silently.
 */
export function fileListText(
  files: readonly AdFile[],
  madeMs: number,
  log: (line: string) => void = (l) => console.error(l),
): string {
  let n = files.length;
  for (;;) {
    try {
      const text = adFilesText(files.slice(0, n), madeMs);
      if (n < files.length)
        log(`ad files: ${files.length - n} files left off a list (too long for one message)`);
      return text;
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'list too big' || n === 0) throw e;
      n = Math.floor(n * 0.9);
    }
  }
}
