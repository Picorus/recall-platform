// P3.9.1: the automatic checks an uploaded ad goes through before a person reviews it. An ad is one
// file the screen plays for a whole 15-second spot: a picture (PNG, JPEG or WebP, shown for the
// spot) or a video (MP4). The file's own bytes are read, never its name or what the uploader says:
// what kind it is, its size in pixels, and for a video its length and how it is compressed. Each
// check passes, warns (a person decides) or fails (it cannot be approved). The limits are settings.
// What no machine can judge (flashing, looking like a road sign, banned categories) is the reviewer's
// checklist (P3.9.2).

export interface AdRules {
  /** Largest picture and video, bytes. */
  readonly maxPictureBytes: number;
  readonly maxVideoBytes: number;
  /** A video must last one spot, give or take this much (milliseconds). */
  readonly spotMs: number;
  readonly lengthToleranceMs: number;
  /** The shorter side must be at least this many pixels (a smaller ad looks blurred). */
  readonly minShortSide: number;
  /** The screen's shape, width ÷ height in thousandths (16:9 = 1778); off by more than the
   * tolerance (thousandths of it) is a warning: the ad would be cropped or framed. */
  readonly screenAspectMilli: number;
  readonly aspectToleranceMilli: number;
  /** Video compressions the screens play well; others are a warning. */
  readonly goodCodecs: readonly string[];
}

export const DEFAULT_AD_RULES: AdRules = {
  maxPictureBytes: 10 * 1024 * 1024,
  maxVideoBytes: 64 * 1024 * 1024,
  spotMs: 15_000,
  lengthToleranceMs: 500,
  minShortSide: 480,
  screenAspectMilli: 1778,
  aspectToleranceMilli: 100,
  goodCodecs: ['avc1'],
};

export type AdKind = 'png' | 'jpeg' | 'webp' | 'mp4';

export interface AdFacts {
  readonly kind: AdKind | null;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Videos only. */
  readonly durationMs: number | null;
  readonly codec: string | null;
}

export type CheckOutcome = 'pass' | 'warn' | 'fail';

export interface AdCheck {
  readonly check: 'kind' | 'size' | 'pixels' | 'shape' | 'length' | 'codec';
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] ?? 0) * 256 + (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) + (b[at + 1] ?? 0) * 256;
const u24le = (b: Uint8Array, at: number) => u16le(b, at) + (b[at + 2] ?? 0) * 65_536;
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65_536 + u16be(b, at + 2);
const u64be = (b: Uint8Array, at: number) => u32be(b, at) * 4_294_967_296 + u32be(b, at + 4);

/** What kind of file this is, by its first bytes (the same test the screen's player uses). */
export function adKind(b: Uint8Array): AdKind | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 4, 4) === 'ftyp') return 'mp4';
  return null;
}

/** A picture's size in pixels, from its header; null when it cannot be read. */
export function pictureSize(b: Uint8Array, kind: AdKind): { width: number; height: number } | null {
  if (kind === 'png') {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (kind === 'webp') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b.length >= 30)
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && b.length >= 30)
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    return null;
  }
  if (kind === 'jpeg') {
    // Walk the segments to the frame header (SOF0–SOF15, not DHT/JPG/DAC).
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const len = u16be(b, at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { height: u16be(b, at + 5), width: u16be(b, at + 7) };
      if (len < 2) return null;
      at += 2 + len;
    }
    return null;
  }
  return null;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** A video's length, size and compression from its MP4 boxes; nulls where they cannot be read. */
export function mp4Facts(b: Uint8Array): {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
} {
  let durationMs: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let codec: string | null = null;
  const walk = (start: number, end: number, depth: number) => {
    let at = start;
    while (at + 8 <= end && depth < 8) {
      let size = u32be(b, at);
      const type = ascii(b, at + 4, 4);
      let head = 8;
      if (size === 1) {
        if (at + 16 > end) return;
        size = u64be(b, at + 8);
        head = 16;
      } else if (size === 0) size = end - at;
      if (size < head || at + size > end) return; // a broken box: stop reading this level
      const body = at + head;
      if (CONTAINERS.has(type)) walk(body, at + size, depth + 1);
      else if (type === 'mvhd' && body + 32 <= at + size) {
        const v1 = b[body] === 1;
        const scale = u32be(b, body + (v1 ? 20 : 12));
        const dur = v1 ? u64be(b, body + 24) : u32be(b, body + 16);
        if (scale > 0) durationMs = Math.round((dur * 1000) / scale);
      } else if (type === 'tkhd') {
        const v1 = b[body] === 1;
        const wAt = body + (v1 ? 88 : 76);
        if (wAt + 8 <= at + size) {
          const w = Math.floor(u32be(b, wAt) / 65_536);
          const h = Math.floor(u32be(b, wAt + 4) / 65_536);
          if (w > 0 && h > 0 && width === null) {
            width = w;
            height = h;
          }
        }
      } else if (type === 'stsd' && body + 16 <= at + size && codec === null) {
        const c = ascii(b, body + 12, 4);
        if (
          /^[a-z0-9]{4}$/i.test(c) &&
          ['avc1', 'avc3', 'hev1', 'hvc1', 'vp09', 'av01', 'mp4v'].includes(c)
        )
          codec = c;
      }
      at += size;
    }
  };
  walk(0, b.length, 0);
  return { durationMs, width, height, codec };
}

