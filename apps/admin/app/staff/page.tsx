'use client';
// The super admin's staff page: everyone with their access; add a member (they get a one-time
// invite link), change a member's role and areas, reset their password and two-step code, switch
// them off or on. Every change asks for a reason and is logged.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import { Shell, useMember } from '../../lib/session';
import {
  accessText,
  AREA_NAMES,
  AREAS,
  formProblem,
  ROLE_NAMES,
  ROLES,
  type Area,
  type Role,
} from '../../lib/staff';

function inviteLink(token: string): string {
  return `${window.location.origin}/invite#t=${token}`;
}

function AccessFields({
  role,
  areas,
  onRole,
  onAreas,
}: {
  readonly role: Role;
  readonly areas: readonly Area[];
  readonly onRole: (r: Role) => void;
  readonly onAreas: (a: Area[]) => void;
}) {
  return (
    <>
      <label className="rc-field">
        <span className="rc-field__label">Role</span>
        <select className="rc-input" value={role} onChange={(e) => onRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_NAMES[r]}
            </option>
          ))}
        </select>
      </label>
      {role !== 'super-admin' && (
        <fieldset className="areas">
          <legend className="rc-field__label">
            {role === 'read-only' ? 'May look at' : 'Works in'}
          </legend>
          {AREAS.map((a) => (
            <label key={a}>
              <input
                type="checkbox"
                checked={areas.includes(a)}
                onChange={(e) =>
                  onAreas(e.target.checked ? [...areas, a] : areas.filter((x) => x !== a))
                }
              />
              {AREA_NAMES[a]}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

function Invite({ token, until }: { readonly token: string; readonly until: number }) {
  return (
    <div className="rc-card stack" role="status">
      <strong>
        Send this link to them yourself (WhatsApp or email). It works once, until{' '}
        {new Date(until).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.
      </strong>
      <span className="mono">{inviteLink(token)}</span>
      <button
        className="rc-button rc-button--secondary"
        type="button"
        onClick={() => void navigator.clipboard.writeText(inviteLink(token))}
      >
        Copy link
      </button>
    </div>
  );
}

function Edit({
  m,
  onDone,
}: {
  readonly m: Member;
  readonly onDone: (msg: string, invite?: { token: string; until: number }) => void;
}) {
  const [role, setRole] = useState<Role>(m.role);
  const [areas, setAreas] = useState<Area[]>([...m.areas]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const run = async (f: () => Promise<void>) => {
    setError('');
    try {
      await f();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the server.');
    }
  };
  const save = (active: boolean) =>
    run(async () => {
      const p = formProblem(role, areas);
      if (p) throw new ApiError(400, p);
      await api(`/staff/${m.id}/access`, { role, areas, active, reason });
      onDone(
        active ? `${m.name}: access saved. They sign in again.` : `${m.name} is switched off.`,
      );
    });
  const reset = () =>
    run(async () => {
      const r = await api<{ inviteToken: string; inviteUntil: number }>(`/staff/${m.id}/reset`, {});
      onDone(`${m.name}: password and code reset. Their old ones stopped working.`, {
        token: r.inviteToken,
        until: r.inviteUntil,
      });
    });
  return (
    <div className="rc-card stack">
      <AccessFields role={role} areas={areas} onRole={setRole} onAreas={setAreas} />
      <label className="rc-field">
        <span className="rc-field__label">Reason (logged)</span>
        <input
          className="rc-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="areas">
        <button
          className="rc-button rc-button--primary"
          type="button"
          onClick={() => void save(true)}
        >
          {m.active ? 'Save access' : 'Switch on'}
        </button>
        {m.active && (
          <button
            className="rc-button rc-button--secondary"
            type="button"
            onClick={() => void save(false)}
          >
            Switch off
          </button>
        )}
        <button className="rc-button rc-button--quiet" type="button" onClick={() => void reset()}>
          Reset password and code
        </button>
      </div>
    </div>
  );
}

export default function Staff() {
  const me = useMember();
  const [staff, setStaff] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [invite, setInvite] = useState<{ token: string; until: number }>();
  const [editing, setEditing] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const [areas, setAreas] = useState<Area[]>([]);

  const load = useCallback(() => {
    api<{ staff: Member[] }>('/staff')
      .then((r) => setStaff(r.staff))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me?.role === 'super-admin') load();
  }, [me, load]);

  const done = (msg: string, inv?: { token: string; until: number }) => {
    setNote(msg);
    setInvite(inv);
    setEditing('');
    load();
  };

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError('');
    const p = formProblem(role, areas);
    if (p) return setError(p);
    try {
      const r = await api<{ member: Member; inviteToken: string; inviteUntil: number }>('/staff', {
        email: String(f.get('email') ?? ''),
        name: String(f.get('name') ?? ''),
        reason: String(f.get('reason') ?? ''),
        role,
        areas,
      });
      form.reset();
      setAreas([]);
      done(`${r.member.name} added.`, { token: r.inviteToken, until: r.inviteUntil });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    }
  };

  if (!me) return <p className="narrow muted">Loading…</p>;
  if (me.role !== 'super-admin')
    return (
      <Shell member={me}>
        <p>Only a super admin manages staff.</p>
      </Shell>
    );
  return (
    <Shell member={me}>
      <h1>Staff</h1>
      {note && <p role="status">{note}</p>}
      {invite && <Invite token={invite.token} until={invite.until} />}
      <div className="rc-table-wrap">
        <table className="rc-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Access</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{accessText(m.role, m.areas)}</td>
                <td>
                  <span className={`rc-chip ${m.active ? 'rc-chip--go' : 'rc-chip--offline'}`}>
                    {m.active ? 'Active' : 'Switched off'}
                  </span>
                </td>
                <td>
                  <button
                    className="rc-button rc-button--quiet"
                    type="button"
                    onClick={() => setEditing(editing === m.id ? '' : m.id)}
                  >
                    {editing === m.id ? 'Close' : 'Change'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && staff.find((m) => m.id === editing) && (
        <Edit key={editing} m={staff.find((m) => m.id === editing) as Member} onDone={done} />
      )}
      <h2>Add a member</h2>
      <form className="rc-card stack" onSubmit={add}>
        <label className="rc-field">
          <span className="rc-field__label">Name</span>
          <input className="rc-input" name="name" maxLength={80} required />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Email</span>
          <input
            className="rc-input"
            name="email"
            type="text"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>
        <AccessFields role={role} areas={areas} onRole={setRole} onAreas={setAreas} />
        <label className="rc-field">
          <span className="rc-field__label">Reason (logged)</span>
          <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="rc-button rc-button--primary" type="submit">
          Add and make an invite link
        </button>
      </form>
    </Shell>
  );
}
