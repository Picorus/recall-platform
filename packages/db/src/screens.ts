// P2.1 in the database: enrolling a screen at the warehouse (its id, its certificate, its play key)
// and fitting it to a bike and a rider by scanning its QR.
import { createPublicKey, randomInt, verify } from 'node:crypto';
import type { DeviceCaAdapter, IssuedCertificate } from '@recall/adapters';
import {
  enrolmentBytes,
  enrolmentProblem,
  newScreenId,
  numberPlate,
  screenIdFromQr,
  screenQr,
  type EnrolmentRequest,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { assignScreenIn } from './rider-pay.js';

/** How long a screen's certificate lasts; it is renewed over the secure line before then (P2.3). */
export const SCREEN_CERT_DAYS = 2 * 365;
/** An enrolment request older or newer than this (box clock vs ours) is refused: no replays. */
const ENROL_CLOCK_SECONDS = 10 * 60;
/** The key id plays are signed with on a newly enrolled screen. */
export const FIRST_PLAY_KEY = 'k1';

export interface SignedEnrolment extends EnrolmentRequest {
  /** `enrolmentBytes` signed with each key (ECDSA P-256 with SHA-256, DER, base64). */
  readonly tlsSignature: string;
  readonly playSignature: string;
}

export interface Enrolled {
  readonly screenId: string;
  /** Text for the QR sticker. */
  readonly qr: string;
  readonly certSerial: string;
  readonly certPem: string;
  /** The CA certificate the box trusts for our side of the secure line. */
  readonly caCertPem: string;
}

/** True when both keys signed the request (used at enrolment; also checks the Kotlin player's output). */
export const enrolmentSigned = (r: SignedEnrolment): boolean => {
  const bytes = enrolmentBytes(r);
  return (
    keyOk(r.tlsPublicKey, bytes, r.tlsSignature) && keyOk(r.playPublicKey, bytes, r.playSignature)
  );
};

function keyOk(spki: string, bytes: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      return false;
    return verify('sha256', Buffer.from(bytes), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Enrols a box at the warehouse (P2.1): checks the request is fresh and signed with both keys (so
 * the box really holds them), gives it a screen id, a certificate for its secure line, and records
 * its play key. A box is enrolled once; a second request for the same hardware is refused.
 */
export async function enrolScreen(
  pool: Pool,
  ca: DeviceCaAdapter,
  req: SignedEnrolment,
  by: string,
  now: number,
): Promise<Enrolled> {
  const problem = enrolmentProblem(req);
  if (problem) throw new Error(problem);
  if (Math.abs(req.madeAt - now) > ENROL_CLOCK_SECONDS)
    throw new Error("the request is not fresh: check the box's clock and try again");
  if (!enrolmentSigned(req))
    throw new Error('the request is not signed by both keys (ECDSA P-256)');
  let screenId = '';
  let cert: IssuedCertificate | undefined;
  // One enrolment at a time (it calls the certificate authority inside the transaction), so two
  // requests for the same box, or with the same key, can never both get a certificate.
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-enrol'))");
    const known = await c.query<{ screen_id: string }>(
      'SELECT screen_id FROM screens WHERE hardware_serial = $1',
      [req.hardwareSerial],
    );
    if (known.rows[0])
      throw new Error(`this box is already enrolled as ${known.rows[0].screen_id}`);
    // A key belongs to one screen, in one role: a copied key must not make one bike count as two.
    const reused = await c.query<{ screen_id: string }>(
      `SELECT screen_id FROM screen_keys WHERE public_key = ANY($1)
       UNION SELECT screen_id FROM screen_certificates WHERE public_key = ANY($1)`,
      [[req.tlsPublicKey, req.playPublicKey]],
    );
    if (reused.rows[0])
      throw new Error(`a key in this request already belongs to ${reused.rows[0].screen_id}`);
    // A fresh id (35 random bits); tried again in the unlikely case it is taken.
    for (let i = 0; i < 5 && !screenId; i++) {
      const id = newScreenId(Array.from({ length: 7 }, () => randomInt(32)));
      const taken = await c.query('SELECT 1 FROM screens WHERE screen_id = $1', [id]);
      if (taken.rowCount === 0) screenId = id;
    }
    if (!screenId) throw new Error('could not find a free screen id');
    cert = await ca.issue({
      screenId,
      publicKey: req.tlsPublicKey,
      notBefore: now - 3600, // a little slack for box clocks
      notAfter: now + SCREEN_CERT_DAYS * 86_400,
    });
    await c.query(
      `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [screenId, req.hardwareSerial, req.model, by, now],
    );
    await c.query(
      `INSERT INTO screen_certificates
         (serial, screen_id, public_key, cert_pem, not_before, not_after, issued_by, issued_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), $7, to_timestamp($8))`,
      [
        cert.serial,
        screenId,
        req.tlsPublicKey,
        cert.certPem,
        cert.notBefore,
        cert.notAfter,
        by,
        now,
      ],
    );
    await c.query(
      'INSERT INTO screen_keys (screen_id, key_id, public_key, added_by) VALUES ($1, $2, $3, $4)',
      [screenId, FIRST_PLAY_KEY, req.playPublicKey, by],
    );
  });
  if (!cert) throw new Error('no certificate issued');
  return {
    screenId,
    qr: screenQr(screenId),
    certSerial: cert.serial,
    certPem: cert.certPem,
    caCertPem: await ca.caCertPem(),
  };
}

export interface Fitting {
  readonly screenId: string;
  readonly bike: string;
  readonly riderId: string;
  readonly from: number;
}

/** What a screen is on now (or at `at`), or undefined when it is on no bike. */
/** The latest change recorded for a screen: a new one must come after it. */
async function lastChange(c: Pick<Pool, 'query'>, screenId: string, now: number) {
  const r = await c.query<{ t: string }>(
    `SELECT extract(epoch FROM max(from_at))::bigint AS t FROM screen_fittings WHERE screen_id = $1`,
    [screenId],
  );
  const t = r.rows[0]?.t;
  if (t !== null && t !== undefined && Number(t) >= now)
    throw new Error(
      `${screenId} already has a change at this moment or later: try again in a moment`,
    );
}

async function fittingAt(
  c: Pick<Pool, 'query'>,
  screenId: string,
  at: number,
): Promise<Fitting | undefined> {
  const r = await c.query<{ bike: string | null; rider_id: string | null; t: string }>(
    `SELECT bike, rider_id, extract(epoch FROM from_at)::bigint AS t FROM screen_fittings
      WHERE screen_id = $1 AND from_at <= to_timestamp($2) ORDER BY from_at DESC LIMIT 1`,
    [screenId, at],
  );
  const f = r.rows[0];
  return f?.bike && f.rider_id
    ? { screenId, bike: f.bike, riderId: f.rider_id, from: Number(f.t) }
    : undefined;
}

/**
 * Fits a screen to a bike and a rider (P2.1, from the rider app's QR scan): the screen must be
 * enrolled, with a valid certificate and a play key not given up; one screen per bike and one per
 * rider. Scanning the same screen for the same bike and rider again changes nothing.
 */
export async function fitScreen(
  pool: Pool,
  scan: { readonly qr: string; readonly plate: string; readonly riderId: string },
  by: string,
  now: number,
): Promise<Fitting> {
  const screenId = screenIdFromQr(scan.qr);
  if (!screenId) throw new Error('this is not a RECALL screen QR');
  const bike = numberPlate(scan.plate);
  if (!bike) throw new Error('this does not look like a number plate');
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-fittings'))");
    return fitIn(c, screenId, bike, scan.riderId, by, now, 'fitted');
  });
}

/** Where a screen is in its service life: in repair or retired stops it being fitted (P3.4). */
async function serviceState(c: Pick<Pool, 'query'>, screenId: string, now: number) {
  const r = await c.query<{ kind: 'to-repair' | 'repaired' | 'retired' }>(
    `SELECT kind FROM screen_service_events WHERE screen_id = $1 AND at <= to_timestamp($2)
      ORDER BY id DESC LIMIT 1`,
    [screenId, now],
  );
  return r.rows[0]?.kind;
}

/** Fits a screen inside the caller's transaction (which holds the fittings lock). */
async function fitIn(
  c: PoolClient,
  screenId: string,
  bike: string,
  riderId: string,
  by: string,
  now: number,
  reason: string,
): Promise<Fitting> {
  {
    const s = await c.query<{ ok_cert: boolean; ok_key: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM screen_certificates
                       WHERE screen_id = $1 AND not_after > to_timestamp($2)) AS ok_cert,
              EXISTS (SELECT 1 FROM screen_keys k
                        LEFT JOIN screen_key_revocations r USING (screen_id, key_id)
                       WHERE k.screen_id = $1 AND r.key_id IS NULL) AS ok_key
         FROM screens WHERE screen_id = $1`,
      [screenId, now],
    );
    const row = s.rows[0];
    if (!row) throw new Error(`${screenId} is not enrolled: enrol it at the warehouse first`);
    if (!row.ok_cert) throw new Error(`${screenId} has no valid certificate: renew it first`);
    if (!row.ok_key)
      throw new Error(`${screenId} was reported lost or stolen: it cannot be fitted`);
    const service = await serviceState(c, screenId, now);
    if (service === 'to-repair')
      throw new Error(`${screenId} is in repair: mark it repaired first`);
    if (service === 'retired') throw new Error(`${screenId} is retired: it cannot be fitted`);
    const current = await fittingAt(c, screenId, now);
    if (current?.bike === bike && current.riderId === riderId) return current;
    if (current) throw new Error(`${screenId} is on ${current.bike}: take it off that bike first`);
    await lastChange(c, screenId, now);
    const onBike = await c.query<{ screen_id: string }>(
      `SELECT screen_id FROM (
         SELECT DISTINCT ON (screen_id) screen_id, bike FROM screen_fittings
          WHERE from_at <= to_timestamp($2) ORDER BY screen_id, from_at DESC) x
        WHERE bike = $1`,
      [bike, now],
    );
    if (onBike.rows[0]) throw new Error(`${bike} already carries ${onBike.rows[0].screen_id}`);
    await c.query(
      `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by)
       VALUES ($1, to_timestamp($2), $3, $4, $5, $6)`,
      [screenId, now, bike, riderId, reason, by],
    );
    // Rider pay follows the screen (P1.7.5): the rider is on this screen from now.
    await assignScreenIn(c, screenId, riderId, now, by);
    return { screenId, bike, riderId, from: now };
  }
}

/** Takes a fitted screen off inside the caller's transaction (which holds the fittings lock). */
async function unfitIn(c: PoolClient, screenId: string, reason: string, by: string, now: number) {
  if (!(await fittingAt(c, screenId, now))) throw new Error(`${screenId} is not on a bike`);
  await lastChange(c, screenId, now);
  await c.query(
    `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by)
     VALUES ($1, to_timestamp($2), NULL, NULL, $3, $4)`,
    [screenId, now, reason.trim().slice(0, 200), by],
  );
  await assignScreenIn(c, screenId, null, now, by);
}

/**
 * Swaps a bike's screen for a spare (P3.4): the old one comes off and goes to repair, the spare goes
 * on the same bike for the same rider, all at once (the bike is never without a screen on record,
 * and rider pay follows the new screen).
 */
export async function swapScreen(
  pool: Pool,
  o: {
    readonly oldScreenId: string;
    readonly newScreenId: string;
    readonly reason: string;
    readonly by: string;
    readonly now: number;
  },
): Promise<Fitting> {
  const reason = o.reason.trim();
  if (reason.length < 3) throw new Error('say why the screen is swapped');
  if (o.oldScreenId === o.newScreenId) throw new Error('pick a different screen to swap in');
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-fittings'))");
    const old = await fittingAt(c, o.oldScreenId, o.now);
    if (!old) throw new Error(`${o.oldScreenId} is not on a bike`);
    await unfitIn(c, o.oldScreenId, `swapped for ${o.newScreenId}: ${reason}`, o.by, o.now);
    await serviceEventIn(c, o.oldScreenId, 'to-repair', `swapped out: ${reason}`, o.by, o.now);
    return fitIn(
      c,
      o.newScreenId,
      old.bike,
      old.riderId,
      o.by,
      o.now,
      `swapped in for ${o.oldScreenId}`,
    );
  });
}

