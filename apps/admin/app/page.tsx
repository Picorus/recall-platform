'use client';
import { Shell, useMember } from '../lib/session';

export default function Today() {
  const member = useMember();
  if (!member) return <p className="narrow muted">Loading…</p>;
  return (
    <Shell member={member}>
      <h1>Today</h1>
      <p className="muted">
        Signed in. The Today page (bikes online, hours sold and delivered, make-ups, alerts) comes
        in step P3.2.
      </p>
    </Shell>
  );
}
