// P3.8.2: brand payments (hard rule 4: behind an adapter with a working fake). A payment link is
// made with a key that never changes for the same booking and amount, so asking again (a retry, a
// double click) gives the same link, never a second one. The provider tells us a link was paid by a
// signed message (checked here), and we can also ask it directly.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface LinkRequest {
  /** The same for every attempt of one link. */
  readonly linkKey: string;
  readonly bookingId: string;
  /** Whole paise, more than 0 (GST included). */
  readonly amountPaise: number;
  /** Shown on the payment page. */
  readonly description: string;
  readonly phone?: string;
  readonly email?: string;
  /** UTC seconds: the link stops working then. */
  readonly expiresAt: number;
}

export interface PaymentLink {
  readonly linkId: string;
  readonly url: string;
}

export type LinkStatus =
  | { readonly state: 'created' }
  | {
      readonly state: 'paid';
      readonly paymentId: string;
      /** UTC seconds, by the provider's clock. */
      readonly paidAt: number;
      /** What was really paid, in whole paise (checked against the link: never assumed). */
      readonly amountPaise: number;
    }
  | { readonly state: 'expired' }
  | { readonly state: 'cancelled' };

/** P3.13.2: money sent back to the card, UPI or bank a payment came from. */
export interface RefundRequest {
  /** The same for every attempt of one refund: asking again never refunds twice. */
  readonly refundKey: string;
  /** The provider's id of the payment the money goes back against. */
  readonly paymentId: string;
  /** Whole paise, more than 0; never more than is left of the payment. */
  readonly amountPaise: number;
  readonly note: string;
}

export type RefundResult =
  | { readonly status: 'refunded'; readonly providerRef: string }
  /** Accepted, not settled yet: ask again (same key) later. */
  | { readonly status: 'pending'; readonly providerRef: string }
  /** `retryable`: a passing problem; otherwise it will never go through this way. */
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean };

/** What a provider's signed message says, once its signature is checked. */
export interface PaymentEvent {
  readonly linkId: string;
  readonly status: LinkStatus;
}

export interface PaymentsAdapter {
  createLink(req: LinkRequest): Promise<PaymentLink>;
  status(linkId: string): Promise<LinkStatus>;
  /** Stops a link that is no longer wanted (booking cancelled). Safe to repeat. */
  cancelLink(linkId: string): Promise<void>;
  /** The event in a provider's message, or null when its signature is wrong (never trusted). */
  verifyEvent(rawBody: string, signature: string): PaymentEvent | null;
  /** Sends money back against a payment (P3.13.2). Same key, same answer. */
  refund(req: RefundRequest): Promise<RefundResult>;
}

/**
 * A working fake: links on a fake site, remembered by key; `pay` marks one paid (as a brand paying
 * would) and returns the signed message the provider would send. Time comes from `clock`.
 */
