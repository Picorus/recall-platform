import { STAFF_AREAS, STAFF_ROLES } from '@recall/domain';
import { describe, expect, it } from 'vitest';
import { accessText, AREAS, formProblem, ROLES } from '../../lib/staff';

describe('roles and areas on the admin site', () => {
  it('are the same as the rules the API checks', () => {
    expect([...ROLES]).toEqual([...STAFF_ROLES]);
    expect([...AREAS]).toEqual([...STAFF_AREAS]);
  });

  it('read as words, areas in a fixed order', () => {
    expect(accessText('super-admin', [])).toBe('Super admin');
    expect(accessText('admin', ['support', 'sales'])).toBe('Admin · Sales, Support');
    expect(accessText('read-only', ['finance'])).toBe('Read-only · Finance');
  });

  it('an admin or read-only member needs an area', () => {
    expect(formProblem('admin', [])).toBe('Tick at least one area.');
    expect(formProblem('read-only', ['finance'])).toBeUndefined();
    expect(formProblem('super-admin', [])).toBeUndefined();
  });
});
