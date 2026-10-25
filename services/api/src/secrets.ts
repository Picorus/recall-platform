// P3.1: the secret parts of staff sign-in, all from Node's own crypto (nothing to install):
// - passwords kept only as scrypt hashes (each with its own salt), compared in constant time;
// - the two-step code: TOTP (RFC 6238; 6 digits, 30 seconds, SHA-1), what Google Authenticator and
//   every other authenticator app reads from a QR code;
// - two-step secrets kept encrypted (AES-256-GCM) with a key from the secret store;
// - session and invite tokens: 32 random bytes; only their SHA-256 hash is stored.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------- passwords

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number) {
  return new Promise<Buffer>((ok, fail) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) =>
      e ? fail(e) : ok(k),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash` (salt and hash in base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!n || !r || !p || n > 2 ** 20 || r > 16 || p > 4) return false;
  const want = Buffer.from(parts[5] ?? '', 'base64url');
  if (want.length !== KEY_LEN) return false;
  const got = await scryptAsync(password, Buffer.from(parts[4] ?? '', 'base64url'), n, r, p);
  return timingSafeEqual(got, want);
}

/** A hash to compare against when the email is unknown, so a wrong email takes as long. */
let decoy: Promise<string> | undefined;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}

// ---------------------------------------------------------------- two-step codes (TOTP)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_S = 30;

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new RangeError('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new two-step secret (20 random bytes, base32). */
export function newTotpSecret(): string {
  return base32(randomBytes(20));
}

/** The code for one 30-second step (RFC 6238 / 4226). */
export function totpCode(secret: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const off = (mac[mac.length - 1] ?? 0) & 15;
  const n = mac.readUInt32BE(off) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, '0');
}

/**
 * The step a code belongs to (now, or one step either side for a phone clock a little off), or
 * undefined when it matches none. A step at or before `usedUpTo` is refused: a code is used once.
 */
export function totpStep(
  secret: string,
  code: string,
  nowMs: number,
  usedUpTo = -1,
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const now = Math.floor(nowMs / 1000 / TOTP_STEP_S);
  let found: number | undefined;
  for (const step of [now - 1, now, now + 1]) {
    const want = Buffer.from(totpCode(secret, step));
    // Every candidate is checked, so the time taken does not tell which one matched.
    if (timingSafeEqual(want, Buffer.from(code)) && step > usedUpTo) found = step;
  }
  return found;
}

/** What an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`RECALL:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=RECALL&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------- secrets kept encrypted

/** Reads the 32-byte key (64 hex characters, or base64) from the secret store's value. */
export function readKey(text: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new RangeError('STAFF_SECRET_KEY must be 32 bytes');
  return key;
}

/** `v1.iv.tag.data` (base64url): AES-256-GCM. */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data]
    .map((x) => (typeof x === 'string' ? x : x.toString('base64url')))
    .join('.');
}

export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new RangeError('not a sealed secret');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- tokens

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