export function fakePayments(
  opts: {
    readonly secret?: string;
    readonly clock?: () => number;
    readonly baseUrl?: string;
    /** Refunds against these payments fail (`times`: only the first n tries). */
    readonly refundFails?: ReadonlyMap<
      string,
      { reason: string; retryable: boolean; times?: number }
    >;
    /** Refunds against these payments are pending once, then refunded. */
    readonly refundPending?: ReadonlySet<string>;
  } = {},
): PaymentsAdapter & {
  readonly links: Map<string, LinkRequest & { linkId: string; status: LinkStatus }>;
  /** Every refund asked for, in order (repeats included). */
  readonly refunds: RefundRequest[];
  /** The brand pays (the full amount, or `amountPaise` to test a wrong payment). */
  pay(linkId: string, amountPaise?: number): { body: string; signature: string };
  sign(body: string): string;
} {
  const secret = opts.secret ?? 'fake-payments-secret';
  const clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  const base = opts.baseUrl ?? 'https://pay.fake.recall.example/l';
  const links = new Map<string, LinkRequest & { linkId: string; status: LinkStatus }>();
  const byKey = new Map<string, string>();
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
  const refunds: RefundRequest[] = [];
  const refundResults = new Map<string, RefundResult>();
  const refundTries = new Map<string, number>();
  const refunded = new Map<string, number>();
  const current = (linkId: string): LinkStatus => {
    const l = links.get(linkId);
    if (!l) throw new Error(`No link ${linkId}`);
    if (l.status.state === 'created' && clock() >= l.expiresAt) l.status = { state: 'expired' };
    return l.status;
  };
  /** The amount a fake payment was for (its link's payment), or 0 if it does not know it. */
  const paidAmount = (paymentId: string) => {
    for (const l of links.values())
      if (l.status.state === 'paid' && l.status.paymentId === paymentId)
        return l.status.amountPaise;
    return 0;
  };
  return {
    links,
    refunds,
    sign,
    refund(req) {
      refunds.push(req);
      const before = refundResults.get(req.refundKey);
      if (before?.status === 'pending') {
        const done: RefundResult = { status: 'refunded', providerRef: before.providerRef };
        refundResults.set(req.refundKey, done);
        return Promise.resolve(done);
      }
      if (before) return Promise.resolve(before);
      if (!Number.isSafeInteger(req.amountPaise) || req.amountPaise <= 0)
        return Promise.reject(new RangeError('amount must be whole paise above 0'));
      const n = refundTries.get(req.refundKey) ?? 0;
      const fail = opts.refundFails?.get(req.paymentId);
      if (fail && n < (fail.times ?? Infinity)) {
        refundTries.set(req.refundKey, n + 1);
        return Promise.resolve({
          status: 'failed',
          reason: fail.reason,
          retryable: fail.retryable,
        });
      }
      const left = paidAmount(req.paymentId) - (refunded.get(req.paymentId) ?? 0);
      if (req.amountPaise > left)
        return Promise.resolve({
          status: 'failed',
          reason: left > 0 ? 'more than is left of the payment' : 'no such payment',
          retryable: false,
        });
      refunded.set(req.paymentId, (refunded.get(req.paymentId) ?? 0) + req.amountPaise);
      const providerRef = `rfnd_fake_${randomBytes(6).toString('hex')}`;
      const result: RefundResult = opts.refundPending?.has(req.paymentId)
        ? { status: 'pending', providerRef }
        : { status: 'refunded', providerRef };
      refundResults.set(req.refundKey, result);
      return Promise.resolve(result);
    },
    createLink(req) {
      if (!Number.isSafeInteger(req.amountPaise) || req.amountPaise <= 0)
        return Promise.reject(new RangeError('amount must be whole paise above 0'));
      const known = byKey.get(req.linkKey);
      // Random, like a real provider's: ids never repeat across restarts.
      const linkId = known ?? `plink_${randomBytes(8).toString('hex')}`;
      if (!known) {
        byKey.set(req.linkKey, linkId);
        links.set(linkId, { ...req, linkId, status: { state: 'created' } });
      }
      return Promise.resolve({ linkId, url: `${base}/${linkId}` });
    },
    status(linkId) {
      // A link it does not know (the fake forgets everything on a restart) has run out.
      if (!links.has(linkId)) return Promise.resolve({ state: 'expired' });
      return Promise.resolve(current(linkId));
    },
    cancelLink(linkId) {
      const l = links.get(linkId);
      if (l && current(linkId).state === 'created') l.status = { state: 'cancelled' };
      return Promise.resolve();
    },
    verifyEvent(rawBody, signature) {
      const want = Buffer.from(sign(rawBody), 'hex');
      const got = Buffer.from(/^[0-9a-f]{64}$/.test(signature) ? signature : '', 'hex');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      try {
        return eventShape(JSON.parse(rawBody));
      } catch {
        return null;
      }
    },
    pay(linkId, amountPaise) {
      const l = links.get(linkId);
      if (!l || current(linkId).state !== 'created')
        throw new Error(`Link ${linkId} cannot be paid`);
      l.status = {
        state: 'paid',
        paymentId: `pay_fake_${linkId.slice(6)}`,
        paidAt: clock(),
        amountPaise: amountPaise ?? l.amountPaise,
      };
      const body = JSON.stringify({ linkId, status: l.status });
      return { body, signature: sign(body) };
    },
  };
}

const whole = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** A provider message's content, checked field by field (even a signed message is not trusted blindly). */
export function eventShape(x: unknown): PaymentEvent | null {
  const e = x as { linkId?: unknown; status?: Record<string, unknown> };
  if (typeof e?.linkId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(e.linkId)) return null;
  const st = e.status;
  switch (st?.state) {
    case 'created':
    case 'expired':
    case 'cancelled':
      return { linkId: e.linkId, status: { state: st.state } };
    case 'paid':
      if (
        typeof st.paymentId !== 'string' ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(st.paymentId) ||
        !whole(st.paidAt) ||
        st.paidAt > 9_999_999_999 || // seconds, never milliseconds
        !whole(st.amountPaise)
      )
        return null;
      return {
        linkId: e.linkId,
        status: {
          state: 'paid',
          paymentId: st.paymentId,
          paidAt: st.paidAt,
          amountPaise: st.amountPaise,
        },
      };
    default:
      return null;
  }
}
