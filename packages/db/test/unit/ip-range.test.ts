// P7.1: an IPv6 /64 belongs to its /48 for the wider limits; IPv4 is never grouped.
import { describe, expect, it } from 'vitest';
import { ipRange } from '../../src/ip-range.js';

describe('ipRange (P7.1)', () => {
  it('the /48 of an address key, as a prefix; nothing for IPv4 or anything else', () => {
    expect(ipRange('2001:db8:1:2::/64')).toBe('2001:db8:1:');
    expect(ipRange('2401:4900:1c3:ffff::/64')).toBe('2401:4900:1c3:');
    expect(ipRange('49.36.10.2')).toBeUndefined();
    expect(ipRange('unknown')).toBeUndefined();
    expect(ipRange("2001:db8:1:%'::/64")).toBeUndefined();
  });
});
