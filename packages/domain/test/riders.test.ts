// P3.11.1: rider details in one form, the approval checklist, and the steps a rider may take.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  approvalChecklist,
  namesMatch,
  accountNumberOf,
  ifscOf,
  phoneOf,
  plateOf,
  riderIdOf,
  upiIdOf,
  riderProblems,
  riderStepProblem,
  RIDER_ID,
  type RiderFacts,
} from '../src/riders.js';

const NOW = Date.UTC(2027, 5, 1, 6, 30) / 1000; // 1 Jun 2027, 12:00 India time
const ready: RiderFacts = {
  status: 'applied',
  details: {
    name: 'Ravi Kumar',
    phone: '+919848012345',
    bikePlate: 'TS09EA1234',
    rides: 'Madhapur',
    apps: ['swiggy'],
  },
  documents: [
    { kind: 'photo', decision: 'accepted', expiresOn: null },
    { kind: 'rc', decision: 'accepted', expiresOn: null },
    { kind: 'insurance', decision: 'accepted', expiresOn: '2027-12-31' },
  ],
  screenFitted: false,
  identity: { state: 'passed', name: 'RAVI KUMAR', current: true, reason: null },
  agreement: { state: 'passed', name: 'Ravi Kumar', current: true, reason: null },
  bank: { state: 'passed', name: 'RAVI KUMAR REDDY', current: true, reason: null },
};

