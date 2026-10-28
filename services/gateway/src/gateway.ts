// P2.3.2: the gateway process. It answers the broker's questions (hooks.ts) and holds one MQTT
// connection to the broker, reading every screen's uploads and hellos (line.ts) and sending the
// replies. Several gateways can run side by side: the broker shares the screens' messages between
// them ($share/gateway), and each upload is stored once whichever gateway takes it.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import mqtt from 'mqtt';
import type { Pool } from 'pg';
import { hookHandler, type HookConfig } from './hooks.js';
import { filesFingerprint, filesMessage, handleUp, LineMemory, type AdLinks } from './line.js';
import { Waiting } from './waiting.js';
import { enrolledScreens, freshCommands } from '@recall/db';
import { downTopic, MAX_COMMAND_LIFE_MS } from '@recall/domain';

/** Messages handled at once; more wait their turn (each holds a database connection). */
export const AT_ONCE = 16;
/** How often commands just issued in admin are sent out. */
const FRESH_EVERY_MS = 5_000;
/** Login refusals (MQTT 3 and 5 codes): not authorized, bad user name or password. */
const REFUSED = new Set([4, 5, 134, 135]);

export interface GatewayConfig extends HookConfig {
  /** The broker's internal port, e.g. mqtt://127.0.0.1:1883. */
  readonly mqttUrl: string;
  /** Where the broker reaches the hooks (keep it on the internal network). */
  readonly hookHost: string;
  readonly hookPort: number;
  /** Signs the ad files' download links (P2.4.2); none: no file lists are sent. */
  readonly links?: AdLinks;
}

export interface RunningGateway {
  /** The port the hooks listen on (useful when 0 was asked for). */
  readonly hookPort: number;
  /** Connects to the broker (after the broker is up). */
  connect(): Promise<void>;
  stop(): Promise<void>;
}

export async function startGateway(
  pool: Pool,
  cfg: GatewayConfig,
  log: (line: string) => void = (l) => console.log(l),
): Promise<RunningGateway> {
  const server: Server = createServer(hookHandler(pool, cfg, log));
  await new Promise<void>((ok) => server.listen(cfg.hookPort, cfg.hookHost, ok));
  const address = server.address();
  const hookPort = typeof address === 'object' && address ? address.port : cfg.hookPort;
  let client: mqtt.MqttClient | undefined;
  let stopping = false;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    hookPort,
    async connect() {
      // Keeps trying until the broker takes the gateway (it may still be starting); the first
      // connection resolves this, later drops reconnect by themselves (subscriptions included).
      const c = mqtt.connect(cfg.mqttUrl, {
        clientId: `${cfg.gatewayUser}-${randomBytes(6).toString('hex')}`,
        username: cfg.gatewayUser,
        password: cfg.gatewayPassword,
        reconnectPeriod: 2_000,
      });
      client = c;
      const memory = new LineMemory();
      // Messages beyond the line's limits (waiting.ts) are dropped unanswered: their boxes send
      // them again.
      const waiting = new Waiting();
      let running = 0;
      const work = () => {
        while (running < AT_ONCE && waiting.length > 0) {
          const [topic, payload] = waiting.next() as [string, Buffer];
          running++;
          handleUp(pool, topic, payload, Date.now(), memory, cfg.links)
            .then((replies) => {
              for (const r of replies) c.publish(r.topic, r.payload, { qos: 1 });
            })
            // Not answered: the box keeps the message and sends it again.
            .catch((e: unknown) => log(`could not handle ${topic}: ${(e as Error).message}`))
            .finally(() => {
              running--;
              work();
            });
        }
      };
      c.on('message', (topic, payload) => {
        if (waiting.add(topic, payload)) work();
      });
      c.on('error', (e) => {
        log(`broker: ${e.message}`);
        // A refused login (the broker still starting, or its checks briefly unreachable) is not
        // retried by the MQTT library: try again ourselves, every 2 seconds (seen in CI, P2.3.2).
        if (!c.connected && 'code' in e && REFUSED.has(Number(e.code)))
          setTimeout(() => {
            if (!c.connected && !stopping) c.reconnect();
          }, 2_000);
      });
      await new Promise<void>((ok) => c.once('connect', () => ok()));
      // Commands just issued in admin go out at once (P3.3), not only at the screen's next hello.
      // One run at a time (a slow database never piles runs up); each command sent once by this
      // gateway (its id remembered for an hour, a command's longest life). Another gateway may send
      // it too: harmless, the box carries out each id once.
      const sent = new Map<string, number>();
      const sendFresh = async () => {
        const nowMs = Date.now();
        for (const [id, at] of sent) if (at < nowMs - MAX_COMMAND_LIFE_MS) sent.delete(id);
        for (const x of await freshCommands(pool, nowMs)) {
          if (stopping || sent.has(x.id)) continue;
          sent.set(x.id, nowMs);
          c.publish(downTopic(x.screenId, 'command'), x.text, { qos: 1 });
        }
      };
      // P2.4.2: when the files the screens need change (an ad approved, a booking cancelled, a POC
      // month paid), every screen gets its new list at once, not only at its next hello. Checked at
      // most once a minute; the first check only notes where things stand.
      let filesSeen: string | undefined;
      let filesCheckedAt = 0;
      const sendFiles = async () => {
        const links = cfg.links;
        const nowMs = Date.now();
        if (!links || nowMs - filesCheckedAt < 60_000) return;
        filesCheckedAt = nowMs;
        const now = await filesFingerprint(pool, nowMs);
        const changed = filesSeen !== undefined && now !== filesSeen;
        filesSeen = now;
        if (!changed) return;
        for (const screenId of await enrolledScreens(pool)) {
          if (stopping) return;
          const text = await filesMessage(pool, screenId, nowMs, links);
          if (text) c.publish(downTopic(screenId, 'files'), text, { qos: 1 });
        }
      };
      const tick = () => {
        if (stopping) return;
        Promise.all([
          sendFresh(),
          sendFiles().catch((e: unknown) => log(`ad files: ${(e as Error).message}`)),
        ])
          .catch((e: unknown) => log(`fresh commands: ${(e as Error).message}`))
          .finally(() => {
            if (!stopping) freshTimer = setTimeout(tick, FRESH_EVERY_MS);
          });
      };
      freshTimer = setTimeout(tick, FRESH_EVERY_MS);
      // A broker still starting can refuse the first subscription (its checks not yet ready): try
      // again until it is granted. Later reconnects subscribe again by themselves.
      for (;;) {
        const granted = await c
          .subscribeAsync('$share/gateway/recall/v1/s/+/up/+', { qos: 1 })
          .then((g) => (g[0]?.qos ?? 128) < 128)
          .catch(() => false);
        if (granted) return;
        log('broker: subscription not granted yet, trying again');
        // The MQTT library skips a topic it thinks it already asked for: forget it first.
        await c.unsubscribeAsync('$share/gateway/recall/v1/s/+/up/+').catch(() => undefined);
        await new Promise((ok) => setTimeout(ok, 1_000));
        if (!c.connected) await new Promise<void>((ok) => c.once('connect', () => ok()));
      }
    },
    async stop() {
      stopping = true;
      if (freshTimer) clearTimeout(freshTimer);
      await client?.endAsync();
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections(); // the broker keeps its hook connections open
      await closed;
    },
  };
}
