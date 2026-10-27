// P7.1: uploads cannot be used to shut others out: one at a time for each business, and a sender
// trickling bytes is stopped instead of holding a slot for minutes.
import { createServer, request, type ClientRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, send, withUpload } from '../../src/http.js';

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const owner = new URL(req.url ?? '/', 'http://x').searchParams.get('owner') ?? '';
    withUpload(
      req,
      'brand-ads',
      1024 * 1024,
      async (data) => send(res, 200, { n: data.length }),
      owner,
    ).catch((e: unknown) => {
      if (!res.headersSent)
        send(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
});

/** Starts an upload of `size` bytes and sends `first` of them now. */
function start(owner: string, size: number, first: number) {
  let req: ClientRequest | undefined;
  const answer = new Promise<number>((ok) => {
    req = request(
      { port, path: `/?owner=${owner}`, method: 'POST', headers: { 'content-length': size } },
      (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      },
    );
    req.on('error', () => ok(-1));
    req.write(Buffer.alloc(first));
  });
  return { answer, rest: (n: number) => req?.end(Buffer.alloc(n)) };
}

describe('uploads (P7.1)', () => {
  it('one at a time for each business; another business still gets in', async () => {
    const a = start('chai-co', 10, 5);
    await new Promise((ok) => setTimeout(ok, 100));
    expect(await start('chai-co', 10, 10).answer).toBe(429);
    const b = start('dosa-co', 10, 10);
    b.rest(0);
    expect(await b.answer).toBe(200);
    a.rest(5);
    expect(await a.answer).toBe(200);
  });

  it('a sender trickling bytes is stopped after a few seconds', async () => {
    const slow = start('idli-co', 1024 * 1024, 10);
    const status = await slow.answer;
    expect([408, -1]).toContain(status);
    // Its slot is free again.
    const next = start('idli-co', 10, 10);
    next.rest(0);
    expect(await next.answer).toBe(200);
  }, 20_000);
});
