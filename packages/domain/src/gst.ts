// P1.7.9: GST and the books. Tax invoices and credit notes numbered in one unbroken series per
// financial year (April–March), GST split into CGST + SGST (brand in the same state as RECALL) or
// IGST (another state), and plain-text exports for the accountant. Brands always pay GST on top.

/** Financial year of an India date ("YYYY-MM-DD"): "2027-28" for April 2027 to March 2028. */
export function financialYearOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A document number, at most 16 characters as GST requires: "RC/27-28/000123", "CN/27-28/000004". */
export function docNumber(kind: 'invoice' | 'credit-note', fy: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 999_999)
    throw new RangeError('Number must be 1–999,999');
  return `${kind === 'invoice' ? 'RC' : 'CN'}/${fy.slice(2)}/${String(n).padStart(6, '0')}`;
}

/** Checks a GSTIN's shape and check digit; empty when it is valid. */
export function gstinProblems(gstin: string): string[] {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))
    return ['GSTIN must look like 36ABCDE1234F1Z5'];
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const v = chars.indexOf(gstin[i] ?? '') * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  const check = chars[(36 - (sum % 36)) % 36];
  return gstin[14] === check ? [] : ['GSTIN check digit is wrong'];
}

export interface GstSplit {
  readonly cgst: number;
  readonly sgst: number;
  readonly igst: number;
}

/**
 * The GST on a document split by where the brand is: the same state as RECALL → half CGST, half
 * SGST (the odd paisa to SGST); another state → all IGST.
 */
export function splitGst(gst: number, supplierState: string, placeOfSupply: string): GstSplit {
  if (!Number.isSafeInteger(gst) || gst < 0) throw new RangeError('GST must be whole paise');
  if (supplierState !== placeOfSupply) return { cgst: 0, sgst: 0, igst: gst };
  const cgst = Math.floor(gst / 2);
  return { cgst, sgst: gst - cgst, igst: 0 };
}

/** One CSV field, quoted when needed (commas, quotes, new lines). */
const field = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  // A leading = + - @ (or tab / carriage return) would make a spreadsheet run it as a formula:
  // written as text instead.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** A CSV file: a header row and the rows, each row a line. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return [header, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
}

/** Paise as rupees with two decimals, for the accountant's files ("1234.50"). */
export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const a = Math.abs(paise);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** P5.8: a tax invoice or credit note as printed (and listed on the brand portal). */
export interface TaxDocument {
  readonly docNo: string;
  readonly kind: 'invoice' | 'credit-note';
  /** UTC seconds. */
  readonly issuedAt: number;
  /** For a credit note: the invoice it reduces. */
  readonly againstDoc: string | null;
  readonly bookingId: string;
  readonly brandId: string;
  /** Billed to. */
  readonly legalName: string;
  /** The brand's GST number, when it is safe to print (P5.8); else null. */
  readonly gstin: string | null;
  /** The brand's GST number was held back (typed and not checked, or on two accounts). */
  readonly gstinHeld: boolean;
  /** State code of the place of supply ("36"). */
  readonly placeOfSupply: string;
  readonly sac: string;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly totalPaise: number;
  /** The GST rate the tax was worked out at (the booking's price book; a credit note: its
   * invoice's), in basis points. */
  readonly gstBp: number;
  /** The brand's address on its tax details when issued ("" when none). */
  readonly recipientAddress: string;
  /** RECALL's details and state as they were when issued (empty before registration: then it is
   * never a valid tax invoice). */
  readonly supplier: {
    readonly legalName: string;
    readonly gstin: string;
    readonly address: string;
  };
  readonly supplierState: string;
  /** What was sold: the booking's bike-hours and India days ("YYYY-MM-DD"). */
  readonly bikeHours: number;
  readonly firstDay: string;
  readonly lastDay: string;
}