/** What a file is: its kind, size, pixels and (for a video) length and compression. */
export function adFacts(b: Uint8Array): AdFacts {
  const kind = adKind(b);
  if (kind === 'mp4') return { kind, bytes: b.length, ...mp4Facts(b) };
  const px = kind ? pictureSize(b, kind) : null;
  return {
    kind,
    bytes: b.length,
    width: px?.width ?? null,
    height: px?.height ?? null,
    durationMs: null,
    codec: null,
  };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Every check on a file's facts, in order. Any 'fail' means it cannot be approved. */
export function checkAd(f: AdFacts, rules: AdRules = DEFAULT_AD_RULES): AdCheck[] {
  const out: AdCheck[] = [];
  if (f.kind === null) {
    out.push({
      check: 'kind',
      outcome: 'fail',
      detail: 'not a PNG, JPEG or WebP picture or an MP4 video',
    });
    return out;
  }
  const video = f.kind === 'mp4';
  out.push({
    check: 'kind',
    outcome: 'pass',
    detail: video ? 'MP4 video' : `${f.kind.toUpperCase()} picture`,
  });
  const max = video ? rules.maxVideoBytes : rules.maxPictureBytes;
  out.push(
    f.bytes > max
      ? { check: 'size', outcome: 'fail', detail: `${mb(f.bytes)}: at most ${mb(max)}` }
      : f.bytes === 0
        ? { check: 'size', outcome: 'fail', detail: 'the file is empty' }
        : { check: 'size', outcome: 'pass', detail: mb(f.bytes) },
  );
  if (f.width === null || f.height === null || f.width <= 0 || f.height <= 0) {
    out.push({ check: 'pixels', outcome: 'fail', detail: 'its size in pixels cannot be read' });
  } else {
    const short = Math.min(f.width, f.height);
    out.push(
      short < rules.minShortSide
        ? {
            check: 'pixels',
            outcome: 'fail',
            detail: `${f.width} × ${f.height}: the shorter side must be ${rules.minShortSide} px or more`,
          }
        : { check: 'pixels', outcome: 'pass', detail: `${f.width} × ${f.height}` },
    );
    const aspect = Math.round((f.width * 1000) / f.height);
    const off = Math.abs(aspect - rules.screenAspectMilli) * 1000;
    out.push(
      off > rules.aspectToleranceMilli * rules.screenAspectMilli
        ? {
            check: 'shape',
            outcome: 'warn',
            detail: `shape ${(aspect / 1000).toFixed(2)} : 1, the screen is ${(rules.screenAspectMilli / 1000).toFixed(2)} : 1 (it will be framed or cropped)`,
          }
        : { check: 'shape', outcome: 'pass', detail: 'fits the screen' },
    );
  }
  if (video) {
    const target = rules.spotMs;
    if (f.durationMs === null)
      out.push({ check: 'length', outcome: 'fail', detail: 'its length cannot be read' });
    else
      out.push(
        Math.abs(f.durationMs - target) > rules.lengthToleranceMs
          ? {
              check: 'length',
              outcome: 'fail',
              detail: `${(f.durationMs / 1000).toFixed(1)} s: a video must last ${target / 1000} s`,
            }
          : { check: 'length', outcome: 'pass', detail: `${(f.durationMs / 1000).toFixed(1)} s` },
      );
    out.push(
      f.codec !== null && rules.goodCodecs.includes(f.codec)
        ? { check: 'codec', outcome: 'pass', detail: f.codec }
        : {
            check: 'codec',
            outcome: 'warn',
            detail: `${f.codec ?? 'unknown'} compression: the screens play H.264 best`,
          },
    );
  }
  return out;
}

/** The worst outcome of a set of checks. */
export function worst(checks: readonly AdCheck[]): CheckOutcome {
  if (checks.some((c) => c.outcome === 'fail')) return 'fail';
  return checks.some((c) => c.outcome === 'warn') ? 'warn' : 'pass';
}

/** What is wrong with ad rules (empty when they can be saved). */
export function checkAdRules(r: AdRules): string[] {
  const whole = (n: number) => Number.isSafeInteger(n) && n > 0;
  const problems: string[] = [];
  if (
    ![r.maxPictureBytes, r.maxVideoBytes, r.spotMs, r.minShortSide, r.screenAspectMilli].every(
      whole,
    )
  )
    problems.push('ad limits must be whole numbers above 0');
  if (
    !Number.isSafeInteger(r.lengthToleranceMs) ||
    r.lengthToleranceMs < 0 ||
    r.lengthToleranceMs > 5_000
  )
    problems.push('ad length tolerance must be 0 to 5 seconds');
  if (
    !Number.isSafeInteger(r.aspectToleranceMilli) ||
    r.aspectToleranceMilli < 0 ||
    r.aspectToleranceMilli > 1_000
  )
    problems.push('ad shape tolerance must be 0 to 100%');
  if (r.maxVideoBytes > 64 * 1024 * 1024 || r.maxPictureBytes > r.maxVideoBytes)
    problems.push('ad files are at most 64 MB (pictures no larger than videos)');
  return problems;
}
