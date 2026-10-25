// P2.3.2: the broker (EMQX) asks the gateway two questions over HTTP. "May this one connect?" (authn)
// and "may it use this topic?" (authz). A screen connects only over TLS with a certificate we issued
// to it, recorded, in date, not revoked, and not reported lost (screenMayConnect). Then it may only
// send on its own up topics and listen on its own down topics (topicAllowed). The gateway itself
// connects on the internal port with a password, and may read every screen's up topics and write
// every screen's down topics. Anything else is refused. When in doubt (an error), refuse.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { screenMayConnect } from '@recall/db';
import { DOWN_KINDS, isScreenId, topicAllowed } from '@recall/domain';
import type { Pool } from 'pg';

export interface HookConfig {
  /** The broker sends this as "Authorization: Bearer <token>" (a secret, from the environment). */
  readonly token: string;
  /** The gateway's own login on the internal port (password from the environment). */
  readonly gatewayUser: string;
  readonly gatewayPassword: string;
}

/** Client ids the gateway uses: its user name, a dash and a random part. */
export const isGatewayClient = (cfg: HookConfig, clientId: string, username: string) =>
  username === cfg.gatewayUser && clientId.startsWith(`${cfg.gatewayUser}-`);

/** Compares two secrets in constant time (equal-length digests, so length leaks nothing). */
export const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const SHARED_UP = ['$share/gateway/recall/v1/s/+/up/+', 'recall/v1/s/+/up/+'];

/** What the gateway's own client may do: read every up topic, write any screen's down topics. */
export function gatewayTopicAllowed(topic: string, action: string): boolean {
  if (action === 'subscribe') return SHARED_UP.includes(topic);
  if (action !== 'publish') return false;
  const m = /^recall\/v1\/s\/([^/]+)\/down\/([a-z]+)$/.exec(topic);
  return !!m?.[1] && isScreenId(m[1]) && DOWN_KINDS.includes(m[2] as never);
}

type Body = Record<string, unknown>;
const text = (b: Body, k: string) => (typeof b[k] === 'string' ? b[k] : '');

/** Decides one authn question. */
export async function authn(pool: Pick<Pool, 'query'>, cfg: HookConfig, b: Body, now: number) {
  const clientId = text(b, 'clientid');
  const username = text(b, 'username');
  const commonName = text(b, 'cert_common_name');
  if (commonName === '' && isGatewayClient(cfg, clientId, username))
    return sameSecret(text(b, 'password'), cfg.gatewayPassword)
      ? { ok: true as const }
      : { ok: false as const, reason: 'wrong gateway password' };
  return screenMayConnect(pool, { clientId, commonName, fingerprint: username }, now);
}

/** Decides one authz question. */
export function authz(cfg: HookConfig, b: Body): boolean {
  const clientId = text(b, 'clientid');
  const topic = text(b, 'topic');
  const action = text(b, 'action');
  if (isGatewayClient(cfg, clientId, text(b, 'username')))
    return gatewayTopicAllowed(topic, action);
  return (action === 'publish' || action === 'subscribe') && topicAllowed(clientId, topic, action);
}

const MAX_BODY = 8 * 1024;

/** The HTTP handler the broker calls (POST /emqx/authn, POST /emqx/authz). */
export function hookHandler(
  pool: Pick<Pool, 'query'>,
  cfg: HookConfig,
  log: (line: string) => void = () => {},
  now: () => number = () => Math.floor(Date.now() / 1000),
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    if (req.method !== 'POST' || !sameSecret(auth, `Bearer ${cfg.token}`)) {
      reply(403, { result: 'deny' });
      req.resume();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        let b: Body = {};
        try {
          if (size > MAX_BODY) throw new Error('too big');
          const x: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof x === 'object' && x !== null && !Array.isArray(x)) b = x as Body;
        } catch {
          reply(200, { result: 'deny' });
          return;
        }
        try {
          if (req.url === '/emqx/authn') {
            const v = await authn(pool, cfg, b, now());
            if (!v.ok) log(`refused ${text(b, 'clientid').slice(0, 40)}: ${v.reason}`);
            reply(200, { result: v.ok ? 'allow' : 'deny', is_superuser: false });
          } else if (req.url === '/emqx/authz') {
            const ok = authz(cfg, b);
            if (!ok)
              log(
                `topic refused ${text(b, 'clientid').slice(0, 40)} ${text(b, 'action')} ${text(b, 'topic').slice(0, 120)}`,
              );
            reply(200, { result: ok ? 'allow' : 'deny' });
          } else reply(404, { result: 'deny' });
        } catch (e) {
          log(`hook error: ${(e as Error).message}`);
          reply(200, { result: 'deny' });
        }
      })();
    });
  };
}
