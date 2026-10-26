// P3.9.1: file storage for ads (hard rule 4: behind an adapter with a working fake). Ad files are
// stored under their SHA-256 fingerprint (the same file uploaded twice is stored once, and a file
// can never be swapped under its name). Files are read through short-lived signed links (the
// screens' downloads, P2.4, and staff previews), never public. The real store (S3-compatible) comes
// with the other outside services (P6); the fake keeps files in memory and signs its own links.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface StoredFile {
  readonly key: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface FileStore {
  /** Stores the bytes under their fingerprint; storing the same bytes again changes nothing. */
  put(data: Uint8Array, contentType: string): Promise<StoredFile>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  /** A link that reads the file until `until` (UTC seconds). */
  readLink(key: string, until: number): string;
}

/** A file's key: its SHA-256, lowercase hex. */
export const fileKey = (data: Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

export const FILE_KEY = /^[0-9a-f]{64}$/;

/**
 * A working fake: files in memory; read links point at `baseUrl` (the API serves them on a
 * laptop, after `checkLink`) and are signed with `secret`, so a link cannot be made up or extended.
 */
export function fakeFileStore(opts: {
  readonly baseUrl: string;
  readonly secret: string;
}): FileStore & {
  /** Whether a read link is genuine and still good at `now` (UTC seconds). */
  checkLink(key: string, until: number, sig: string, now: number): boolean;
  readonly files: Map<string, { data: Uint8Array; contentType: string }>;
} {
  const files = new Map<string, { data: Uint8Array; contentType: string }>();
  const sign = (key: string, until: number) =>
    createHmac('sha256', opts.secret).update(`${key}:${until}`).digest('hex');
  return {
    files,
    put(data, contentType) {
      const key = fileKey(data);
      if (!files.has(key)) files.set(key, { data: Uint8Array.from(data), contentType });
      return Promise.resolve({ key, bytes: data.length, contentType });
    },
    get(key) {
      return Promise.resolve(FILE_KEY.test(key) ? (files.get(key) ?? null) : null);
    },
    readLink(key, until) {
      return `${opts.baseUrl}/${key}?until=${until}&sig=${sign(key, until)}`;
    },
    checkLink(key, until, sig, now) {
      if (!FILE_KEY.test(key) || !Number.isSafeInteger(until) || until <= now) return false;
      const want = Buffer.from(sign(key, until), 'hex');
      const got = Buffer.from(/^[0-9a-f]{64}$/.test(sig) ? sig : '', 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    },
  };
}
