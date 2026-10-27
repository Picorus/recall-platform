// P5.5 in the database: a brand's logo for its ready-made ads (the latest one is used). A picture
// (PNG or JPEG: the drawing cannot read WebP) of at most 2 MB and 2,000 pixels a side (4 million
// pixels in all: drawing a bigger one would hold up the server), read from its own bytes and kept by
// fingerprint.
import type { FileStore } from '@recall/adapters';
import { fileKey } from '@recall/adapters';
import { adKind, pictureSize } from '@recall/domain';
import type { Pool } from 'pg';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_LOGO_SIDE = 2_000;
export const MAX_LOGO_PIXELS = 4_000_000;

const TYPE = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

export interface BrandLogo {
  readonly fileKey: string;
  readonly kind: 'png' | 'jpeg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly contentType: string;
}

/** Keeps a new logo for a brand. Refused when it is not a picture or is too large. */
export async function setBrandLogo(
  pool: Pool,
  store: FileStore,
  l: { readonly brandId: string; readonly data: Uint8Array; readonly by: string },
  now: number,
): Promise<BrandLogo> {
  if (l.data.length > MAX_LOGO_BYTES) throw new Refusal('A logo is at most 2 MB');
  const kind = adKind(l.data);
  if (kind !== 'png' && kind !== 'jpeg') throw new Refusal('A logo is a PNG or JPEG picture');
  const size = pictureSize(l.data, kind);
  if (!size?.media || size.width < 1 || size.height < 1)
    throw new Refusal('This picture cannot be read: save it again as PNG');
  // Before it is stored: a refused logo leaves nothing behind.
  if (
    size.width > MAX_LOGO_SIDE ||
    size.height > MAX_LOGO_SIDE ||
    size.width * size.height > MAX_LOGO_PIXELS
  )
    throw new Refusal(
      `A logo is at most ${MAX_LOGO_SIDE} × ${MAX_LOGO_SIDE} pixels: make it smaller`,
    );
  const key = fileKey(l.data);
  const stored = await store.put(l.data, TYPE[kind]);
  if (stored.key !== key) throw new Error('the file store keyed the file differently');
  await pool.query(
    `INSERT INTO brand_logos (brand_id, set_at, file_key, kind, width, height, set_by)
     VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7)
     ON CONFLICT (brand_id, set_at) DO NOTHING`,
    [l.brandId, now, key, kind, size.width, size.height, l.by.slice(0, 120)],
  );
  return { fileKey: key, kind, width: size.width, height: size.height, contentType: TYPE[kind] };
}

/** A brand's logo now, or null. */
export async function brandLogo(c: Q, brandId: string): Promise<BrandLogo | null> {
  const r = await c.query<{
    file_key: string;
    kind: BrandLogo['kind'];
    width: number;
    height: number;
  }>(
    `SELECT file_key, kind, width, height FROM brand_logos WHERE brand_id = $1
      ORDER BY set_at DESC LIMIT 1`,
    [brandId],
  );
  const x = r.rows[0];
  return x
    ? {
        fileKey: x.file_key,
        kind: x.kind,
        width: x.width,
        height: x.height,
        contentType: TYPE[x.kind],
      }
    : null;
}