export type ServiceKind = 'to-repair' | 'repaired' | 'retired';

async function serviceEventIn(
  c: Pick<Pool, 'query'>,
  screenId: string,
  kind: ServiceKind,
  reason: string,
  by: string,
  now: number,
) {
  await c.query(
    `INSERT INTO screen_service_events (screen_id, kind, reason, by, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [screenId, kind, reason.slice(0, 200), by.slice(0, 80), now],
  );
}

/**
 * A screen goes to repair, comes back repaired, or is retired for good (P3.4). A screen on a bike
 * must be taken off (or swapped) first; a retired one stays retired.
 */
export async function serviceScreen(
  pool: Pool,
  o: {
    readonly screenId: string;
    readonly kind: ServiceKind;
    readonly reason: string;
    readonly by: string;
    readonly now: number;
  },
): Promise<void> {
  const reason = o.reason.trim();
  if (reason.length < 3) throw new Error('say why');
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-fittings'))");
    const known = await c.query('SELECT 1 FROM screens WHERE screen_id = $1', [o.screenId]);
    if (known.rowCount === 0) throw new Error(`${o.screenId} is not enrolled`);
    const now = await serviceState(c, o.screenId, o.now);
    if (now === 'retired') throw new Error(`${o.screenId} is retired`);
    if (o.kind === 'repaired' && now !== 'to-repair')
      throw new Error(`${o.screenId} is not in repair`);
    if (o.kind === 'to-repair' && now === 'to-repair')
      throw new Error(`${o.screenId} is already in repair`);
    if (o.kind !== 'repaired' && (await fittingAt(c, o.screenId, o.now)))
      throw new Error(`${o.screenId} is on a bike: take it off or swap it first`);
    await serviceEventIn(c, o.screenId, o.kind, reason, o.by, o.now);
  });
}

/** Takes a screen off its bike and rider (returned, swapped, or bike sold), with why. */
export async function unfitScreen(
  pool: Pool,
  screenId: string,
  reason: string,
  by: string,
  now: number,
): Promise<void> {
  if (reason.trim().length < 3) throw new Error('say why the screen is taken off');
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-fittings'))");
    await unfitIn(c, screenId, reason, by, now);
  });
}

/** What a screen is: its box, its certificate and where it is fitted now. */
export async function screenStatus(pool: Pick<Pool, 'query'>, screenId: string, now: number) {
  const s = await pool.query<{ hardware_serial: string; model: string }>(
    'SELECT hardware_serial, model FROM screens WHERE screen_id = $1',
    [screenId],
  );
  const box = s.rows[0];
  if (!box) return undefined;
  const cert = await pool.query<{ serial: string; until: string }>(
    `SELECT serial, extract(epoch FROM not_after)::bigint AS until FROM screen_certificates
      WHERE screen_id = $1 ORDER BY not_after DESC LIMIT 1`,
    [screenId],
  );
  return {
    screenId,
    hardwareSerial: box.hardware_serial,
    model: box.model,
    certificate: cert.rows[0]
      ? { serial: cert.rows[0].serial, notAfter: Number(cert.rows[0].until) }
      : undefined,
    fitting: await fittingAt(pool, screenId, now),
  };
}
