// P1.7.7: paying riders (hard rule 4: behind an adapter with a working fake). A payout is sent with
// a key that never changes for the same payout, so sending it again (a retry, a crash after
// sending) never pays twice: the provider answers with what happened the first time.

/** Where a rider is paid. */
export type PayoutDestination =
  | {
      readonly kind: 'bank';
      readonly accountNumber: string;
      readonly ifsc: string;
      readonly name: string;
    }
  | { readonly kind: 'upi'; readonly vpa: string; readonly name: string };

export interface PayoutRequest {
  /** The same for every attempt of one payout. */
  readonly payoutKey: string;
  readonly riderId: string;
  /** Whole paise, more than 0. */
  readonly amountPaise: number;
  readonly to: PayoutDestination;
}

export type PayoutResult =
  | { readonly status: 'paid'; readonly providerRef: string }
  /** Sent, not settled yet: ask again later. */
  | { readonly status: 'pending'; readonly providerRef: string }
  /** `retryable`: a passing problem (bank down); otherwise the details are wrong. */
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean };

export interface PayoutsAdapter {
  send(req: PayoutRequest): Promise<PayoutResult>;
}

/**
 * A working fake: pays at once, remembers each key (a repeat gets the first answer, even when the
 * amount differs, like a real provider's idempotency key), and fails where told to (`failFor`:
 * rider id → failure). A pending payout settles on the next call with its key.
 */
export function fakePayouts(
  opts: {
    readonly failFor?: ReadonlyMap<string, { reason: string; retryable: boolean; times?: number }>;
    readonly pendingFor?: ReadonlySet<string>;
  } = {},
): PayoutsAdapter & { readonly sent: PayoutRequest[] } {
  const results = new Map<string, PayoutResult>();
  const failures = new Map<string, number>();
  const sent: PayoutRequest[] = [];
  return {
    sent,
    send(req) {
      sent.push(req);
      const before = results.get(req.payoutKey);
      if (before?.status === 'pending') {
        const paid: PayoutResult = { status: 'paid', providerRef: before.providerRef };
        results.set(req.payoutKey, paid);
        return Promise.resolve(paid);
      }
      if (before) return Promise.resolve(before);
      const fail = opts.failFor?.get(req.riderId);
      const n = failures.get(req.payoutKey) ?? 0;
      if (fail && n < (fail.times ?? Number.POSITIVE_INFINITY)) {
        failures.set(req.payoutKey, n + 1);
        return Promise.resolve({
          status: 'failed',
          reason: fail.reason,
          retryable: fail.retryable,
        });
      }
      const providerRef = `fake-${results.size + 1}`;
      const result: PayoutResult = opts.pendingFor?.has(req.riderId)
        ? { status: 'pending', providerRef }
        : { status: 'paid', providerRef };
      results.set(req.payoutKey, result);
      return Promise.resolve(result);
    },
  };
}
