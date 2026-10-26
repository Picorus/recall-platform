// P3.13.3: agencies and aggregators. A super admin gives a cut on a booking (never automatic); cuts
// are earned as plays are delivered (P1.7.4). Each partner gets a monthly statement (its cuts by
// booking, the GST it charges, the TDS held back, what was paid, its invoices) and is paid by a bank
// transfer finance makes and records here, never more than it is owed.
import { partnerPaid, rupees, toCsv } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { indiaMonth } from './money.js';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;
export type PartnerKind = 'agency' | 'aggregator';

const PAYABLE = { agency: 'agency-payable', aggregator: 'aggregator-payable' } as const;
const EXPENSE = { agency: 'agency-cuts', aggregator: 'aggregator-cuts' } as const;
const PARTNER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
/** A brand's (agency's) name now, or the id (an aggregator: "swiggy"). */
const NAME = (col: string) =>
  `coalesce((SELECT v.name FROM brand_versions v WHERE v.brand_id = ${col}
              ORDER BY v.version DESC LIMIT 1), ${col})`;

export interface PartnerRow {
  readonly partnerId: string;
  readonly kind: PartnerKind;
  readonly name: string;
  /** Owed now (after TDS; negative: the partner owes RECALL, after a refund cut it back). */
  readonly owedPaise: number;
  /** Bookings it has a cut on. */
  readonly bookings: number;
}

/** Every partner with a cut, and what each is owed now. */
export async function partners(c: Q): Promise<PartnerRow[]> {
  const r = await c.query<{
    partner_id: string;
    kind: PartnerKind;
    name: string;
    owed: string;
    bookings: string;
  }>(
    `SELECT k.partner_id, k.kind, ${NAME('k.partner_id')} AS name, count(*) AS bookings,
            (SELECT coalesce(sum(p.credit - p.debit), 0) FROM ledger_postings p
              WHERE p.party = k.partner_id
                AND p.account = CASE k.kind WHEN 'agency' THEN 'agency-payable'
                                            ELSE 'aggregator-payable' END) AS owed
       FROM booking_cuts k GROUP BY k.partner_id, k.kind ORDER BY k.kind, k.partner_id`,
  );
  return r.rows.map((x) => ({
    partnerId: x.partner_id,
    kind: x.kind,
    name: x.name,
    owedPaise: Number(x.owed),
    bookings: Number(x.bookings),
  }));
}

export interface PartnerStatement {
  readonly partnerId: string;
  readonly kind: PartnerKind;
  readonly name: string;
  readonly month: string;
  /** Owed at the start of the month. */
  readonly openingPaise: number;
  /** Cuts in the month, by booking (a refund can make one negative). */
  readonly cuts: readonly {
    bookingId: string;
    cutPaise: number;
    gstPaise: number;
    tdsPaise: number;
    /** What it adds to what is owed: cut + GST − TDS. */
    netPaise: number;
  }[];
  readonly payments: readonly { at: number; amountPaise: number; reference: string; by: string }[];
  /** Its invoices dated in the month. */
  readonly invoices: readonly {
    invoiceNo: string;
    invoiceDate: string;
    taxablePaise: number;
    gstPaise: number;
  }[];
  /** Owed at the end of the month. */
  readonly closingPaise: number;
}

/** A partner's statement for a month (India time). */
export async function partnerStatement(
  c: Q,
  partnerId: string,
  kind: PartnerKind,
  month: string,
): Promise<PartnerStatement> {
  if (!PARTNER.test(partnerId)) throw new Refusal('Which partner?');
  const { from, to } = indiaMonth(month);
  const payable = PAYABLE[kind];
  const name = await c.query<{ name: string }>(`SELECT ${NAME('$1::text')} AS name`, [partnerId]);
  const balance = async (before: number) =>
    Number(
      (
        await c.query<{ n: string }>(
          `SELECT coalesce(sum(p.credit - p.debit), 0) AS n
             FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
            WHERE p.account = $1 AND p.party = $2 AND e.at < to_timestamp($3)`,
          [payable, partnerId, before],
        )
      ).rows[0]?.n ?? 0,
    );
  const cuts = await c.query<{ booking_id: string; cut: string; gst: string; tds: string }>(
    `SELECT e.ref AS booking_id,
            coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = $1), 0) AS cut,
            coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = 'gst-input'), 0) AS gst,
            coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'), 0) AS tds
       FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
      WHERE e.kind = $2 AND p.party = $3
        AND e.at >= to_timestamp($4) AND e.at < to_timestamp($5)
      GROUP BY e.ref ORDER BY e.ref`,
    [EXPENSE[kind], `${kind}-cut`, partnerId, from, to],
  );
  const pays = await c.query<{
    at: Date;
    amount: string;
    reference: string;
    by_who: string;
    by_name: string | null;
  }>(
    `SELECT at, amount_paise AS amount, reference, by_who,
            (SELECT name FROM staff WHERE id = by_who) AS by_name
       FROM partner_payments
      WHERE partner_id = $1 AND kind = $2 AND at >= to_timestamp($3) AND at < to_timestamp($4)
      ORDER BY seq`,
    [partnerId, kind, from, to],
  );
  const india = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 10);
  const invoices = await c.query<{
    invoice_no: string;
    invoice_date: string;
    taxable: string;
    gst: string;
  }>(
    `SELECT invoice_no, invoice_date::text AS invoice_date, taxable_paise AS taxable,
            gst_paise AS gst
       FROM partner_invoices
      WHERE partner_id = $1 AND invoice_date >= $2::date AND invoice_date < $3::date
      ORDER BY invoice_date, invoice_no`,
    [partnerId, `${month}-01`, india(to)],
  );
  return {
    partnerId,
    kind,
    name: name.rows[0]?.name ?? partnerId,
    month,
    openingPaise: await balance(from),
    cuts: cuts.rows.map((x) => {
      const cut = Number(x.cut);
      const gst = Number(x.gst);
      const tds = Number(x.tds);
      return {
        bookingId: x.booking_id,
        cutPaise: cut,
        gstPaise: gst,
        tdsPaise: tds,
        netPaise: cut + gst - tds,
      };
    }),
    payments: pays.rows.map((x) => ({
      at: secs(x.at),
      amountPaise: Number(x.amount),
      reference: x.reference,
      by: x.by_name ?? x.by_who,
    })),
    invoices: invoices.rows.map((x) => ({
      invoiceNo: x.invoice_no,
      invoiceDate: x.invoice_date,
      taxablePaise: Number(x.taxable),
      gstPaise: Number(x.gst),
    })),
    closingPaise: await balance(to),
  };
}

