// P3.8.1: brand and agency accounts. A brand is who an ad campaign is for; an agency books for
// brands (one agency, many brands). A brand may name the agency that handles it and the delivery
// or ride app that referred it (for cuts, never automatic: P1.7.4). Details change as versions.

export type AccountKind = 'brand' | 'agency';

/** Account ids: lower case letters, digits and dashes, e.g. "chai-co". */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AccountDetails {
  readonly name: string;
  /** The agency that handles this brand (brands only). */
  readonly agencyId: string | null;
  /** The delivery or ride app that referred this brand, if any. */
  readonly referredBy: string | null;
  readonly active: boolean;
}

/**
 * What is wrong with an account's details, in words; empty when they can be saved. `agencyKind`
 * is the kind of the account named as agency (undefined when no such account exists).
 */
export function accountProblems(
  id: string,
  kind: AccountKind,
  d: AccountDetails,
  agencyKind: AccountKind | undefined,
): string[] {
  const problems: string[] = [];
  if (!ACCOUNT_ID.test(id)) problems.push('id: lower case letters, digits and dashes');
  const name = d.name.trim();
  if (name.length < 2 || name.length > 120) problems.push('name: 2 to 120 characters');
  if (d.agencyId !== null) {
    if (kind === 'agency') problems.push('an agency is not handled by another agency');
    else if (d.agencyId === id) problems.push('a brand cannot be its own agency');
    else if (agencyKind === undefined) problems.push(`no account ${d.agencyId}`);
    else if (agencyKind !== 'agency') problems.push(`${d.agencyId} is a brand, not an agency`);
  }
  if (d.referredBy !== null && !ACCOUNT_ID.test(d.referredBy))
    problems.push('referred by: lower case letters, digits and dashes');
  return problems;
}
