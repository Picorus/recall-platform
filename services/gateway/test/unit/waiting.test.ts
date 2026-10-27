// P7.1: no screen, and no flood, pushes everyone else out of the gateway's line.
import { describe, expect, it } from 'vitest';
import { MOST_BYTES, MOST_PER_SCREEN, MOST_WAITING, Waiting } from '../../src/waiting.js';

const up = (screen: string) => `recall/v1/s/${screen}/up/upload`;

describe("the gateway's waiting line (P7.1)", () => {
  it('one screen gets a few places; the others still get in; places come back as they are served', () => {
    const w = new Waiting();
    for (let i = 0; i < MOST_PER_SCREEN; i++) expect(w.add(up('A'), Buffer.from('x'))).toBe(true);
    expect(w.add(up('A'), Buffer.from('x'))).toBe(false);
    expect(w.add(up('B'), Buffer.from('y'))).toBe(true);
    expect(w.next()?.[0]).toBe(up('A'));
    expect(w.add(up('A'), Buffer.from('x'))).toBe(true);
    expect(w.length).toBe(MOST_PER_SCREEN + 1);
  });

  it('at most so many messages, and so many bytes, wait in all', () => {
    const w = new Waiting();
    for (let i = 0; i < MOST_WAITING; i++) expect(w.add(up(`S${i}`), Buffer.alloc(1))).toBe(true);
    expect(w.add(up('late'), Buffer.alloc(1))).toBe(false);
    const big = new Waiting();
    const chunk = Buffer.alloc(300 * 1024);
    let taken = 0;
    while (big.add(up(`S${taken}`), chunk)) taken++;
    expect(taken).toBe(Math.floor(MOST_BYTES / chunk.length));
    big.next();
    expect(big.add(up('again'), chunk)).toBe(true);
  });

  it('oldest first', () => {
    const w = new Waiting();
    w.add(up('A'), Buffer.from('1'));
    w.add(up('B'), Buffer.from('2'));
    expect(w.next()?.[1].toString()).toBe('1');
    expect(w.next()?.[1].toString()).toBe('2');
    expect(w.next()).toBeUndefined();
  });
});
