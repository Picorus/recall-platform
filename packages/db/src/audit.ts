// P3.16: the audit log. Who changed what and when, from every part of the business, newest first;
// searchable by who, part, what and about what, between two times; and as a file. Nothing here can
// change anything: the log is a view over records that are never edited or deleted.
import { toCsv } from '@recall/domain';
import type { PoolClient } from 'pg';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;

export const AUDIT_AREAS = [
  'staff',
  'areas',
  'prices',
  'business',
  'calendar',
  'brands',
  'bookings',
  'ads',
  'money',
  'payouts',
  'riders',
  'screens',
  'support',
] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

export interface AuditRow {
  readonly at: number;
  /** Who did it: a staff member's name (their id if unknown), or "system", "app", "payments"…. */
  readonly who: string;
  readonly whoId: string;
  readonly area: AuditArea;
  readonly action: string;
  readonly ref: string;
  readonly detail: string;
}

export interface AuditFilter {
  /** Words to find in who, what, about what or why (all must be there). */
  readonly text?: string;
  readonly area?: AuditArea;
  /** UTC seconds, [from, to). */
  readonly from?: number;
  readonly to?: number;
  /** For the next page: the `next` a page returned. */
  readonly before?: string;
  readonly limit?: number;
}

/** The log, newest first (at most 500 a page; `next` continues it). */
export async function auditLog(
  c: Q,
  f: AuditFilter = {},
): Promise<{ rows: AuditRow[]; next: string | null }> {
  if (f.area !== undefined && !(AUDIT_AREAS as readonly string[]).includes(f.area))
    throw new Refusal('Which part of the business?');
  const words = (f.text ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .map((w) => w.slice(0, 60));
  const limit = Math.max(1, Math.min(500, Math.floor(f.limit ?? 200)));
  // The cursor: the last entry's exact time (microseconds) and its record's own key, hashed.
  const cursor =
    f.before === undefined ? null : /^(\d{1,12}\.?\d{0,6})\|([0-9a-f]{32})$/.exec(f.before);
  if (f.before !== undefined && !cursor) throw new Refusal('Which page?');
  const r = await c.query<{
    at: Date;
    who: string;
    who_name: string | null;
    area: AuditArea;
    action: string;
    ref: string;
    detail: string;
    key: string;
    epoch: string;
  }>(
    `SELECT a.at, a.who, s.name AS who_name, a.area, a.action, a.ref, a.detail,
            md5(a.uid) AS key,
            extract(epoch FROM a.at)::numeric::text AS epoch
       FROM audit_log a LEFT JOIN staff s ON s.id = a.who
      WHERE ($1::text IS NULL OR a.area = $1)
        AND ($2::double precision IS NULL OR a.at >= to_timestamp($2))
        AND ($3::double precision IS NULL OR a.at < to_timestamp($3))
        AND ($4::numeric IS NULL
             OR (extract(epoch FROM a.at)::numeric, md5(a.uid))
                < ($4::numeric, $5::text))
        AND (SELECT bool_and(concat_ws(' ', a.who, s.name, a.action, a.ref, a.detail)
                             ILIKE '%' || replace(replace(replace(w, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
               FROM unnest($6::text[]) w) IS NOT FALSE
      ORDER BY a.at DESC, key DESC
      LIMIT $7`,
    [
      f.area ?? null,
      f.from ?? null,
      f.to ?? null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      words,
      limit + 1,
    ],
  );
  const rows = r.rows.slice(0, limit);
  const last = r.rows.length > limit ? rows.at(-1) : undefined;
  return {
    rows: rows.map((x) => ({
      at: x.at.getTime() / 1000,
      who: x.who_name ?? x.who,
      whoId: x.who,
      area: x.area,
      action: x.action,
      ref: x.ref,
      detail: x.detail,
    })),
    next: last ? `${last.epoch}|${last.key}` : null,
  };
}

/**
 * The log (as filtered) as a CSV file, times in India time: the newest 10,000 entries at most;
 * `cut` says when there were more (narrow the search to get the rest).
 */
export const AUDIT_FILE_MAX = 10_000;

export async function auditCsv(c: Q, f: Omit<AuditFilter, 'before' | 'limit'> = {}) {
  const rows: AuditRow[] = [];
  let before: AuditFilter['before'];
  do {
    const page = await auditLog(c, { ...f, limit: 500, ...(before ? { before } : {}) });
    rows.push(...page.rows);
    before = page.next ?? undefined;
  } while (before && rows.length <= AUDIT_FILE_MAX);
  const cut = rows.length > AUDIT_FILE_MAX;
  rows.length = Math.min(rows.length, AUDIT_FILE_MAX);
  const india = (t: number) =>
    new Date(Math.floor(t * 1000) + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const csv = toCsv(
    ['time (India)', 'who', 'part', 'what', 'about', 'detail'],
    rows.map((x) => [india(x.at), x.who, x.area, x.action, x.ref, x.detail]),
  );
  return { csv, cut };
}
