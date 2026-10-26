// P3.13.1: money as finance sees it, read-only. A month's payments received (from the payment
// provider's messages), its tax invoices and credit notes, where money stands now (held for
// campaigns, owed back to brands, to partners, to riders), and provider messages for links we do
// not know. Nothing here moves money.
import type { PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/** A month "YYYY-MM" in India time, as UTC seconds [from, to). */
export function indiaMonth(month: string): { from: number; to: number } {
  const m = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new RangeError('Month must be YYYY-MM');
  const y = Number(m[1]);
  const mm = Number(m[2]);
  const ist = 330 * 60;
  return { from: Date.UTC(y, mm - 1, 1) / 1000 - ist, to: Date.UTC(y, mm, 1) / 1000 - ist };
}

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
/** A brand's name now (its latest version), or its id. */
const BRAND_NAME = (col: string) =>
  `coalesce((SELECT v.name FROM brand_versions v WHERE v.brand_id = ${col}
              ORDER BY v.version DESC LIMIT 1), ${col})`;

export interface PaymentIn {
  readonly paymentId: string;
  readonly at: number;
  readonly bookingId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly amountPaise: number;
  /** paid; paid-late (after the booking was cancelled) or wrong-amount: owed back. */
  readonly state: 'paid' | 'paid-late' | 'wrong-amount';
}

/** Payments received in a month (India time), newest first (at most 500; `truncated` if more). */
export async function paymentsIn(
  c: Q,
  month: string,
): Promise<{ payments: PaymentIn[]; truncated: boolean }> {
  const { from, to } = indiaMonth(month);
  const r = await c.query<{
    payment_id: string;
    at: Date;
    booking_id: string;
    brand_id: string;
    brand_name: string;
    amount: string;
    state: PaymentIn['state'];
  }>(
    `SELECT e.payment_id, e.at, l.booking_id, b.brand_id, ${BRAND_NAME('b.brand_id')} AS brand_name,
            coalesce(e.amount_paise, l.amount_paise) AS amount, e.state
       FROM payment_link_events e
       JOIN payment_links l USING (link_id)
       JOIN bookings b ON b.booking_id = l.booking_id
      WHERE e.payment_id IS NOT NULL
        AND e.at >= to_timestamp($1) AND e.at < to_timestamp($2)
      ORDER BY e.at DESC, e.id DESC LIMIT 501`,
    [from, to],
  );
  return {
    payments: r.rows.slice(0, 500).map((x) => ({
      paymentId: x.payment_id,
      at: secs(x.at),
      bookingId: x.booking_id,
      brandId: x.brand_id,
      brandName: x.brand_name,
      amountPaise: Number(x.amount),
      state: x.state,
    })),
    truncated: r.rows.length > 500,
  };
}

export interface GstDocumentRow {
  readonly docNo: string;
  readonly kind: 'invoice' | 'credit-note';
  readonly issuedAt: number;
  readonly againstDoc: string | null;
  readonly bookingId: string;
  readonly brandId: string;
  readonly legalName: string;
  readonly gstin: string | null;
  readonly taxablePaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
}

/** Tax invoices and credit notes issued in a month, in number order (at most 1,000). */
export async function gstDocuments(
  c: Q,
  month: string,
): Promise<{ documents: GstDocumentRow[]; truncated: boolean }> {
  const { from, to } = indiaMonth(month);
  const r = await c.query<{
    doc_no: string;
    kind: GstDocumentRow['kind'];
    issued_at: Date;
    against_doc: string | null;
    booking_id: string;
    brand_id: string;
    legal_name: string;
    gstin: string | null;
    taxable: string;
    gst: string;
    total: string;
  }>(
    `SELECT doc_no, kind, issued_at, against_doc, booking_id, brand_id, legal_name, gstin,
            taxable_paise AS taxable, cgst_paise + sgst_paise + igst_paise AS gst,
            total_paise AS total
       FROM gst_documents WHERE issued_at >= to_timestamp($1) AND issued_at < to_timestamp($2)
      ORDER BY kind DESC, n LIMIT 1001`,
    [from, to],
  );
  return {
    documents: r.rows.slice(0, 1000).map((d) => ({
      docNo: d.doc_no,
      kind: d.kind,
      issuedAt: secs(d.issued_at),
      againstDoc: d.against_doc,
      bookingId: d.booking_id,
      brandId: d.brand_id,
      legalName: d.legal_name,
      gstin: d.gstin,
      taxablePaise: Number(d.taxable),
      gstPaise: Number(d.gst),
      totalPaise: Number(d.total),
    })),
    truncated: r.rows.length > 1000,
  };
}

export interface MoneyPosition {
  /** Paid by brands for campaigns not yet delivered (before GST). */
  readonly heldForCampaignsPaise: number;
  /** Owed back to brands (refunds approved, payments after a cancellation or of a wrong amount). */
  readonly owedBack: readonly { brandId: string | null; brandName: string; paise: number }[];
  /** Cuts owed to agencies and to aggregators (after TDS). */
  readonly owedToAgenciesPaise: number;
  readonly owedToAggregatorsPaise: number;
  /** Rider pay owed (after TDS), paid in the Monday runs. */
  readonly owedToRidersPaise: number;
  /** TDS held back, to deposit with the government. */
  readonly tdsPaise: number;
  /** GST collected less credit notes and input credit booked, not yet paid to the government. */
  readonly gstPaise: number;
}

/** Where money stands now, from the ledger's balances. */
export async function moneyPosition(c: Q): Promise<MoneyPosition> {
  const r = await c.query<{ account: string; balance: string }>(
    `SELECT account, sum(credit - debit) AS balance FROM ledger_postings
      WHERE account IN ('campaign-held', 'agency-payable', 'aggregator-payable', 'rider-payable',
                        'tds-payable', 'gst-payable', 'gst-input')
      GROUP BY account`,
  );
  const bal = (a: string) => Number(r.rows.find((x) => x.account === a)?.balance ?? 0);
  const back = await c.query<{ party: string | null; name: string | null; paise: string }>(
    `SELECT party, ${BRAND_NAME('party')} AS name, sum(credit - debit) AS paise
       FROM ledger_postings WHERE account = 'refunds-payable'
      GROUP BY party HAVING sum(credit - debit) <> 0 ORDER BY party NULLS LAST`,
  );
  return {
    heldForCampaignsPaise: bal('campaign-held'),
    // A payment for a link we have no record of has no brand: listed as "brand not known".
    owedBack: back.rows.map((x) => ({
      brandId: x.party,
      brandName: x.name ?? 'brand not known',
      paise: Number(x.paise),
    })),
    owedToAgenciesPaise: bal('agency-payable'),
    owedToAggregatorsPaise: bal('aggregator-payable'),
    owedToRidersPaise: bal('rider-payable'),
    tdsPaise: bal('tds-payable'),
    // gst-input is an asset (debit balance): its credit-minus-debit is negative.
    gstPaise: bal('gst-payable') + bal('gst-input'),
  };
}

/** Provider messages about payment links we have no record of (newest first, at most 100). */
export async function unknownPayments(
  c: Q,
): Promise<{ linkId: string; paymentId: string | null; receivedAt: number }[]> {
  const r = await c.query<{ link_id: string; payment_id: string | null; received_at: Date }>(
    `SELECT link_id, payment_id, received_at FROM payment_inbox ORDER BY id DESC LIMIT 100`,
  );
  return r.rows.map((x) => ({
    linkId: x.link_id,
    paymentId: x.payment_id,
    receivedAt: secs(x.received_at),
  }));
}
