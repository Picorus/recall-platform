// P4.2: joining RECALL on the rider app. A new number signs up (a rider record made by "rider app",
// or the one staff already made for that number); then the join page shows each of the six steps
// as the rider sees them: to do, being checked, done, or to do again. What each step needs is the
// same approval checklist staff use (packages/domain/src/riders.ts); the app only shows it.
import {
  approvalChecklist,
  plateOf,
  RIDER_APPS,
  type CheckFact,
  type RiderApp,
  type RiderDetails,
  type RiderDocumentKind,
  type RiderFacts,
} from '@recall/domain';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { riderForPhone, type RiderSession } from './rider-sign-in.js';
import { createRider, reviseRider, riderFacts } from './riders.js';

/** Who the rider app writes as, in every record it makes. */
export const RIDER_APP = 'rider app';

/** Where one step stands for the rider. */
export type StepState = 'todo' | 'waiting' | 'done' | 'again';

export interface JoinPage {
  readonly riderId: string;
  readonly status: RiderFacts['status'];
  readonly details: RiderDetails;
  /** The steps he can still change: while his application is open. */
  readonly canChange: boolean;
  readonly documents: Readonly<
    Record<RiderDocumentKind, { readonly state: StepState; readonly expiresOn: string | null }>
  >;
  readonly identity: { readonly state: StepState; readonly reason: string | null };
  readonly bank: { readonly state: StepState; readonly reason: string | null };
  readonly agreement: { readonly state: StepState; readonly reason: string | null };
  /** Each of the six steps (profile, vehicle, ID, bank, agreement, loan), in order. */
  readonly steps: readonly { readonly step: JoinStep; readonly state: StepState | 'later' }[];
}

export const JOIN_STEPS = ['profile', 'vehicle', 'identity', 'bank', 'agreement', 'loan'] as const;
export type JoinStep = (typeof JOIN_STEPS)[number];

/** The details as the app sends them (the phone is always the signed-in number). */
export function appDetails(
  b: Readonly<Record<string, unknown>>,
  phone: string,
): RiderDetails | null {
  const apps = Array.isArray(b.apps) ? b.apps : [];
  if (typeof b.name !== 'string' || typeof b.rides !== 'string') return null;
  if (!apps.every((a): a is RiderApp => (RIDER_APPS as readonly unknown[]).includes(a)))
    return null;
  const plate = b.bikePlate;
  if (plate !== null && plate !== undefined && typeof plate !== 'string') return null;
  return {
    name: b.name.trim(),
    phone,
    // In one form ("TS 09 EA 1234" → "TS09EA1234"); left as typed if it is not a plate (refused).
    bikePlate: typeof plate === 'string' && plate.trim() ? (plateOf(plate) ?? plate) : null,
    rides: b.rides.trim(),
    apps,
  };
}

/**
 * A new number signs up: his record is made (applied) and his session joined to it. If staff had
 * already added a rider with this number (a walk-in), the session joins that record instead. Only a
 * session with no rider can sign up, once.
 */
export async function joinAsRider(
  pool: Pool,
  session: RiderSession,
  details: RiderDetails,
  now: number,
): Promise<string> {
  if (session.riderId !== null) throw new Refusal('You have signed up already');
  if (details.phone !== session.phone)
    throw new Refusal('The phone must be the one you signed in with');
  const existing = await riderForPhone(pool, session.phone);
  const facts = existing ? await riderFacts(pool, existing, now) : undefined;
  const riderId =
    existing && facts && !['left', 'rejected'].includes(facts.status)
      ? existing
      : await createRider(
          pool,
          { details, channel: 'app', by: RIDER_APP, reason: 'signed up on the rider app' },
          now,
        );
  await inTransaction(pool, async (c) => {
    const r = await c.query(
      `INSERT INTO rider_session_joins (token_hash, rider_id, at)
       VALUES ($1, $2, to_timestamp($3)) ON CONFLICT DO NOTHING`,
      [session.tokenHash, riderId, now],
    );
    if ((r.rowCount ?? 0) === 0) throw new Refusal('You have signed up already');
  });
  return riderId;
}

/** He changes his own details while his application is open (his phone stays the signed-in one). */
export async function changeOwnDetails(
  pool: Pool,
  riderId: string,
  details: RiderDetails,
  now: number,
): Promise<void> {
  const f = await riderFacts(pool, riderId, now);
  if (!f) throw new Refusal(`No rider ${riderId}`);
  if (f.status !== 'applied')
    throw new Refusal('Your application is decided: call support to change your details');
  if (details.phone !== f.details.phone)
    throw new Refusal('Your mobile number is changed by support');
  await reviseRider(pool, riderId, details, RIDER_APP, 'changed on the rider app', now);
}

const checkState = (c: CheckFact, done: boolean): StepState =>
  !c ? 'todo' : c.state === 'pending' ? 'waiting' : done ? 'done' : 'again';

/** Worst first: a step is only as far as its least finished part. */
const worst = (...s: StepState[]): StepState =>
  s.includes('again')
    ? 'again'
    : s.includes('todo')
      ? 'todo'
      : s.includes('waiting')
        ? 'waiting'
        : 'done';

/** The join page: each step's state for the rider. */
export async function joinPage(pool: Pool, riderId: string, now: number): Promise<JoinPage> {
  const f = await riderFacts(pool, riderId, now);
  if (!f) throw new Refusal(`No rider ${riderId}`);
  const list = approvalChecklist(f, now);
  const doneOf = (item: string) => list.find((x) => x.item === item)?.done ?? false;
  const doc = (kind: RiderDocumentKind) => {
    const d = f.documents.find((x) => x.kind === kind);
    const item = { photo: 'Photo', rc: 'Registration (RC)', insurance: 'Insurance' }[kind];
    const state: StepState = !d
      ? 'todo'
      : d.decision === null
        ? 'waiting'
        : doneOf(item)
          ? 'done'
          : 'again';
    return { state, expiresOn: d?.expiresOn ?? null };
  };
  const documents = { photo: doc('photo'), rc: doc('rc'), insurance: doc('insurance') };
  const identity = {
    state: checkState(f.identity, doneOf('Identity (KYC)')),
    reason: f.identity?.reason ?? null,
  };
  const bank = { state: checkState(f.bank, doneOf('Bank or UPI')), reason: f.bank?.reason ?? null };
  const agreement = {
    state: checkState(f.agreement, doneOf('Agreement')),
    reason: f.agreement?.reason ?? null,
  };
  const plate: StepState = f.details.bikePlate ? 'done' : 'todo';
  const steps = [
    { step: 'profile' as const, state: documents.photo.state },
    {
      step: 'vehicle' as const,
      state: worst(plate, documents.rc.state, documents.insurance.state),
    },
    { step: 'identity' as const, state: identity.state },
    { step: 'bank' as const, state: bank.state },
    { step: 'agreement' as const, state: agreement.state },
  ];
  // The screen loan comes after the rest (the bank's form; the app only shows its answer).
  const ready = steps.every((s) => s.state === 'done');
  return {
    riderId,
    status: f.status,
    details: f.details,
    canChange: f.status === 'applied',
    documents,
    identity,
    bank,
    agreement,
    steps: [...steps, { step: 'loan', state: ready ? 'todo' : 'later' }],
  };
}
