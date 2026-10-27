// P7.2: the load test, small enough for every run: 200 screens' 30-second uploads, 16 at once,
// through the gateway's own handling. Before P7.2 this deadlocked (the day's first plays needed a
// lock on every upload's table); now every upload is acked and every play kept.
import { describe, expect, it } from 'vitest';
import { runLoad } from '../../src/load.js';

describe('load (P7.2)', () => {
  it('200 screens, 16 at once: every upload acked, every play kept, no deadlock', async () => {
    const r = await runLoad({ screens: 200, rounds: 2 });
    expect(r.refused).toBe(0);
    expect(r.messages).toBe(400);
    expect(r.plays).toBe(800);
  }, 120_000);
});
