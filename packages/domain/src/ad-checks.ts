// P3.9.1: the automatic checks an uploaded ad goes through before a person reviews it. An ad is one
// file the screen plays for a whole 15-second spot: a picture (PNG, JPEG or WebP, shown for the
// spot; a brand's "carousel" is 2 to 5 of these taking turns) or a video (MP4). Prateek's rule
// (DECISIONS, 22 Oct 2026): 1280 × 640, no sound, up to 30 MB, 15 seconds. The file's own bytes
// are read, never its name or what the uploader says: what kind it is, its size in pixels, and for
// a video its length, sound and compression. Each check passes, warns (a person decides) or fails
// (it cannot be approved). The limits are settings.
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
  /** The screen's shape, width ÷ height in thousandths (1280 × 640 = 2000); off by more than the
   * tolerance (thousandths of it) fails: the ad would be cropped or framed. */
  readonly screenAspectMilli: number;
  readonly aspectToleranceMilli: number;
  /** Video compressions the screens play well; others are a warning. */
  readonly goodCodecs: readonly string[];
}

export const DEFAULT_AD_RULES: AdRules = {
  maxPictureBytes: 30 * 1024 * 1024,
  maxVideoBytes: 30 * 1024 * 1024,
  spotMs: 15_000,
  lengthToleranceMs: 500,
  minShortSide: 480,
  screenAspectMilli: 2000,
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
  /** The file holds picture data (a picture) or a video track with its frames (a video), not
   * just a header. */
  readonly media: boolean;
  /** A video with a sound track (the screens play none). */
  readonly sound?: boolean;
  /** Why a video's frames or length could not be accepted, in words (when known). */
  readonly problem?: string | null;
}

export type CheckOutcome = 'pass' | 'warn' | 'fail';

export interface AdCheck {
  readonly check: 'kind' | 'content' | 'size' | 'pixels' | 'shape' | 'length' | 'sound' | 'codec';
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] ?? 0) * 256 + (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) + (b[at + 1] ?? 0) * 256;
const u24le = (b: Uint8Array, at: number) => u16le(b, at) + (b[at + 2] ?? 0) * 65_536;
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65_536 + u16be(b, at + 2);
const u32le = (b: Uint8Array, at: number) => u16le(b, at) + u16le(b, at + 2) * 65_536;
const u64be = (b: Uint8Array, at: number) => u32be(b, at) * 4_294_967_296 + u32be(b, at + 4);

/** The most any ad-size setting may allow (what the upload path accepts at all). */
export const MAX_AD_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Sizes and lengths past these are not believed (a damaged or hostile header): unreadable. */
const MAX_SIDE = 16_384;
const MAX_LENGTH_MS = 3_600_000;
/** How many boxes, chunks or segments are read at most (a file cannot keep the server busy). */
const MAX_STEPS = 10_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** MP4 brands (the ftyp box); QuickTime, HEIF/AVIF pictures and the like are not MP4 videos. */
const MP4_BRANDS = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '];
const NOT_MP4 = ['qt  ', 'avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1'];

/** What kind of file this is, by its first bytes (the same test the screen's player uses). */
export function adKind(b: Uint8Array): AdKind | null {
  if (b.length < 12) return null;
  if (PNG_SIGNATURE.every((x, i) => b[i] === x)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 4, 4) === 'ftyp') {
    const major = ascii(b, 8, 4);
    if (MP4_BRANDS.includes(major)) return 'mp4';
    if (NOT_MP4.includes(major)) return null;
    const end = Math.min(u32be(b, 0), b.length, 256);
    for (let at = 16; at + 4 <= end; at += 4)
      if (MP4_BRANDS.includes(ascii(b, at, 4))) return 'mp4';
  }
  return null;
}

interface Picture {
  readonly width: number;
  readonly height: number;
  /** Image data follows the header. */
  readonly media: boolean;
}

/** A picture's size in pixels, from its header, and whether image data follows; null when its
 * size cannot be read. */
