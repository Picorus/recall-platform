'use client';
// P3.15 Support: brand and rider requests in one inbox. Messages on WhatsApp or by email arrive by
// themselves; staff start a conversation for a call or a visit. Longest waiting first. Support admins
// reply, add notes only staff see, pick a conversation up, and mark it waiting or done, with why.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';
import {
  CHANNEL_NAMES,
  STATE_CHIP,
  STATE_NAMES,
  waitText,
  whoText,
  type Inbox,
  type SupportState,
  type ThreadPage,
} from '../../lib/support';

const when = (t: number) => `${dayOfIndia(t)}, ${clock(t)}`;
const failed = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.');
const KIND_NAMES = { in: 'They wrote', out: 'We replied', note: 'Note', step: '' } as const;

function Conversation({
  threadId,
  canAct,
  canReply,
  onChanged,
}: {
  readonly threadId: string;
  readonly canAct: boolean;
  readonly canReply: boolean;
  readonly onChanged: () => void;
}) {
  const [t, setT] = useState<ThreadPage>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<ThreadPage>(`/support/${threadId}`)
      .then((x) => {
        setT(x);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e)));
  }, [threadId]);
  useEffect(load, [load]);
  const act = (path: string, body: object, done: string, after?: () => void) => {
    setBusy(true);
    setError('');
    api<{ status?: string }>(`/support/${threadId}/${path}`, body)
      .then((x) => {
        setNote(
          x.status === 'failed'
            ? 'The reply did not go through: see the history.'
            : x.status === 'unconfirmed'
              ? 'No answer from the provider yet: it may or may not have gone.'
              : done,
        );
        after?.();
        load();
        onChanged();
      })
      .catch((e: unknown) => setError(failed(e)))
      .finally(() => setBusy(false));
  };
  if (!t) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const replyable = t.channel === 'whatsapp' || t.channel === 'email';
  const step = (state: SupportState, owner: 'me' | null, done: string) =>
    act('step', { state, owner, reason: why.trim() }, done, () => setWhy(''));
  return (
    <section className="rc-card stack" aria-label={`Conversation ${t.threadId}`}>
      <h2 style={{ margin: 0 }}>{t.subject}</h2>
      <p className="muted">
        {CHANNEL_NAMES[t.channel]} · {whoText(t)} · {t.contact} ·{' '}
        <span className={`rc-chip ${STATE_CHIP[t.state]}`}>{STATE_NAMES[t.state]}</span>
        {t.owner ? ` · with ${t.owner}` : ' · nobody has it'}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {(t.problems ?? []).map((p) => (
        <p key={p.problemId}>
          Screen problem {p.problemId} ({p.kind}){p.screenId ? ` on ${p.screenId}` : ''}
          {p.photo ? (
            <>
              {' · '}
              <a href={p.photo} target="_blank" rel="noreferrer">
                Open the photo
              </a>
            </>
          ) : (
            ' · no photo'
          )}
        </p>
      ))}
      <ol className="stack" aria-label="History" style={{ listStyle: 'none', padding: 0 }}>
        {t.timeline.map((e, i) => (
          <li key={i} className={e.kind === 'step' ? 'muted' : ''}>
            <span className="muted">{when(e.at)}</span> ·{' '}
            {e.kind === 'step' ? (
              <>
                {e.by}: {e.text}
              </>
            ) : (
              <>
                <strong>
                  {KIND_NAMES[e.kind]} ({e.by})
                </strong>
                : <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>
              </>
            )}
          </li>
        ))}
      </ol>
      {canAct && (
        <>
          {replyable && (
            <div className="stack">
              <label className="rc-field">
                <span className="rc-field__label">
                  Reply on {CHANNEL_NAMES[t.channel]} (they see this)
                </span>
                <textarea
                  className="rc-input"
                  rows={3}
                  maxLength={4000}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
              </label>
              <div className="cal-bar">
                <button
                  className="rc-button"
                  type="button"
                  disabled={busy || !canReply || reply.trim().length === 0}
                  title={canReply ? undefined : 'Messages are not set up yet'}
                  onClick={() => act('reply', { text: reply }, 'Reply sent.', () => setReply(''))}
                >
                  Send reply
                </button>
              </div>
            </div>
          )}
          <div className="stack">
            <label className="rc-field">
              <span className="rc-field__label">Note (staff only)</span>
              <textarea
                className="rc-input"
                rows={2}
                maxLength={5000}
                value={staffNote}
                onChange={(e) => setStaffNote(e.target.value)}
              />
            </label>
            <div className="cal-bar">
              <button
                className="rc-button rc-button--secondary"
                type="button"
                disabled={busy || staffNote.trim().length === 0}
                onClick={() =>
                  act('note', { text: staffNote }, 'Note added.', () => setStaffNote(''))
                }
              >
                Add note
              </button>
            </div>
          </div>
          <div className="cal-bar">
            <label className="rc-field">
              <span className="rc-field__label">Why (logged)</span>
              <input
                className="rc-input"
                value={why}
                maxLength={300}
                onChange={(e) => setWhy(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
              />
            </label>
            {t.state !== 'done' && t.ownerId !== t.me && (
              <button
                className="rc-button rc-button--secondary"
                type="button"
                disabled={busy || why.trim().length < 3}
                onClick={() => step(t.state, 'me', 'You have it.')}
              >
                I&apos;ll take it
              </button>
            )}
            {t.state === 'open' && (
              <button
                className="rc-button rc-button--secondary"
                type="button"
                disabled={busy || why.trim().length < 3}
                onClick={() => step('waiting', 'me', 'Waiting for them.')}
              >
                Waiting for them
              </button>
            )}
            {t.state !== 'done' ? (
              <button
                className="rc-button"
                type="button"
                disabled={busy || why.trim().length < 3}
                onClick={() => step('done', 'me', 'Done.')}
              >
                Done
              </button>
            ) : (
              <button
                className="rc-button rc-button--secondary"
                type="button"
                disabled={busy || why.trim().length < 3}
                onClick={() => step('open', 'me', 'Opened again.')}
              >
                Open again
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function NewConversation({ onDone }: { readonly onDone: (threadId: string) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true);
    setError('');
    api<{ threadId: string }>('/support/open', {
      channel: v('channel'),
      contact: v('contact'),
      subject: v('subject'),
      note: v('note'),
    })
      .then((x) => {
        form.reset();
        onDone(x.threadId);
      })
      .catch((x: unknown) => setError(failed(x)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="rc-card stack" onSubmit={submit} aria-label="New conversation">
      <h2 style={{ margin: 0 }}>New conversation</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">How</span>
          <select className="rc-input" name="channel" defaultValue="phone">
            <option value="phone">Call</option>
            <option value="in person">In person</option>
            <option value="whatsapp">WhatsApp (we write first)</option>
            <option value="email">Email (we write first)</option>
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Mobile or email</span>
          <input className="rc-input" name="contact" required maxLength={260} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">About</span>
          <input className="rc-input" name="subject" required minLength={3} maxLength={200} />
        </label>
      </div>
      <label className="rc-field">
        <span className="rc-field__label">What was said</span>
        <textarea
          className="rc-input"
          name="note"
          rows={3}
          required
          minLength={3}
          maxLength={5000}
        />
      </label>
      <button className="rc-button" type="submit" disabled={busy}>
        Start conversation
      </button>
    </form>
  );
}

export default function SupportPage() {
  const me = useMember();
  const [inbox, setInbox] = useState<Inbox>();
  const [state, setState] = useState('active');
  const [open, setOpen] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(0);
  const load = useCallback((which: string) => {
    const n = ++asked.current;
    api<Inbox>(`/support?state=${which}`)
      .then((x) => {
        if (n !== asked.current) return;
        setInbox(x);
        setError('');
      })
      .catch((e: unknown) => {
        if (n === asked.current) setError(failed(e));
      });
  }, []);
  useEffect(() => {
    if (me) load(state);
  }, [me, load, state]);
  if (!me) return <p className="muted">Loading…</p>;
  return (
    <Shell member={me}>
      <h1>Support</h1>
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Show</span>
          <select className="rc-input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="active">Open and waiting</option>
            <option value="open">Open</option>
            <option value="waiting">Waiting for them</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
        </label>
        <button
          className="rc-button rc-button--secondary"
          type="button"
          onClick={() => load(state)}
        >
          Refresh
        </button>
        {inbox?.canAct && (
          <button className="rc-button" type="button" onClick={() => setAdding(!adding)}>
            New conversation
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {adding && (
        <NewConversation
          onDone={(id) => {
            setAdding(false);
            setOpen(id);
            load(state);
          }}
        />
      )}
      {inbox && inbox.rows.length === 0 && <p className="muted">Nothing here.</p>}
      {inbox && inbox.rows.length > 0 && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Inbox">
            <thead>
              <tr>
                <th>Who</th>
                <th>About · last message</th>
                <th>Where it stands</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {inbox.rows.map((r) => (
                <tr key={r.threadId}>
                  <td>
                    {whoText(r)}
                    <div className="muted">{CHANNEL_NAMES[r.channel]}</div>
                  </td>
                  <td>
                    {r.subject}
                    <div className="muted">
                      {when(r.lastAt)} · {r.lastText}
                    </div>
                  </td>
                  <td className="stack">
                    <span className={`rc-chip ${STATE_CHIP[r.state]}`}>{STATE_NAMES[r.state]}</span>
                    {r.waitingSince !== null && r.state !== 'done' && (
                      <span className="error">{waitText(r.waitingSince, inbox.at)}</span>
                    )}
                    {r.owner && <span className="muted">with {r.owner}</span>}
                  </td>
                  <td>
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      aria-pressed={open === r.threadId}
                      onClick={() => setOpen(r.threadId)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && inbox && (
        <Conversation
          key={open}
          threadId={open}
          canAct={inbox.canAct}
          canReply={inbox.canReply}
          onChanged={() => load(state)}
        />
      )}
    </Shell>
  );
}