/** The statement as a CSV file, to send the partner (amounts in rupees). */
export function statementCsv(s: PartnerStatement): { name: string; csv: string } {
  const rows: (string | number)[][] = [
    ['owed at the start', '', '', '', rupees(s.openingPaise)],
    ...s.cuts.map((x) => [
      `cut on ${x.bookingId}`,
      rupees(x.cutPaise),
      rupees(x.gstPaise),
      rupees(x.tdsPaise),
      rupees(x.netPaise),
    ]),
    ...s.payments.map((p) => [
      `paid ${new Date((p.at + 330 * 60) * 1000).toISOString().slice(0, 10)} (${p.reference})`,
      '',
      '',
      '',
      rupees(-p.amountPaise),
    ]),
    ['owed at the end', '', '', '', rupees(s.closingPaise)],
  ];
  return {
    name: `statement-${s.kind}-${s.partnerId}-${s.month}.csv`,
    csv: toCsv(['item', 'cut before GST', 'GST', 'TDS held back', 'owed'], rows),
  };
}

/**
 * Records a bank transfer finance made to a partner (its reference): never more than the partner
 * is owed now. One at a time per partner.
 */
export async function payPartner(
  pool: Pool,
  p: {
    readonly partnerId: string;
    readonly kind: PartnerKind;
    readonly amountPaise: number;
    readonly reference: string;
    readonly note: string;
  },
  by: { readonly id: string; readonly role: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new Refusal('Only finance or a super admin records a payment to a partner');
  if (!PARTNER.test(p.partnerId)) throw new Refusal('Which partner?');
  if (!Number.isSafeInteger(p.amountPaise) || p.amountPaise <= 0)
    throw new Refusal('The amount: whole paise, more than 0');
  const reference = p.reference.trim();
  if (!/^[A-Za-z0-9/ _-]{4,60}$/.test(reference))
    throw new Refusal('The bank reference (UTR): 4 to 60 letters and digits');
  const note = p.note.trim();
  // eslint-disable-next-line no-control-regex
  if (note.length > 300 || /[\u0000-\u001f\u007f]/.test(note))
    throw new Refusal('The note: up to 300 letters');
  return inTransaction(pool, async (c) => {
    // The same lock as the cuts being brought up to date, so what is owed cannot move meanwhile.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    const owed = await c.query<{ n: string }>(
      `SELECT coalesce(sum(credit - debit), 0) AS n FROM ledger_postings
        WHERE account = $1 AND party = $2`,
      [PAYABLE[p.kind], p.partnerId],
    );
    const due = Number(owed.rows[0]?.n ?? 0);
    if (p.amountPaise > due)
      throw new Refusal(
        `${p.partnerId} is owed ${due > 0 ? `only ₹${rupees(due)}` : 'nothing'}: the payment would be more`,
      );
    const n = await c.query<{ seq: number }>(
      `SELECT coalesce(max(seq), 0) + 1 AS seq FROM partner_payments
        WHERE partner_id = $1 AND kind = $2`,
      [p.partnerId, p.kind],
    );
    const seq = n.rows[0]?.seq ?? 1;
    const entry = partnerPaid({
      partnerId: p.partnerId,
      kind: p.kind,
      seq,
      amount: p.amountPaise,
      reference,
      at: now,
    });
    await postEntry(c, entry, by.id);
    await c.query(
      `INSERT INTO partner_payments
         (partner_id, kind, seq, amount_paise, reference, note, entry_id, by_who, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
      [p.partnerId, p.kind, seq, p.amountPaise, reference, note || null, entry.entryId, by.id, now],
    );
    return seq;
  });
}
