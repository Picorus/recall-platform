import { describe, expect, it } from 'vitest';
import { fakeMaps } from '../src/maps.js';
import { fakeMessages } from '../src/messages.js';

describe('fake maps and messages (P1.9)', () => {
  it('names the nearest main road within 1.2 km, nothing farther', async () => {
    const maps = fakeMaps();
    expect(await maps.streetAt(17.448, 78.3915)).toBe('Madhapur Main Road');
    expect(await maps.streetAt(17.6, 78.6)).toBeUndefined();
    expect(maps.calls()).toBe(2);
  });

  it('roads near a point (P4.4): a street grid around it, some main, the same streets anywhere', async () => {
    const maps = fakeMaps();
    const roads = (await maps.roadsNear?.(17.4474, 78.3762, 900)) ?? [];
    // About 1.8 km each way at 250 m: 8 or 9 streets each way.
    expect(roads.length).toBeGreaterThanOrEqual(14);
    expect(roads.length).toBeLessThanOrEqual(20);
    expect(roads.some((r) => r.main)).toBe(true);
    expect(roads.some((r) => !r.main)).toBe(true);
    for (const r of roads) {
      expect(r.points).toHaveLength(2);
      for (const [lat, lng] of r.points) {
        expect(Math.abs(lat - 17.4474)).toBeLessThan(0.0105);
        expect(Math.abs(lng - 78.3762)).toBeLessThan(0.0105);
      }
    }
    // Asked a little way off, the streets in common are the same streets.
    const moved = (await maps.roadsNear?.(17.4484, 78.3772, 900)) ?? [];
    const lats = (rs: typeof roads) =>
      new Set(rs.filter((r) => r.points[0]?.[0] === r.points[1]?.[0]).map((r) => r.points[0]?.[0]));
    const common = [...lats(roads)].filter((y) => lats(moved).has(y));
    expect(common.length).toBeGreaterThanOrEqual(6);
    // Never more than 5 km around, however far is asked.
    expect(((await maps.roadsNear?.(17.44, 78.37, 1e9)) ?? []).length).toBeLessThan(200);
  });

  it('a message key is sent once; a passing failure can succeed later', async () => {
    const failFor = new Map([['a@b.in', { reason: 'down', retryable: true }]]);
    const m = fakeMessages({ failFor });
    const mail = {
      channel: 'email' as const,
      key: 'k1',
      to: 'a@b.in',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [],
    };
    expect((await m.send(mail)).status).toBe('failed');
    failFor.clear();
    expect((await m.send(mail)).status).toBe('sent');
    expect(await m.send(mail)).toEqual({ status: 'sent', providerRef: 'fake-email-1' });
    expect(m.sent).toHaveLength(1);
  });
});
