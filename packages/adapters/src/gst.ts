// P5.2: looking up a GST number in the GST records (hard rule 4: behind an adapter with a working
// fake). A brand types its GSTIN on the portal and its legal name, state and address are filled from
// the record, so invoices carry what the tax office has. The real lookup goes through a GST Suvidha
// Provider (P6, open question on the provider); until then production takes what the brand types.

export interface GstRecord {
  readonly gstin: string;
  /** The legal name of the business (as on the registration). */
  readonly legalName: string;
  /** The trade name, when it has one. */
  readonly tradeName: string | null;
  /** The state code (the GSTIN's first two digits). */
  readonly stateCode: string;
  /** The principal place of business, one line. */
  readonly address: string;
  /** Active, or cancelled / suspended (then no invoice can carry it). */
  readonly active: boolean;
}

export type GstLookup =
  | { readonly status: 'found'; readonly record: GstRecord }
  /** No such GSTIN in the records. */
  | { readonly status: 'not-found' }
  /** The lookup service did not answer: try again later, or type the details. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface GstAdapter {
  lookup(gstin: string): Promise<GstLookup>;
}

/**
 * A laptop stand-in. Every well-formed GSTIN is "found" as a test business named from its PAN
 * (characters 3–12), active, at a Hyderabad address; known records can be given; a GSTIN whose PAN
 * starts "ZZZZZ" is not found, "YYYYY" is cancelled and "XXXXX" makes the service fail.
 */
export function fakeGst(known: readonly GstRecord[] = []): GstAdapter & {
  readonly asked: readonly string[];
} {
  const asked: string[] = [];
  return {
    asked,
    lookup(gstin) {
      asked.push(gstin);
      const own = known.find((k) => k.gstin === gstin);
      if (own) return Promise.resolve({ status: 'found', record: own });
      const pan = gstin.slice(2, 12);
      if (pan.startsWith('ZZZZZ')) return Promise.resolve({ status: 'not-found' });
      if (pan.startsWith('XXXXX'))
        return Promise.resolve({ status: 'unavailable', reason: 'fake: the service is down' });
      return Promise.resolve({
        status: 'found',
        record: {
          gstin,
          legalName: `Test Business ${pan} Private Limited`,
          tradeName: `Test ${pan.slice(0, 5)}`,
          stateCode: gstin.slice(0, 2),
          address: 'Plot 1, Hitech City Road, Madhapur, Hyderabad, Telangana 500081',
          active: !pan.startsWith('YYYYY'),
        },
      });
    },
  };
}