describe('riders (P3.11.1)', () => {
  it('phones, plates and ids in one form', () => {
    for (const p of [
      '98480 12345',
      '+91 98480-12345',
      '09848012345',
      '919848012345',
      '0091 9848012345',
    ])
      expect(phoneOf(p), p).toBe('+919848012345');
    for (const p of ['12345', '5848012345', '+1 415 555 0100', '98480123456'])
      expect(phoneOf(p), p).toBeNull();
    expect(plateOf('ts 09 ea 1234')).toBe('TS09EA1234');
    // Payout details pasted with stray spaces (checkDestination checks the rest).
    expect(upiIdOf(' ravi @okaxis ')).toBe('ravi@okaxis');
    // A space inside the name stays (refused later), never joined into someone else's id.
    expect(upiIdOf('ravi kumar@okaxis')).toBe('ravi kumar@okaxis');
    expect(ifscOf(' sbin 0001234 ')).toBe('SBIN0001234');
    expect(ifscOf('SBIN-0001234')).toBe('SBIN0001234');
    expect(accountNumberOf(' 1234 5678-9012 ')).toBe('123456789012');
    expect(plateOf('22 BH 1234 AA')).toBe('22BH1234AA');
    expect(plateOf('TS')).toBeNull();
    expect(plateOf('1234')).toBeNull();
    expect(riderIdOf(123)).toBe('RD-000123');
    expect(RIDER_ID.test(riderIdOf(999_999))).toBe(true);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const p = phoneOf(s);
        if (p !== null) expect(phoneOf(p)).toBe(p);
        const q = plateOf(s);
        if (q !== null) expect(plateOf(q)).toBe(q);
      }),
    );
  });

  it('details are checked before they are saved', () => {
    expect(riderProblems(ready.details)).toEqual([]);
    expect(
      riderProblems({
        ...ready.details,
        name: 'R',
        phone: '98480 12345',
        apps: ['swiggy', 'swiggy'],
      }),
    ).toEqual([
      'name must be 2 to 80 letters',
      'phone must be an Indian mobile number',
      'apps must be from the list, each once',
    ]);
  });

  it('approval needs the plate and the photo, RC and insurance accepted (insurance not expired)', () => {
    expect(approvalChecklist(ready, NOW).every((c) => c.done)).toBe(true);
    expect(riderStepProblem(ready, 'approved', 'all documents good', NOW)).toBeUndefined();
    const lapsed = {
      ...ready,
      documents: [
        { kind: 'photo' as const, decision: null, expiresOn: null },
        { kind: 'insurance' as const, decision: 'accepted' as const, expiresOn: '2027-05-31' },
      ],
    };
    expect(riderStepProblem(lapsed, 'approved', 'all documents good', NOW)).toBe(
      'not ready: Photo waiting for a look; Registration (RC) not sent; Insurance expired 2027-05-31',
    );
    expect(riderStepProblem(ready, 'approved', 'ok', NOW)).toBe('say why (5 to 300 letters)');
  });

  it('active only with a screen fitted; leaving only after it comes off; the order of steps', () => {
    const approved = { ...ready, status: 'approved' as const };
    expect(riderStepProblem(approved, 'active', 'screen fitted today', NOW)).toBe(
      'fit a screen to his bike first (Screens)',
    );
    expect(
      riderStepProblem({ ...approved, screenFitted: true }, 'active', 'screen fitted today', NOW),
    ).toBeUndefined();
    const active = { ...ready, status: 'active' as const, screenFitted: true };
    expect(riderStepProblem(active, 'left', 'moving to Chennai', NOW)).toBe(
      'take his screen off first (Screens)',
    );
    expect(
      riderStepProblem({ ...active, screenFitted: false }, 'left', 'moving to Chennai', NOW),
    ).toBeUndefined();
    expect(riderStepProblem(ready, 'active', 'skip ahead', NOW)).toBe(
      'cannot go from applied to active',
    );
    // Back on the road only with documents still good; rejecting needs the screen off too.
    const paused = { ...ready, status: 'paused' as const, screenFitted: true };
    expect(
      riderStepProblem(
        {
          ...paused,
          documents: [
            ...ready.documents.slice(0, 2),
            { kind: 'insurance' as const, decision: 'accepted' as const, expiresOn: '2027-05-31' },
          ],
        },
        'active',
        'back from leave',
        NOW,
      ),
    ).toBe('not on the road: Insurance expired 2027-05-31');
    expect(riderStepProblem(paused, 'active', 'back from leave', NOW)).toBeUndefined();
    expect(
      riderStepProblem({ ...ready, status: 'left' }, 'applied', 'back in Hyderabad', NOW),
    ).toBeUndefined();
  });

  it('approval also needs identity, the current agreement and the bank checked, in his name (P3.11.2)', () => {
    expect(namesMatch('Ravi Kumar', 'RAVI KUMAR REDDY')).toBe(true);
    expect(namesMatch('Ravi K.', 'RAVI KUMAR')).toBe(true);
    expect(namesMatch('Ravi Kumar', 'SURESH KUMAR')).toBe(false);
    for (const [x, y] of [
      ['Ravi Kumar', 'R K Enterprises'],
      ['Ravi Kumar', 'R'],
      ['Ravi Kumar', 'RAVI'],
      ['A.', 'Anil Sharma'],
      ['Kumar', 'Suresh Kumar'],
      ['Ravi Kumar Reddy', 'KUMAR'],
      ['Ravi Kumar', 'R K'],
      ['Ravi Ravi', 'RAVI KUMAR'],
    ])
      expect(namesMatch(x, y), `${x} / ${y}`).toBe(false);
    expect(namesMatch('Kumar', 'KUMAR')).toBe(true);
    expect(namesMatch('Ravi K', 'RAVI KUMAR REDDY')).toBe(true);
    const items = (f: Partial<RiderFacts>) =>
      approvalChecklist({ ...ready, ...f }, NOW)
        .filter((c) => !c.done)
        .map((c) => `${c.item}: ${c.detail}`);
    expect(items({})).toEqual([]);
    expect(
      items({
        identity: null,
        agreement: { state: 'pending', name: null, current: true, reason: null },
        bank: { state: 'failed', name: null, current: true, reason: 'account closed' },
      }),
    ).toEqual([
      'Identity (KYC): not started',
      'Agreement: waiting for him',
      'Bank or UPI: failed: account closed',
    ]);
    expect(
      items({
        identity: { state: 'passed', name: 'SURESH KUMAR', current: true, reason: null },
        agreement: { state: 'passed', name: 'Ravi Kumar', current: false, reason: null },
        bank: { state: 'passed', name: 'RAVI KUMAR', current: false, reason: null },
      }),
    ).toEqual([
      'Identity (KYC): verified: "SURESH KUMAR" does not match "Ravi Kumar"',
      'Agreement: signed an older version: send the new one',
      'Bank or UPI: changed since the check: check again',
    ]);
    // A pass with no name returned compared nothing: not done.
    expect(
      items({ identity: { state: 'passed', name: null, current: true, reason: null } }),
    ).toEqual(['Identity (KYC): no name came back: start it again']);
  });
});
