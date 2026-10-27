// P4.5: a statement link is his and that month's only, works 15 minutes, and cannot be made or
// changed without the API's key; the page escapes every value and runs no script.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readStatementToken, statementHtml, statementToken } from '../../src/rider-statement.js';

const KEY = randomBytes(32);
const NOW = 1_800_000_000;

describe('rider statement links (P4.5)', () => {
  it('his month for 15 minutes; not after, not changed, not with another key', () => {
    const t = statementToken(KEY, 'RD-000123', '2027-08', NOW);
    expect(readStatementToken(KEY, t, NOW + 899)).toEqual({
      riderId: 'RD-000123',
      month: '2027-08',
    });
    expect(readStatementToken(KEY, t, NOW + 901)).toBeNull();
    expect(readStatementToken(randomBytes(32), t, NOW)).toBeNull();
    const [body, sig] = t.split('.');
    // Another rider's body with this signature.
    const other = Buffer.from(`RD-000999|2027-08|${NOW + 900}`).toString('base64url');
    expect(readStatementToken(KEY, `${other}.${sig}`, NOW)).toBeNull();
    expect(readStatementToken(KEY, `${body}.${sig}.x`, NOW)).toBeNull();
    expect(readStatementToken(KEY, `${body}`, NOW)).toBeNull();
    expect(readStatementToken(KEY, '', NOW)).toBeNull();
  });

  it('the page escapes what it shows and has no script', () => {
    const html = statementHtml(
      {
        at: NOW,
        month: '2027-08',
        months: ['2027-08'],
        closed: true,
        days: [{ day: '2027-08-02', countedSeconds: 3600, earnedPaise: 2_500 }],
        weeks: [],
        countedSeconds: 3600,
        paidSeconds: 3600,
        hourlyPaise: 2_500,
        pocPaise: 0,
        soldPaise: 0,
        soldAsOf: null,
        adjustmentPaise: 0,
        bonusPaise: 0,
        totalPaise: 2_500,
        poc: null,
        perMovingHourPaise: 2_500,
        monthlyCapHours: 260,
      },
      { riderId: 'RD-000123', name: '<script>alert(1)</script>' },
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('₹25.00');
  });
});