export function pictureSize(b: Uint8Array, kind: AdKind): Picture | null {
  if (kind === 'png') {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
    // Walk the chunks for image data (IDAT) before the end (IEND).
    let media = false;
    for (let at = 8, n = 0; at + 8 <= b.length && n < MAX_STEPS; n += 1) {
      const type = ascii(b, at + 4, 4);
      if (type === 'IEND') break;
      const len = u32be(b, at);
      if (type === 'IDAT' && len > 0 && at + 12 + len <= b.length) {
        media = true;
        break;
      }
      at += 12 + len;
    }
    return { width: u32be(b, 16), height: u32be(b, 20), media };
  }
  if (kind === 'webp') {
    // RIFF chunks: the picture is a VP8 / VP8L chunk (or animation frames) with data in it.
    let media = false;
    for (let at = 12, n = 0; at + 8 <= b.length && n < MAX_STEPS; n += 1) {
      const type = ascii(b, at, 4);
      const len = u32le(b, at + 4);
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type) && len > 10 && at + 8 + len <= b.length) {
        media = true;
        break;
      }
      at += 8 + len + (len % 2);
    }
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ' && b.length >= 30)
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, media };
    if (chunk === 'VP8L' && b.length >= 25) {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, media };
    }
    if (chunk === 'VP8X' && b.length >= 30)
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, media };
    return null;
  }
  if (kind === 'jpeg') {
    // Walk the segments to the frame header (SOF0–SOF15, not DHT/JPG/DAC), then on to the
    // start of the image data (SOS).
    let size: { width: number; height: number } | null = null;
    let at = 2;
    for (let n = 0; at + 4 <= b.length && n < MAX_STEPS; n += 1) {
      if (b[at] !== 0xff) break;
      const marker = b[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const len = u16be(b, at + 2);
      if (marker === 0xda) return size && { ...size, media: at + 2 + len < b.length };
      if (
        size === null &&
        at + 9 <= b.length &&
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        size = { height: u16be(b, at + 5), width: u16be(b, at + 7) };
      if (len < 2) break;
      at += 2 + len;
    }
    return size && { ...size, media: false };
  }
  return null;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

interface Track {
  handler: string | null;
  scale: number;
  mediaDur: number | null;
  sampleDur: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
}

/** A length in milliseconds, or null when it is unknown or not believable. */
const lengthMs = (dur: number | null, scale: number, unknown: boolean): number | null => {
  if (dur === null || unknown || scale <= 0) return null;
  const ms = Math.round((dur * 1000) / scale);
  return Number.isSafeInteger(ms) && ms <= MAX_LENGTH_MS ? ms : null;
};

/**
 * A video's length, size and compression from its MP4 boxes; nulls where they cannot be read.
 * The length must agree three ways (the file's header, the video track's header and its frame
 * table), and the file must hold a video track and its data (mdat).
 */
export function mp4Facts(b: Uint8Array): {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  media: boolean;
  sound: boolean;
  problem: string | null;
} {
  let movieMs: number | null = null;
  let mdat = false;
  let fragmented = false;
  let steps = 0;
  const tracks: Track[] = [];
  const walk = (start: number, end: number, depth: number, track: Track | null) => {
    let at = start;
    while (at + 8 <= end && depth < 8 && steps < MAX_STEPS) {
      steps += 1;
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
      const stop = at + size;
      if (type === 'trak') {
        const t: Track = {
          handler: null,
          scale: 0,
          mediaDur: null,
          sampleDur: null,
          width: null,
          height: null,
          codec: null,
        };
        tracks.push(t);
        walk(body, stop, depth + 1, t);
      } else if (CONTAINERS.has(type)) walk(body, stop, depth + 1, track);
      else if (type === 'mdat' && depth === 0) mdat = size > head;
      else if (type === 'moof' || type === 'mvex') fragmented = true;
      else if ((type === 'mvhd' || type === 'mdhd') && body + (b[body] === 1 ? 32 : 20) <= stop) {
        const v1 = b[body] === 1;
        const scale = u32be(b, body + (v1 ? 20 : 12));
        const dur = v1 ? u64be(b, body + 24) : u32be(b, body + 16);
        // All ones means "unknown".
        const unknown = v1 ? u32be(b, body + 24) === 0xffffffff : dur === 0xffffffff;
        if (type === 'mvhd') movieMs = lengthMs(dur, scale, unknown);
        else if (track) {
          track.scale = scale;
          track.mediaDur = unknown ? null : dur;
        }
      } else if (type === 'hdlr' && track && body + 12 <= stop) {
        track.handler = ascii(b, body + 8, 4);
      } else if (type === 'tkhd' && track) {
        const v1 = b[body] === 1;
        const wAt = body + (v1 ? 88 : 76);
        if (wAt + 8 <= stop) {
          const w = Math.floor(u32be(b, wAt) / 65_536);
          const h = Math.floor(u32be(b, wAt + 4) / 65_536);
          // The display matrix (a b . c d .): a and d zero means turned a quarter (it plays
          // upright the other way round), so width and height swap.
          const m = body + (v1 ? 52 : 40);
          const turned =
            u32be(b, m) === 0 &&
            u32be(b, m + 16) === 0 &&
            (u32be(b, m + 4) | u32be(b, m + 12)) !== 0;
          track.width = turned ? h : w;
          track.height = turned ? w : h;
        }
      } else if (type === 'stsd' && track && body + 16 <= stop) {
        const c = ascii(b, body + 12, 4);
        if (['avc1', 'avc3', 'hev1', 'hvc1', 'vp09', 'av01', 'mp4v'].includes(c)) track.codec = c;
      } else if (type === 'stts' && track && body + 8 <= stop) {
        // The frame table: runs of (frames, each lasting so long); their total is the length.
        const entries = Math.min(u32be(b, body + 4), Math.floor((stop - body - 8) / 8));
        let total = 0;
        for (let i = 0; i < entries; i += 1)
          total += u32be(b, body + 8 + i * 8) * u32be(b, body + 12 + i * 8);
        track.sampleDur = total;
      }
      at += size;
    }
  };
  walk(0, b.length, 0, null);
  const video = tracks.find((t) => t.handler === 'vide');
  const sound = tracks.some((t) => t.handler === 'soun');
  const none = { durationMs: null, width: null, height: null, codec: null, media: false, sound };
  if (fragmented)
    return { ...none, problem: 'a fragmented (streaming) MP4: export it as a normal MP4' };
  if (!video) return { ...none, problem: 'no video track in it' };
  const lengths = [
    movieMs,
    lengthMs(video.mediaDur, video.scale, false),
    lengthMs(video.sampleDur, video.scale, false),
  ];
  // A header that disagrees with the frames is not believed.
  const agree =
    lengths.every((x) => x !== null) &&
    Math.max(...(lengths as number[])) - Math.min(...(lengths as number[])) <= 1_000;
  const [movie, track, frames] = lengths;
  const problem = agree
    ? null
    : movie != null && track != null && frames != null && movie > Math.max(track, frames) + 1_000
      ? `the sound or another track runs ${(movie / 1000).toFixed(1)} s, longer than the video (${(frames / 1000).toFixed(1)} s)`
      : 'its length is recorded inconsistently (the file may be damaged)';
  const sized =
    video.width !== null && video.height !== null && video.width > 0 && video.height > 0;
  return {
    durationMs: agree ? (lengths[2] ?? null) : null,
    width: sized ? video.width : null,
    height: sized ? video.height : null,
    codec: video.codec,
    media: mdat && (video.sampleDur ?? 0) > 0,
    sound,
    problem,
  };
}

/** What a file is: its kind, size, pixels and (for a video) length and compression. */
export function adFacts(b: Uint8Array): AdFacts {
  const kind = adKind(b);
  const f =
    kind === 'mp4'
      ? mp4Facts(b)
      : { ...(kind ? pictureSize(b, kind) : null), durationMs: null, codec: null };
  const w = f.width ?? null;
  const h = f.height ?? null;
  const believed = w !== null && h !== null && w <= MAX_SIDE && h <= MAX_SIDE;
  return {
    kind,
    bytes: b.length,
    width: believed ? w : null,
    height: believed ? h : null,
    durationMs: f.durationMs,
    codec: f.codec,
    media: f.media ?? false,
    sound: 'sound' in f ? f.sound : false,
    problem: 'problem' in f ? f.problem : null,
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
  out.push(
    f.media
      ? { check: 'content', outcome: 'pass', detail: video ? 'has a video track' : 'has a picture' }
      : {
          check: 'content',
          outcome: 'fail',
          detail: video
            ? (f.problem ?? 'no video track with frames in it')
            : 'no picture data in it',
        },
  );
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
            outcome: 'fail',
            detail: `shape ${(aspect / 1000).toFixed(2)} : 1: the screen is ${(rules.screenAspectMilli / 1000).toFixed(2)} : 1 (make it 1280 × 640)`,
          }
        : { check: 'shape', outcome: 'pass', detail: 'fits the screen' },
    );
  }
  if (video) {
    const target = rules.spotMs;
    if (f.durationMs === null)
      out.push({
        check: 'length',
        outcome: 'fail',
        detail: (f.media && f.problem) || 'its length cannot be read',
      });
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
    if (f.sound)
      out.push({
        check: 'sound',
        outcome: 'warn',
        detail: 'it has sound: the screens play none (the picture must work without it)',
      });
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
  if (r.maxVideoBytes > MAX_AD_UPLOAD_BYTES || r.maxPictureBytes > r.maxVideoBytes)
    problems.push('ad files are at most 64 MB (pictures no larger than videos)');
  return problems;
}
