// Words shown for roles and areas (the API's names stay the same everywhere).

export const ROLES = ['super-admin', 'admin', 'read-only'] as const;
export type Role = (typeof ROLES)[number];
export const AREAS = ['sales', 'ad-review', 'operations', 'finance', 'support'] as const;
export type Area = (typeof AREAS)[number];

export const ROLE_NAMES: Record<Role, string> = {
  'super-admin': 'Super admin',
  admin: 'Admin',
  'read-only': 'Read-only',
};

export const AREA_NAMES: Record<Area, string> = {
  sales: 'Sales',
  'ad-review': 'Ad review',
  operations: 'Operations',
  finance: 'Finance',
  support: 'Support',
};

/** "Admin · Sales, Support", "Super admin", "Read-only · Finance". */
export function accessText(role: Role, areas: readonly Area[]): string {
  if (role === 'super-admin') return ROLE_NAMES[role];
  const ticked = AREAS.filter((a) => areas.includes(a)).map((a) => AREA_NAMES[a]);
  return `${ROLE_NAMES[role]} · ${ticked.join(', ')}`;
}

/** What is wrong with the form's access, or undefined (the API checks again). */
export function formProblem(role: Role, areas: readonly Area[]): string | undefined {
  if (role !== 'super-admin' && areas.length === 0) return 'Tick at least one area.';
  return undefined;
}
