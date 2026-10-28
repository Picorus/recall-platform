// P2.1: who a screen is. Each controller box gets a screen id at our warehouse ("SCR-7K3M9QX4": seven
// random letters and digits and a check character, so a mistyped id is caught), and a QR sticker
// with it. Fitting links the box to a bike (number plate) and a rider by scanning that QR. The box
// makes its own two keys inside its secure store (one for the secure line, one for signing plays);
// only the public halves leave it, in an enrolment request signed with both.
// The Kotlin player builds the same ids, QR text and request bytes (shared cases in test-vectors/).

/** Crockford base32: no I, L, O or U, so ids read aloud and typed by hand stay clear. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Luhn mod 32 check character: catches every single wrong character and most swaps. */
export function checkCharacter(body: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const code = ALPHABET.indexOf(body[i] ?? '');
    if (code < 0) throw new RangeError(`Not a screen id character: ${body[i]}`);
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return ALPHABET[(32 - (sum % 32)) % 32] ?? '0';
}

const SCREEN_ID = /^SCR-[0-9A-HJKMNP-TV-Z]{8}$/;

/** A new screen id from 7 random values 0–31 (the caller supplies them: crypto in production). */
export function newScreenId(random: readonly number[]): string {
  if (random.length !== 7 || random.some((r) => !Number.isInteger(r) || r < 0 || r > 31))
    throw new RangeError('A screen id needs 7 random values 0–31');
  const body = random.map((r) => ALPHABET[r]).join('');
  return `SCR-${body}${checkCharacter(body)}`;
}

export function isScreenId(id: string): boolean {
  return SCREEN_ID.test(id) && checkCharacter(id.slice(4, 11)) === id[11];
}

/** What the QR sticker on a screen says. */
export const screenQr = (screenId: string) => `RECALL1:${screenId}`;

/** Spaces, tabs and line ends at either end (only these, so the Kotlin player agrees exactly). */
const trimAscii = (t: string) => t.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/** The screen id in a scanned QR, or undefined when it is not a RECALL screen's QR. */
export function screenIdFromQr(text: string): string | undefined {
  const m = /^RECALL1:(SCR-[0-9A-Z]{8})$/.exec(trimAscii(text));
  return m?.[1] && isScreenId(m[1]) ? m[1] : undefined;
}

/**
 * A screen id typed by hand (the one printed under the QR), in its one form, or undefined: small
 * letters, spaces and dashes anywhere, and "SCR" left off, are all fine ("scr 7k3m 9qx4 " →
 * "SCR-7K3M9QX4"). The check character still catches a mistyped one.
 */
export function typedScreenId(text: string): string | undefined {
  const m = /^(?:SCR)?([0-9A-Z]{8})$/.exec(text.toUpperCase().replace(/[\s-]/g, ''));
  const id = m ? `SCR-${m[1] ?? ''}` : '';
  return isScreenId(id) ? id : undefined;
}

/**
 * An Indian number plate in one form, or undefined when it is not one. Spaces, dots and dashes are
 * dropped, the district gets two digits and the number four ("ts 9 ea 12" → "TS09EA0012"), so one
 * bike is never two. Takes state series with 1–3 series letters (without letters the digits could
 * be read two ways) and the Bharat series (22 BH 1234 AB). A number of 0 is not a plate.
 */
export function numberPlate(text: string): string | undefined {
  const p = text.toUpperCase().replace(/[ .-]/g, '');
  const state = /^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/.exec(p);
  if (state) {
    const [, st, district, series, num] = state as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (Number(district) === 0 || Number(num) === 0) return undefined;
    return `${st}${district.padStart(2, '0')}${series}${num.padStart(4, '0')}`;
  }
  const bharat = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/.exec(p);
  if (bharat && Number(bharat[1]) >= 21 && Number(bharat[2]) > 0) return p;
  return undefined;
}

/** What a box sends to be enrolled at the warehouse. */
export interface EnrolmentRequest {
  /** The board's own serial number, read from the hardware. */
  readonly hardwareSerial: string;
  /** The kit's model, as the vendor names it. */
  readonly model: string;
  /** Public keys (ECDSA P-256, SubjectPublicKeyInfo DER, base64): the secure line, and plays. */
  readonly tlsPublicKey: string;
  readonly playPublicKey: string;
  /** When the box made the request (UTC seconds). */
  readonly madeAt: number;
}

const SERIAL = /^[A-Za-z0-9._:-]{4,64}$/;
const MODEL = /^[\x20-\x7e]{1,80}$/;
const KEY = /^[A-Za-z0-9+/]{40,400}={0,2}$/;

export function enrolmentProblem(r: EnrolmentRequest): string | undefined {
  if (!SERIAL.test(r.hardwareSerial)) return 'bad hardware serial';
  if (!MODEL.test(r.model)) return 'bad model';
  if (!KEY.test(r.tlsPublicKey) || !KEY.test(r.playPublicKey)) return 'bad public key';
  if (r.tlsPublicKey === r.playPublicKey) return 'the two keys must be different';
  if (!Number.isSafeInteger(r.madeAt) || r.madeAt < 0) return 'bad time';
  return undefined;
}

/**
 * The exact bytes both keys sign, proving the box holds them: a fixed header, then each field on
 * its own line. The Kotlin player builds the same string.
 */
export const enrolmentBytes = (r: EnrolmentRequest): string =>
  ['RECALL-ENROL-1', r.hardwareSerial, r.model, r.tlsPublicKey, r.playPublicKey, r.madeAt].join(
    '\n',
  );
