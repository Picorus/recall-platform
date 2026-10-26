'use client';
// P3.11.1: one rider for staff: details (changed with why), what approval needs, his steps (each with
// why), the documents he sent (preview, accept or reject with why; insurance with the day it ends),
// notes and the timeline. An Operations admin acts; Support adds notes.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { dayOfIndia, clock } from '../../lib/format';
import {
  APPS,
  DOCUMENT_NAMES,
  documentStatus,
  NEXT_STEPS,
  phoneText,
  STATUS_CHIP,
  STATUS_NAMES,
  type DocumentKind,
  type RiderDocument,
  type RiderPage,
} from '../../lib/riders';

const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;

function DocumentRow({
  d,
  riderId,
  canAct,
  onDone,
}: {
  readonly d: RiderDocument;
  readonly riderId: string;
  readonly canAct: boolean;
  readonly onDone: (note: string, error?: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const decide = (decision: 'accepted' | 'rejected') =>
    api(`/riders/${riderId}/documents/${d.docId}/review`, {
      decision,
      reason: reason.trim(),
      expiresOn: expires || null,
    })
      .then(() => onDone(`${DOCUMENT_NAMES[d.kind]} ${decision}.`))
      .catch((e: unknown) =>
        onDone('', e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  const ok = reason.trim().length >= 3;
  return (
    <li className="ad-row">
      {d.preview && d.fileType !== 'pdf' ? (
        // A plain img: the link is signed and short-lived (no image optimiser in between).
        <img className="ad-preview" src={d.preview} alt={DOCUMENT_NAMES[d.kind]} />
      ) : d.preview ? (
        <a href={d.preview} target="_blank" rel="noreferrer">
          Open PDF
        </a>
      ) : (
        <span className="muted">No preview</span>
      )}
      <div className="stack">
        <div>
          <strong>{DOCUMENT_NAMES[d.kind]}</strong>{' '}
          <span className="muted">
            · sent {when(d.uploadedAt)} by {d.uploadedBy}
          </span>
        </div>
        <div className={d.review?.decision === 'rejected' ? 'error' : 'muted'}>
          {documentStatus(d)}
        </div>
        {canAct && !d.review && (
          <div className="cal-bar" aria-label={`Look at ${DOCUMENT_NAMES[d.kind]}`}>
            <label className="rc-field">
              <span className="rc-field__label">Why (logged)</span>
              <input
                className="rc-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={300}
                aria-label={`Why, ${DOCUMENT_NAMES[d.kind]}`}
              />
            </label>
            {d.kind === 'insurance' && (
              <label className="rc-field">
                <span className="rc-field__label">Covers until</span>
                <input
                  className="rc-input"
                  type="date"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  aria-label="Insurance covers until"
                />
              </label>
            )}
            <button
              className="rc-button"
              type="button"
              disabled={!ok || (d.kind === 'insurance' && !expires)}
              onClick={() => void decide('accepted')}
            >
              Accept
            </button>
            <button
              className="rc-button rc-button--secondary"
              type="button"
              disabled={!ok}
              onClick={() => void decide('rejected')}
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export default function RiderPanel({
  riderId,
  canAct,
  canNote,
  onChanged,
}: {
  readonly riderId: string;
  /** An Operations admin (or a super admin). */
  readonly canAct: boolean;
  /** Operations or Support admins. */
  readonly canNote: boolean;
  readonly onChanged: () => void;
}) {
  const [p, setP] = useState<RiderPage>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const asked = useRef(0);

  const load = useCallback(() => {
    const n = ++asked.current;
    api<RiderPage>(`/riders/${riderId}`)
      .then((x) => {
        if (n === asked.current) setP(x);
      })
      .catch((e: unknown) => {
        if (n === asked.current)
          setError(e instanceof ApiError ? e.message : 'Could not load the rider.');
      });
  }, [riderId]);
  useEffect(() => {
    setP(undefined);
    setError('');
    setNote('');
    setEditing(false);
    load();
  }, [load]);

  const done = (n: string, err?: string) => {
    if (err) {
      setError(err);
      return;
    }
    setError('');
    setNote(n);
    load();
    onChanged();
  };
  const act = (
    path: string,
    body: object,
    ok: string,
    form?: HTMLFormElement,
    after?: () => void,
  ) => {
    setBusy(true);
    setError('');
    setNote('');
    api(path, body)
      .then(() => {
        form?.reset();
        after?.();
        done(ok);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };

  if (!p) return <p className="muted">{error || 'Loading…'}</p>;
  const r = p.rider;

  const step = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const to = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? '';
    act(
      `/riders/${r.riderId}/step`,
      { to, reason: String(f.get('reason') ?? '') },
      `${STATUS_NAMES[to as keyof typeof STATUS_NAMES] ?? to}.`,
      form,
    );
  };
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    act(
      `/riders/${r.riderId}/details`,
      {
        name: String(f.get('name') ?? ''),
        phone: String(f.get('phone') ?? ''),
        bikePlate: String(f.get('bikePlate') ?? '').trim() || null,
        rides: String(f.get('rides') ?? ''),
        apps: f.getAll('apps').map(String),
        reason: String(f.get('reason') ?? ''),
      },
      'Details saved.',
      undefined,
      () => setEditing(false),
    );
  };
  const upload = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    const kind = String(f.get('kind') ?? '');
    if (!(file instanceof File) || file.size === 0) return setError('Choose a file');
    setBusy(true);
    setError('');
    fetch(`/api/riders/${r.riderId}/documents?kind=${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const x = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new ApiError(res.status, x.error ?? 'The upload failed. Try again.');
        form.reset();
        done(`${DOCUMENT_NAMES[kind as DocumentKind] ?? kind} sent: waiting for a look.`);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'The upload failed.'),
      )
      .finally(() => setBusy(false));
  };
  const addNote = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    act(
      `/riders/${r.riderId}/notes`,
      { note: String(new FormData(form).get('note') ?? '') },
      'Note added.',
      form,
    );
  };

  return (
    <section className="rc-card stack" aria-label={`Rider ${r.riderId}`}>
      <h3 style={{ margin: 0 }}>
        {r.name} <span className="mono">{r.riderId}</span>{' '}
        <span className={`rc-chip ${STATUS_CHIP[r.status]}`}>{STATUS_NAMES[r.status]}</span>
      </h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {!editing ? (
        <dl className="facts">
          <dt>Phone</dt>
          <dd>{phoneText(r.phone)}</dd>
          <dt>Number plate</dt>
          <dd>{r.bikePlate ?? '—'}</dd>
          <dt>Rides in</dt>
          <dd>{r.rides || '—'}</dd>
          <dt>Works for</dt>
          <dd>{r.apps.join(', ') || '—'}</dd>
          <dt>Screen</dt>
          <dd>{p.screenId ?? 'none fitted'}</dd>
          <dt>Joined</dt>
          <dd>
            {when(r.createdAt)} ({p.channel === 'app' ? 'rider app' : 'by staff'})
          </dd>
        </dl>
      ) : (
        <form className="stack" onSubmit={save} aria-label="Rider details">
          <label className="rc-field">
            <span className="rc-field__label">Name</span>
            <input className="rc-input" name="name" defaultValue={r.name} maxLength={80} required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Phone</span>
            <input
              className="rc-input"
              name="phone"
              defaultValue={r.phone}
              maxLength={20}
              required
            />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Number plate</span>
            <input
              className="rc-input"
              name="bikePlate"
              defaultValue={r.bikePlate ?? ''}
              maxLength={16}
            />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Rides in</span>
            <input className="rc-input" name="rides" defaultValue={r.rides} maxLength={120} />
          </label>
          <fieldset className="cal-bar">
            <legend className="rc-field__label">Works for</legend>
            {APPS.map((a) => (
              <label key={a}>
                <input type="checkbox" name="apps" value={a} defaultChecked={r.apps.includes(a)} />{' '}
                {a}
              </label>
            ))}
          </fieldset>
          <label className="rc-field">
            <span className="rc-field__label">Why the change (logged)</span>
            <input className="rc-input" name="reason" minLength={3} maxLength={300} required />
          </label>
          <div className="cal-bar">
            <button className="rc-button" type="submit" disabled={busy}>
              Save details
            </button>
            <button
              className="rc-button rc-button--quiet"
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {canAct && !editing && (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          onClick={() => setEditing(true)}
        >
          Change details
        </button>
      )}

      <h4 style={{ margin: 0 }}>To approve</h4>
      <ul className="plain" aria-label="Approval checklist">
        {p.checklist.map((c) => (
          <li key={c.item} className={c.done ? '' : 'error'}>
            {c.done ? '✓' : '✗'} {c.item}: {c.detail}
          </li>
        ))}
      </ul>

      {canAct && (
        <form className="cal-bar" onSubmit={step} aria-label="Rider step">
          <label className="rc-field">
            <span className="rc-field__label">Why (logged)</span>
            <input className="rc-input" name="reason" minLength={5} maxLength={300} required />
          </label>
          {NEXT_STEPS[r.status].map((s) => (
            <button
              key={s.to}
              className="rc-button rc-button--secondary"
              type="submit"
              value={s.to}
              disabled={busy}
            >
              {s.label}
            </button>
          ))}
        </form>
      )}

      <h4 style={{ margin: 0 }}>Documents</h4>
      {p.documents.length === 0 && <p className="muted">None sent yet.</p>}
      <ul className="plain" aria-label="Documents">
        {p.documents.map((d) => (
          <DocumentRow key={d.docId} d={d} riderId={r.riderId} canAct={canAct} onDone={done} />
        ))}
      </ul>
      {canAct && (
        <form className="cal-bar" onSubmit={upload} aria-label="Send a document">
          <label className="rc-field">
            <span className="rc-field__label">Document</span>
            <select className="rc-input" name="kind" defaultValue="photo">
              {(Object.keys(DOCUMENT_NAMES) as DocumentKind[]).map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_NAMES[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="rc-field">
            <span className="rc-field__label">File (photo or PDF, up to 10 MB)</span>
            <input
              className="rc-input"
              name="file"
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              required
            />
          </label>
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Send
          </button>
        </form>
      )}

      <h4 style={{ margin: 0 }}>Timeline</h4>
      <ul className="plain" aria-label="Timeline">
        {p.timeline.map((t, i) => (
          <li key={i}>
            {t.text}
            <div className="muted">
              {when(t.at)} · {t.by}
            </div>
          </li>
        ))}
      </ul>
      {canNote && (
        <form className="stack" onSubmit={addNote} aria-label="Rider note">
          <label className="rc-field">
            <span className="rc-field__label">Add a note</span>
            <textarea className="rc-input" name="note" rows={2} maxLength={2000} required />
          </label>
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Add note
          </button>
        </form>
      )}
    </section>
  );
}
