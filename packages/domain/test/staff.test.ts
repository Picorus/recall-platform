import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accessProblem,
  can,
  DEFAULT_SIGN_IN_RULES as R,
  isEmail,
  lockedUntil,
  moneyRole,
  normalEmail,
  passwordProblem,
  sessionAlive,
  STAFF_AREAS,
  type StaffAccess,
} from '../src/staff.js';

const sup: StaffAccess = { role: 'super-admin', areas: [] };
const sales: StaffAccess = { role: 'admin', areas: ['sales', 'support'] };
const viewer: StaffAccess = { role: 'read-only', areas: ['finance'] };

describe('who may do what', () => {
  it('a super admin may do everything', () => {
    for (const area of STAFF_AREAS) expect(can(sup, { area, change: true })).toBe(true);
    expect(can(sup, { superAdmin: true })).toBe(true);
  });

  it('an admin changes only ticked areas, and never super admin work', () => {
    expect(can(sales, { area: 'sales', change: true })).toBe(true);
    expect(can(sales, { area: 'support', change: false })).toBe(true);
    expect(can(sales, { area: 'finance', change: false })).toBe(false);
    expect(can(sales, { superAdmin: true })).toBe(false);
  });

  it('read-only looks at ticked areas and changes nothing', () => {
    expect(can(viewer, { area: 'finance', change: false })).toBe(true);
    expect(can(viewer, { area: 'finance', change: true })).toBe(false);
    expect(can(viewer, { area: 'sales', change: false })).toBe(false);
  });

  it('nobody but a super admin ever gets super admin work (any areas)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('admin', 'read-only' as const),
        fc.subarray([...STAFF_AREAS]),
        (role, areas) => !can({ role, areas }, { superAdmin: true }),
      ),
    );
  });

  it('the money code sees super-admin, or finance for an admin with Finance ticked', () => {
    expect(moneyRole(sup)).toBe('super-admin');
    expect(moneyRole({ role: 'admin', areas: ['finance'] })).toBe('finance');
    expect(moneyRole(viewer)).toBe('read-only');
    expect(moneyRole(sales)).toBe('admin');
  });

  it('checks an access', () => {
    expect(accessProblem(sales)).toBeUndefined();
    expect(accessProblem(sup)).toBeUndefined();
    expect(accessProblem({ role: 'boss', areas: [] })).toBe('unknown role');
    expect(accessProblem({ role: 'admin', areas: [] })).toBe('tick at least one area');
    expect(accessProblem({ role: 'admin', areas: ['sales', 'sales'] })).toBe(
      'an area is ticked twice',
    );
    expect(accessProblem({ role: 'admin', areas: ['money'] })).toBe('unknown area');
    expect(accessProblem({ role: 'admin', areas: 'sales' })).toBe('areas must be a list');
  });
});

describe('sign-in rules', () => {
  it('passwords: long, not the email name, not common', () => {
    expect(passwordProblem('short', 'a@b.in')).toBe('at least 12 characters');
    expect(passwordProblem('prateek-the-founder', 'prateek@recall.in')).toBe(
      'must not contain your email name',
    );
    expect(passwordProblem('Password12345!', 'x@recall.in')).toBe('too easy to guess');
    expect(passwordProblem('aaaaaaaaaaaaab', 'x@recall.in')).toBe('too many repeated characters');
    expect(passwordProblem('green kettle 42 mango', 'x@recall.in')).toBeUndefined();
  });

  it('locks after 5 wrong tries for 15 minutes after the last one', () => {
    const t = 1_000_000;
    const four = [t, t + 1, t + 2, t + 3];
    expect(lockedUntil(four, t + 10)).toBeUndefined();
    const five = [...four, t + 4];
    expect(lockedUntil(five, t + 10)).toBe(t + 4 + R.lockMs);
    expect(lockedUntil(five, t + 4 + R.lockMs)).toBeUndefined();
  });

  it('a session lasts 12 hours at most and 30 minutes idle', () => {
    const t = 5_000_000;
    expect(sessionAlive(t, t, t + R.idleMs - 1)).toBe(true);
    expect(sessionAlive(t, t, t + R.idleMs)).toBe(false);
    expect(sessionAlive(t, t + R.sessionMs - 1000, t + R.sessionMs - 1)).toBe(true);
    expect(sessionAlive(t, t + R.sessionMs - 1000, t + R.sessionMs)).toBe(false);
  });
});

describe('emails as typed', () => {
  it('drops spaces only at the ends; any space inside is refused', () => {
    expect(normalEmail(' Prateek@Recall.in ')).toBe('prateek@recall.in');
    expect(isEmail(normalEmail('prateek @recall.in'))).toBe(false);
    expect(normalEmail('meena@recall.in')).toBe('meena@recall.in');
    // Refused later (isEmail): a space inside a name could stand for a dot.
    expect(normalEmail('ravi kumar@recall.in')).toBe('ravi kumar@recall.in');
  });
});
