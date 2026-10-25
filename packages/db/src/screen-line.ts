// P2.3.2 in the database: who may open the secure line, and what the line leaves behind (hellos,
// uploads refused whole). The broker (EMQX) checks the TLS handshake: the box holds the key of a
// certificate our certificate authority signed. These checks add what only we know: the certificate
// is one we issued and recorded for this screen, it is in date, not revoked, and the screen was not
// reported lost or stolen.
import { createHash, X509Certificate } from 'node:crypto';
import { isScreenId } from '@recall/domain';
import { heardFrom } from './health.js';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';

export type LineVerdict =
  { readonly ok: true; readonly serial: string } | { readonly ok: false; readonly reason: string };

/** The MD5 fingerprint of a certificate's DER bytes (what EMQX passes as the username). */
export const certFingerprint = (certPem: string): string =>
  createHash('md5').update(new X509Certificate(certPem).raw).digest('hex');

/**
 * May this screen open the line? `commonName` is the name in the certificate the box presented
 * (empty when the connection is not over TLS); `fingerprint` is that certificate's MD5. Only a
 * certificate recorded for this very screen passes: a stolen copy of another screen's (certificates
 * are not secret) fails the TLS handshake, which needs the private key, before it gets here.
 */
export async function screenMayConnect(
  pool: Pick<Pool, 'query'>,
  r: { readonly clientId: string; readonly commonName: string; readonly fingerprint: string },
  now: number,
): Promise<LineVerdict> {
  if (!isScreenId(r.clientId)) return { ok: false, reason: 'not a screen id' };
  if (r.commonName !== r.clientId)
    return { ok: false, reason: 'the certificate is not for this screen (or no TLS)' };
  if (!/^[0-9a-f]{32}$/.test(r.fingerprint)) return { ok: false, reason: 'no certificate' };
  const certs = await pool.query<{
    serial: string;
    cert_pem: string;
    from_s: string;
    until_s: string;
    revoked: boolean;
  }>(
    `SELECT c.serial, c.cert_pem,
            extract(epoch FROM c.not_before)::bigint AS from_s,
            extract(epoch FROM c.not_after)::bigint AS until_s,
            r.serial IS NOT NULL AS revoked
       FROM screen_certificates c
       LEFT JOIN screen_certificate_revocations r USING (serial)
      WHERE c.screen_id = $1`,
    [r.clientId],
  );
  const cert = certs.rows.find((c) => certFingerprint(c.cert_pem) === r.fingerprint);
  if (!cert) return { ok: false, reason: 'not a certificate we issued to this screen' };
  if (cert.revoked) return { ok: false, reason: 'the certificate was revoked' };
  if (now < Number(cert.from_s) || now >= Number(cert.until_s))
    return { ok: false, reason: 'the certificate is out of date' };
  // Reported lost or stolen: its play keys are revoked (P1.5); its line is closed too.
  const keys = await pool.query<{ live: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM screen_keys k
                      LEFT JOIN screen_key_revocations v USING (screen_id, key_id)
                     WHERE k.screen_id = $1 AND v.key_id IS NULL) AS live`,
    [r.clientId],
  );
  if (!keys.rows[0]?.live) return { ok: false, reason: 'the screen was reported lost or stolen' };
  return { ok: true, serial: cert.serial };
}

/** Revokes a screen certificate: its line is refused from the next connection on. */
export async function revokeCertificate(
  pool: Pool,
  serial: string,
  reason: string,
  by: string,
  now: number,
): Promise<void> {
  if (reason.trim().length < 5) throw new Error('say why the certificate is revoked');
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO screen_certificate_revocations (serial, reason, revoked_by, revoked_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [serial, reason.trim().slice(0, 200), by, now],
    ),
  );
}

/** Records a hello (the line opened): last contact and app version, for the health view. */
export async function recordHello(
  pool: Pool,
  screenId: string,
  app: string,
  nowMs: number,
  /** The player's version code (from 0.11, P2.13), or null. */
  appCode: number | null = null,
): Promise<void> {
  await inTransaction(pool, async (c) => {
    await c.query(
      `INSERT INTO screen_hellos (screen_id, at, app, app_code)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4) ON CONFLICT DO NOTHING`,
      [screenId, nowMs, app, appCode],
    );
    // P2.11: heard from again; a "no contact" alert clears (only screens with an inbox have alerts).
    const inbox = await c.query('SELECT 1 FROM screen_inboxes WHERE screen_id = $1', [screenId]);
    if (inbox.rowCount) await heardFrom(c, screenId, Math.floor(nowMs / 1000));
  });
}

/** Records a message refused whole (it never counts; the box keeps sending it until fixed). */
export async function recordRefusal(
  pool: Pool,
  screenId: string,
  kind: 'hello' | 'upload',
  problem: string,
  bytes: number,
  nowMs: number,
): Promise<void> {
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO screen_line_refusals (screen_id, at, kind, problem, bytes)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5) ON CONFLICT DO NOTHING`,
      [screenId, nowMs, kind, problem.slice(0, 80), bytes],
    ),
  );
}

/** When each screen was last heard (its latest hello), for the health view. */
export async function lastHello(
  pool: Pick<Pool, 'query'>,
  screenId: string,
): Promise<{ readonly at: number; readonly app: string } | undefined> {
  const r = await pool.query<{ at_ms: string; app: string }>(
    `SELECT (extract(epoch FROM at) * 1000)::bigint AS at_ms, app FROM screen_hellos
      WHERE screen_id = $1 ORDER BY at DESC LIMIT 1`,
    [screenId],
  );
  const h = r.rows[0];
  return h ? { at: Number(h.at_ms), app: h.app } : undefined;
}
