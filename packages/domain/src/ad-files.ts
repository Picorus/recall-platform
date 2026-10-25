// P2.4: the ad files a screen must keep. The cloud sends the list on recall/v1/s/<id>/down/files
// whenever it changes (ads are sent 24 hours ahead or as soon as approved, P1.4.1) and in reply to
// every hello (so a box that was offline, or whose download links expired, gets a fresh one). Each
// list is the whole list, stamped with when it was made: the box ignores one older than the last it
// took, and anything left off is no longer needed (a cancelled booking frees its space). Each entry names
// an ad, the SHA-256 fingerprint of its file, its size, an HTTPS link to download it from storage, and
// until when to keep it (the end of the last booking that uses it). The box downloads ahead, checks
// the fingerprint before a file is ever played, and never streams. The Kotlin player reads the same
// text (shared cases in test-vectors/ad-files.json).

export interface AdFile {
  /** The ad's id (as in the hour plan and in each play). */
  readonly ad: string;
  /** SHA-256 of the file, lowercase hex: the box plays only a file that matches. */
  readonly sha256: string;
  readonly bytes: number;
  /** Where to download it: HTTPS only. */
  readonly url: string;
  /** Keep the file at least until then (UTC seconds): the end of the last booking using it. */
  readonly keepUntil: number;
}

/** Largest ad file (a 15-second video for the screen is a few MB). */
export const MAX_AD_BYTES = 64 * 1024 * 1024;
/** Most files in one list. */
export const MAX_AD_FILES = 200;
/** No file is kept longer than this past the list's own time (a wrong date cannot lock storage). */
export const MAX_KEEP_SECONDS = 400 * 24 * 3600;

const AD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const isWhole = (x: unknown, min: number, max: number): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;

/** Why this entry may not be sent, or undefined when it is fine. `madeMs`: the list's time. */
export function adFileProblem(f: unknown, madeMs: number): string | undefined {
  if (!isPlainObject(f) || !hasExactly(f, ['ad', 'sha256', 'bytes', 'url', 'keepUntil']))
    return 'wrong fields';
  if (typeof f.ad !== 'string' || !AD_ID.test(f.ad)) return 'bad ad id';
  if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) return 'bad fingerprint';
  if (!isWhole(f.bytes, 1, MAX_AD_BYTES)) return 'bad size';
  // Printable ASCII only (links are percent-encoded), so both sides read exactly the same links.
  if (typeof f.url !== 'string' || f.url.length > 2048 || !/^https:\/\/[\x21-\x7E]+$/.test(f.url))
    return 'not an HTTPS link';
  if (!isWhole(f.keepUntil, 1, Math.floor(madeMs / 1000) + MAX_KEEP_SECONDS))
    return 'bad keep-until';
  return undefined;
}

/** Why these entries may not go in one list together (the same ad twice, one file two sizes). */
function listProblem(files: readonly AdFile[]): string | undefined {
  const ads = new Set<string>();
  const sizes = new Map<string, number>();
  for (const f of files) {
    if (ads.has(f.ad)) return 'an ad listed twice';
    ads.add(f.ad);
    if ((sizes.get(f.sha256) ?? f.bytes) !== f.bytes) return 'one file with two sizes';
    sizes.set(f.sha256, f.bytes);
  }
  return undefined;
}

/**
 * The exact text of a list (the whole list), made at `madeMs` (UTC ms). The cloud writes whole
 * numbers only. Throws on a list the box would refuse.
 */
export function adFilesText(files: readonly AdFile[], madeMs: number): string {
  if (!isWhole(madeMs, 1, Number.MAX_SAFE_INTEGER)) throw new Error('bad list time');
  if (files.length > MAX_AD_FILES) throw new Error(`at most ${MAX_AD_FILES} files in one list`);
  for (const f of files) {
    const problem = adFileProblem(f, madeMs);
    if (problem) throw new Error(`ad file ${String(f.ad)}: ${problem}`);
  }
  const problem = listProblem(files);
  if (problem) throw new Error(problem);
  const entry = (f: AdFile) =>
    `{"ad":${JSON.stringify(f.ad)},"sha256":"${f.sha256}","bytes":${f.bytes},"url":${JSON.stringify(f.url)},"keepUntil":${f.keepUntil}}`;
  return `{"v":1,"made":${madeMs},"files":[${files.map(entry).join(',')}]}`;
}

/** A list read back (the box's rules, for tests and tools), or why it is refused whole. */
export function parseAdFiles(
  text: string,
): { readonly made: number; readonly files: AdFile[] } | { readonly problem: string } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { problem: 'not a JSON object' };
  }
  if (!isPlainObject(x) || !hasExactly(x, ['v', 'made', 'files']))
    return { problem: 'not a file list' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!isWhole(x.made, 1, Number.MAX_SAFE_INTEGER)) return { problem: 'bad list time' };
  if (!Array.isArray(x.files) || x.files.length > MAX_AD_FILES) return { problem: 'bad files' };
  for (const f of x.files) {
    const problem = adFileProblem(f, x.made);
    if (problem) return { problem };
  }
  const files = x.files as AdFile[];
  const problem = listProblem(files);
  return problem ? { problem } : { made: x.made, files };
}
