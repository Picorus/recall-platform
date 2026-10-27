// P7.1: limits per connection count an IPv6 address by its /64 (one home or phone). Anyone can rent
// a /48, which holds 65,536 of those, so each limit is also kept for the whole /48, RANGE_SHARE
// times larger. IPv4 addresses are not grouped: many people share one behind a mobile network.

/** How many times one address's limit a whole /48 gets. */
export const RANGE_SHARE = 5;

/** The /48 an address key ("2001:db8:1:2::/64") belongs to, as a prefix to match with LIKE
 * ("2001:db8:1:"); undefined for IPv4 and anything else. */
export function ipRange(ip: string): string | undefined {
  const m = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:)[0-9a-f]{1,4}::\/64$/.exec(ip);
  return m?.[1];
}
