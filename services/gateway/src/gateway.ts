// P2.3.2: the gateway process. It answers the broker's questions (hooks.ts) and holds one MQTT
// connection to the broker, reading every screen's uploads and hellos (line.ts) and sending the
// replies. Several gateways can run side by side: the broker shares the screens' messages between
// them ($share/gateway), and each upload is stored once whichever gateway takes it.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import mqtt from 'mqtt';
import type { Pool } from 'pg';
import { hookHandler, type HookConfig } from './hooks.js';
import { handleUp, LineMemory } from './line.js';

/** Messages handled at once; more wait their turn (each holds a database connection). */
const AT_ONCE = 16;
/** Messages waiting beyond this are dropped unanswered: their boxes send them again. */
const MOST_WAITING = 10_000;

export interface GatewayConfig extends HookConfig {
  /** The broker's internal port, e.g. mqtt://127.0.0.1:1883. */
  readonly mqttUrl: string;
  /** Where the broker reaches the hooks (keep it on the internal network). */
  readonly hookHost: string;
  readonly hookPort: number;
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
      const waiting: [string, Buffer][] = [];
      let running = 0;
      const work = () => {
        while (running < AT_ONCE && waiting.length > 0) {
          const [topic, payload] = waiting.shift() as [string, Buffer];
          running++;
          handleUp(pool, topic, payload, Date.now(), memory)
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
        if (waiting.length >= MOST_WAITING) return;
        waiting.push([topic, payload]);
        work();
      });
      c.on('error', (e) => log(`broker: ${e.message}`));
      await new Promise<void>((ok) => c.once('connect', () => ok()));
      // A broker still starting can refuse the first subscription (its checks not yet ready): try
      // again until it is granted. Later reconnects subscribe again by themselves.
      for (;;) {
        const granted = await c
          .subscribeAsync('$share/gateway/recall/v1/s/+/up/+', { qos: 1 })
          .then((g) => (g[0]?.qos ?? 128) < 128)
          .catch(() => false);
        if (granted) return;
        log('broker: subscription not granted yet, trying again');
        await new Promise((ok) => setTimeout(ok, 1_000));
        if (!c.connected) await new Promise<void>((ok) => c.once('connect', () => ok()));
      }
    },
    async stop() {
      await client?.endAsync();
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections(); // the broker keeps its hook connections open
      await closed;
    },
  };
}
