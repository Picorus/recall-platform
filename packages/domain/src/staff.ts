// P3.1: RECALL staff, their roles and what each may do (DECISIONS 22 Oct 2026, Prateek).
//
// - A super admin can do everything, and is the only one who adds staff and sets permissions,
//   changes prices and rules, approves the payout run, decides refunds and discounts, and sees the
//   full audit log.
// - An admin works in the areas a super admin ticked: Sales, Ad review, Operations, Finance, Support.
// - A read-only member (an investor, an auditor) looks at the ticked areas and changes nothing.
//
// Every request is checked against this one table, on the server; the portal only hides buttons.

export const STAFF_AREAS = ['sales', 'ad-review', 'operations', 'finance', 'support'] as const;
export type StaffArea = (typeof STAFF_AREAS)[number];

export const STAFF_ROLES = ['super-admin', 'admin', 'read-only'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffAccess {
  readonly role: StaffRole;
  /** The areas ticked (a super admin has all of them, whatever is ticked). */
  readonly areas: readonly StaffArea[];
}

/** What a request needs: to look at or change an area, or a super admin. */
export type Need =
  { readonly area: StaffArea; readonly change: boolean } | { readonly superAdmin: true };

export function can(who: StaffAccess, need: Need): boolean {
  if (who.role === 'super-admin') return true;
  if ('superAdmin' in need) return false;
  if (!who.areas.includes(need.area)) return false;
  return need.change ? who.role === 'admin' : true;
}

/**
 * The role the money code checks (`by.role` in packages/db: 'super-admin', or 'finance' for an
 * admin with Finance ticked), so those checks keep working with staff sign-in.
 */
export function moneyRole(who: StaffAccess): string {
  if (who.role === 'super-admin') return 'super-admin';
  if (who.role === 'admin' && who.areas.includes('finance')) return 'finance';
  return who.role;
}

/** What is wrong with an access, or undefined. */
export function accessProblem(x: unknown): string | undefined {
  if (typeof x !== 'object' || x === null) return 'not an access';
  const a = x as Record<string, unknown>;
  if (!(STAFF_ROLES as readonly unknown[]).includes(a.role)) return 'unknown role';
  if (!Array.isArray(a.areas)) return 'areas must be a list';
  if (!a.areas.every((v) => (STAFF_AREAS as readonly unknown[]).includes(v))) return 'unknown area';
  if (new Set(a.areas).size !== a.areas.length) return 'an area is ticked twice';
  if (a.role !== 'super-admin' && a.areas.length === 0) return 'tick at least one area';
  return undefined;
}

// ---------------------------------------------------------------- sign-in rules

export interface SignInRules {
  /** Wrong tries in a row before the account waits. */
  readonly maxFailures: number;
  /** How long it waits after the last wrong try (ms). */
  readonly lockMs: number;
  /** A session ends this long after sign-in, whatever happens (ms). */
  readonly sessionMs: number;
  /** A session ends after this long without use (ms). */
  readonly idleMs: number;
  /** An invite to set a password and the two-step code expires after this (ms). */
  readonly inviteMs: number;
  /**
   * Right password, wrong code, from anywhere, before the account stops until a super admin resets
   * it: the password is known to someone, so the code is all that is left to guess.
   */
  readonly maxCodeFailures: number;
}

export const DEFAULT_SIGN_IN_RULES: SignInRules = {
  maxFailures: 5,
  lockMs: 15 * 60_000,
  sessionMs: 12 * 3_600_000,
  idleMs: 30 * 60_000,
  inviteMs: 48 * 3_600_000,
  maxCodeFailures: 10,
};

/** Emails are compared in lower case, without spaces around. */
export function normalEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Passwords anyone would try first; a longer list can come later from a setting. */
const COMMON = [
  'password',
  'recall',
  'qwerty',
  '123456',
  'letmein',
  'welcome',
  'admin',
  'hyderabad',
  'iloveyou',
];

/** What is wrong with a new password, or undefined. */
export function passwordProblem(password: string, email: string): string | undefined {
  if (password.length < 12) return 'at least 12 characters';
  if (password.length > 200) return 'at most 200 characters';
  const low = password.toLowerCase();
  const name = normalEmail(email).split('@')[0] ?? '';
  if (name.length >= 3 && low.includes(name)) return 'must not contain your email name';
  if (new Set(low).size < 5) return 'too many repeated characters';
  if (COMMON.some((w) => low.replace(/[^a-z0-9]/g, '').startsWith(w))) return 'too easy to guess';
  return undefined;
}

/**
 * Whether the account must wait: `failures` are the times (ms) of wrong tries since the last
 * successful sign-in, oldest first. Returns until when it waits, or undefined.
 */
export function lockedUntil(
  failures: readonly number[],
  nowMs: number,
  rules: SignInRules = DEFAULT_SIGN_IN_RULES,
): number | undefined {
  if (failures.length < rules.maxFailures) return undefined;
  const last = failures[failures.length - 1] ?? 0;
  const until = last + rules.lockMs;
  return until > nowMs ? until : undefined;
}

/** Whether a session is still good: not past its whole life and not idle too long. */
export function sessionAlive(
  startedMs: number,
  lastSeenMs: number,
  nowMs: number,
  rules: SignInRules = DEFAULT_SIGN_IN_RULES,
): boolean {
  return nowMs < startedMs + rules.sessionMs && nowMs < lastSeenMs + rules.idleMs;
}
