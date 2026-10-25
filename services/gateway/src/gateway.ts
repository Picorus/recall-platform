// P2.3.2: the gateway process. It answers the broker's questions (hooks.ts) and holds one MQTT
// connection to the broker, reading every screen's uploads and hellos (line.ts) and sending the
// replies. Several gateways can run side by side: the broker shares the screens' messages between
// them ($share/gateway), and each upload is stored once whichever gateway takes it.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import mqtt from 'mqtt';
import type { Pool } from 'pg';
import { hookHandler, type HookConfig } from './hooks.js';
import { handleUp } from './line.js';

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
      c.on('message', (topic, payload) => {
        handleUp(pool, topic, payload, Date.now())
          .then((replies) => {
            for (const r of replies) c.publish(r.topic, r.payload, { qos: 1 });
          })
          // Not answered: the box keeps the message and sends it again.
          .catch((e: unknown) => log(`could not handle ${topic}: ${(e as Error).message}`));
      });
      c.on('error', (e) => log(`broker: ${e.message}`));
      await new Promise<void>((ok) => c.once('connect', () => ok()));
      await c.subscribeAsync('$share/gateway/recall/v1/s/+/up/+', { qos: 1 });
    },
    async stop() {
      await client?.endAsync();
      const closed = new Promise<void>((ok) => server.close(() => ok()));
      server.closeAllConnections(); // the broker keeps its hook connections open
      await closed;
    },
  };
}
