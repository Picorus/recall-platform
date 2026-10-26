// P3.11.2: the outside checks on a rider (hard rule 4: behind adapters, each with a working fake):
// - identity (KYC): Aadhaar through DigiLocker and PAN, through a KYC provider (Signzy, IDfy,
//   HyperVerge): the rider opens a link on his phone; we keep only the result, the name on his
//   ID and the last 4 characters of the ID (never the number itself: DPDP Act);
// - the rider agreement, signed on his phone (Aadhaar e-sign through Digio, Leegality);
// - his bank account or UPI id, checked with a ₹1 test deposit ("penny drop"), which returns the
//   name the bank holds.
// The real providers come with their contracts (P4); until then a laptop uses the fakes.
import { randomBytes } from 'node:crypto';
import type { PayoutDestination } from './payouts.js';

export interface CheckStart {
  /** The provider's id for this check (we ask about it with `status`). */
  readonly ref: string;
  /** Where the rider does it, on his phone. */
  readonly link: string;
}

export type KycStatus =
  | { readonly state: 'pending' }
  | {
      readonly state: 'verified';
      /** The name on his ID (to compare with the name he gave). */
      readonly nameOnId: string;
      /** The last 4 characters of the ID checked: never more. */
      readonly idLast4: string;
    }
  | { readonly state: 'failed'; readonly reason: string };

export interface KycAdapter {
  start(r: {
    readonly riderId: string;
    readonly name: string;
    readonly phone: string;
  }): Promise<CheckStart>;
  status(ref: string): Promise<KycStatus>;
}

export type SignStatus =
  | { readonly state: 'pending' }
  | {
      readonly state: 'signed';
      /** UTC seconds. */
      readonly signedAt: number;
      /** Who signed, as the e-sign provider confirmed it (Aadhaar e-sign gives the name). */
      readonly signerName: string;
    }
  | { readonly state: 'declined'; readonly reason: string };

export interface EsignAdapter {
  send(r: {
    readonly riderId: string;
    readonly name: string;
    readonly phone: string;
    /** Which agreement text ("rider-v1"): kept with the signature. */
    readonly agreement: string;
  }): Promise<CheckStart>;
  status(ref: string): Promise<SignStatus>;
}

export type BankCheck =
  | {
      readonly state: 'passed';
      readonly ref: string;
      /** The name the bank holds. */ readonly nameAtBank: string;
    }
  | { readonly state: 'failed'; readonly ref: string; readonly reason: string };

export interface BankCheckAdapter {
  /** A ₹1 test deposit to the account: does it exist, and in whose name. */
  check(to: PayoutDestination): Promise<BankCheck>;
}

const newRef = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

/**
 * A working fake identity check. `auto`: each check verifies at once with the name given and a
 * made-up last 4 (a laptop demo); otherwise it stays pending until `finish` (tests).
 */
export function fakeKyc(
  opts: { readonly auto?: boolean; readonly baseUrl?: string } = {},
): KycAdapter & { finish(ref: string, s: KycStatus): void } {
  const checks = new Map<string, KycStatus>();
  return {
    start(r) {
      const ref = newRef('kyc');
      checks.set(
        ref,
        opts.auto
          ? {
              state: 'verified',
              nameOnId: r.name.toUpperCase(),
              idLast4: String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0'),
            }
          : { state: 'pending' },
      );
      return Promise.resolve({ ref, link: `${opts.baseUrl ?? 'https://kyc.example'}/${ref}` });
    },
    status(ref) {
      return Promise.resolve(checks.get(ref) ?? { state: 'failed', reason: 'unknown check' });
    },
    finish(ref, s) {
      checks.set(ref, s);
    },
  };
}

/** A working fake e-sign. `auto`: signed at once (`clock` gives the time); otherwise `finish`. */
export function fakeEsign(
  opts: { readonly auto?: boolean; readonly baseUrl?: string; readonly clock?: () => number } = {},
): EsignAdapter & { finish(ref: string, s: SignStatus): void } {
  const signs = new Map<string, SignStatus>();
  const now = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  return {
    send(r) {
      const ref = newRef('sign');
      signs.set(
        ref,
        opts.auto
          ? { state: 'signed', signedAt: now(), signerName: r.name.toUpperCase() }
          : { state: 'pending' },
      );
      return Promise.resolve({ ref, link: `${opts.baseUrl ?? 'https://sign.example'}/${ref}` });
    },
    status(ref) {
      return Promise.resolve(signs.get(ref) ?? { state: 'declined', reason: 'unknown request' });
    },
    finish(ref, s) {
      signs.set(ref, s);
    },
  };
}

/** A working fake bank check: passes with the name given, unless the account is in `failFor`. */
export function fakeBankCheck(
  opts: { readonly failFor?: ReadonlyMap<string, string> } = {},
): BankCheckAdapter & { readonly checked: PayoutDestination[] } {
  const checked: PayoutDestination[] = [];
  return {
    checked,
    check(to) {
      checked.push(to);
      const id = to.kind === 'bank' ? to.accountNumber : to.vpa;
      const reason = opts.failFor?.get(id);
      return Promise.resolve(
        reason
          ? { state: 'failed', ref: newRef('pd'), reason }
          : { state: 'passed', ref: newRef('pd'), nameAtBank: to.name.toUpperCase() },
      );
    },
  };
}
