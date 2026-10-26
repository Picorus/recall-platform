// The Brands page: finding an account and naming a booking's step in words.

export interface AccountRow {
  readonly brandId: string;
  readonly kind: 'brand' | 'agency';
  readonly version: number;
  readonly name: string;
  readonly agencyId: string | null;
  readonly referredBy: string | null;
  readonly active: boolean;
  readonly agencyName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly bookings: number;
  readonly lastFirstHour: number | null;
}

/** Whether an account matches what was typed in the search box (name, id, phone, email, GSTIN). */
export function matches(a: AccountRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const digits = q.replace(/\D/g, '');
  return (
    [a.name, a.brandId, a.email ?? '', a.gstin ?? '', a.agencyName ?? ''].some((x) =>
      x.toLowerCase().includes(q),
    ) ||
    (digits.length >= 4 && (a.phone ?? '').includes(digits))
  );
}

export const STEP_NAMES: Record<string, string> = {
  draft: 'Draft',
  'awaiting-payment': 'Awaiting payment',
  paid: 'Paid',
  'ads-approved': 'Ads approved',
  running: 'Running',
  done: 'Done',
  'report-sent': 'Report sent',
  cancelled: 'Cancelled',
  'ads-missing': 'Ads missing',
};

/** "+91 98765 43210" from "+919876543210". */
export function phoneText(p: string | null): string {
  if (!p) return '—';
  const m = /^\+91(\d{5})(\d{5})$/.exec(p);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

/** A suggested id from a name: "Chai Co (Hitech City)" → "chai-co-hitech-city". */
export function idFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}
