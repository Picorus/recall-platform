'use client';
// P3.4 Screens: stock (on bikes, spares, in repair, retired), each screen's bike, rider, state,
// player version, health, fitting check and certificate; repairs, swaps and taking a screen off;
// the player update rollout with pause, resume and roll back. Every change asks for a reason.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import { STATE_CHIP, STATE_NAMES, type FleetState } from '../../lib/fleet';
import { clock, count, dayOfIndia, since } from '../../lib/format';
import {
  ACTION_NAMES,
  actionsFor,
  certificateSoon,
  LIFE_CHIP,
  LIFE_NAMES,
  stageText,
  type ScreenLife,
} from '../../lib/screens';
import { Shell, useMember } from '../../lib/session';

interface Row {
  readonly screenId: string;
  readonly serial: string;
  readonly model: string;
  readonly life: ScreenLife;
  readonly serviceNote: string | null;
  readonly bike: string | null;
  readonly riderId: string | null;
  readonly state: FleetState;
  readonly lastHeard: number | null;
  readonly app: string | null;
  readonly batteryPct: number | null;
  readonly boxC: number | null;
  readonly alerts: number;
  readonly fittingCheck: { at: number; ready: boolean } | null;
  readonly certificateUntil: number | null;
}

interface Page {
  readonly at: number;
  readonly screens: readonly Row[];
  readonly counts: {
    onBike: number;
    inStock: number;
    cannotFit: number;
    inRepair: number;
    retired: number;
    sparesWanted: number;
  };
  readonly rollout: null | {
    releaseId: string;
    state: string;
    stage: number;
    since: number;
    versionName: string;
    rollbackName: string;
  };
  readonly versions: readonly { app: string; code: number | null; screens: number }[];
}

const LIVES: readonly ScreenLife[] = ['on-bike', 'in-stock', 'in-repair', 'retired'];
const canChange = (m: Member) =>
  m.role === 'super-admin' || (m.role === 'admin' && m.areas.includes('operations'));

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rc-stat">
      <span className="rc-stat__label">{label}</span>
      <span className="rc-stat__value">{value}</span>
      {note && <span className="rc-stat__note">{note}</span>}
    </div>
  );
}

function Manage({
  row,
  spares,
  onDone,
}: {
  row: Row;
  spares: readonly Row[];
  onDone: (msg: string) => void;
}) {
  const actions = actionsFor(row.life);
  const [action, setAction] = useState(actions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (actions.length === 0) return <p className="muted">A retired screen stays retired.</p>;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = String(f.get('reason') ?? '');
    setBusy(true);
    setError('');
    try {
      if (action === 'swap')
        await api(`/screens/${row.screenId}/swap`, {
          newScreenId: String(f.get('spare') ?? ''),
          reason,
        });
      else if (action === 'unfit') await api(`/screens/${row.screenId}/unfit`, { reason });
      else if (action === 'lost')
        await api(`/screens/${row.screenId}/lost`, {
          reason,
          lostAt: Math.floor(Date.now() / 1000) - Number(f.get('hoursAgo') ?? 0) * 3600,
        });
      else await api(`/screens/${row.screenId}/service`, { kind: action, reason });
      onDone(
        `${row.screenId}: ${ACTION_NAMES[action as keyof typeof ACTION_NAMES].toLowerCase()} done.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="rc-card stack" onSubmit={submit} aria-label={`Manage ${row.screenId}`}>
      <strong>
        {row.screenId}
        {row.bike ? ` on ${row.bike}` : ''}
      </strong>
      <label className="rc-field">
        <span className="rc-field__label">What to do</span>
        <select className="rc-input" value={action} onChange={(e) => setAction(e.target.value)}>
          {actions.map((a) => (
            <option key={a} value={a}>
              {ACTION_NAMES[a]}
            </option>
          ))}
        </select>
      </label>
      {action === 'swap' &&
        (spares.length === 0 ? (
          <p className="error">No spare in stock to swap in.</p>
        ) : (
          <label className="rc-field">
            <span className="rc-field__label">Spare to fit (the old one goes to repair)</span>
            <select className="rc-input" name="spare" required>
              {spares.map((s) => (
                <option key={s.screenId} value={s.screenId}>
                  {s.screenId} · {s.serial}
                </option>
              ))}
            </select>
          </label>
        ))}
      {action === 'lost' && (
        <>
          <p className="error">
            Nothing it shows from that moment counts, its line to us closes and it comes off its bike.
            This cannot be undone.
          </p>
          <label className="rc-field">
            <span className="rc-field__label">Went missing how many hours ago (0 = now)</span>
            <input
              className="rc-input"
              name="hoursAgo"
              type="number"
              min={0}
              max={168}
              defaultValue={0}
              required
            />
          </label>
        </>
      )}
      <label className="rc-field">
        <span className="rc-field__label">Reason (logged)</span>
        <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="rc-button rc-button--primary"
        type="submit"
        disabled={busy || (action === 'swap' && spares.length === 0)}
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

function Rollout({ page, me, onDone }: { page: Page; me: Member; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const r = page.rollout;
  const act = async (path: string, body: object, msg: string) => {
    setBusy(true);
    setError('');
    try {
      await api(path, body);
      onDone(msg);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  const submit = (kind: 'pause' | 'resume' | 'roll-back') => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    if (kind === 'roll-back')
      void act(
        '/rollout/roll-back',
        { reason },
        'Rolled back: screens on it get the rollback build.',
      );
    else
      void act(
        '/rollout/pause',
        { pause: kind === 'pause', reason },
        kind === 'pause' ? 'Update paused.' : 'Update resumed.',
      );
  };
  const running = r && ['started', 'advanced', 'resumed'].includes(r.state);
  return (
    <section className="stack" aria-labelledby="update">
      <h2 id="update">Player update</h2>
      {!r ? (
        <p className="muted">No update has been released yet.</p>
      ) : (
        <p>
          <strong>{r.versionName}</strong> is {stageText(r.state, r.stage)} since{' '}
          {dayOfIndia(r.since / 1000)} {clock(r.since / 1000)}. Its rollback build is{' '}
          {r.rollbackName}.
        </p>
      )}
      <p className="muted">
        In use:{' '}
        {page.versions.length === 0
          ? 'no screen has connected yet'
          : page.versions.map((v) => `${v.app} on ${count(v.screens)}`).join(' · ')}
      </p>
      {r && canChange(me) && (running || r.state === 'paused' || r.state === 'finished') && (
        <div className="areas">
          {running && (
            <form className="areas" onSubmit={submit('pause')}>
              <input
                className="rc-input"
                name="reason"
                aria-label="Reason to pause"
                placeholder="Reason"
                minLength={3}
                required
              />
              <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                Pause
              </button>
            </form>
          )}
          {r.state === 'paused' && (
            <form className="areas" onSubmit={submit('resume')}>
              <input
                className="rc-input"
                name="reason"
                aria-label="Reason to resume"
                placeholder="Reason"
                minLength={3}
                required
              />
              <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
                Resume
              </button>
            </form>
          )}
          <form className="areas" onSubmit={submit('roll-back')}>
            <input
              className="rc-input"
              name="reason"
              aria-label="Reason to roll back"
              placeholder="Reason"
              minLength={3}
              required
            />
            <button className="rc-button rc-button--quiet" type="submit" disabled={busy}>
              Roll back
            </button>
          </form>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export default function ScreensPage() {
  const me = useMember();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [lives, setLives] = useState<Set<ScreenLife>>(new Set(LIVES));
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState('');

  const load = useCallback(() => {
    api<Page>('/screens')
      .then((p) => {
        setPage(p);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const rows = useMemo(() => {
    const q = search.trim().toUpperCase().replace(/\s+/g, '');
    return (page?.screens ?? []).filter(
      (r) =>
        lives.has(r.life) &&
        (!q ||
          r.screenId.includes(q) ||
          (r.bike ?? '').includes(q) ||
          r.serial.toUpperCase().includes(q)),
    );
  }, [page, lives, search]);
  const spares = useMemo(() => (page?.screens ?? []).filter((r) => r.life === 'in-stock'), [page]);

  const done = (msg: string) => {
    setNote(msg);
    setOpen('');
    load();
  };

  if (!me) return <p className="narrow muted">Loading…</p>;
  const c = page?.counts;
  return (
    <Shell member={me}>
      <h1>Screens</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {c && (
        <div className="tiles">
          <Stat label="On bikes" value={count(c.onBike)} />
          <Stat
            label="Spares in stock"
            value={count(c.inStock)}
            note={
              c.inStock < c.sparesWanted
                ? `below the ${count(c.sparesWanted)} wanted (5%)`
                : `${count(c.sparesWanted)} wanted (5%)`
            }
          />
          {c.cannotFit > 0 && (
            <Stat
              label="Cannot be fitted"
              value={count(c.cannotFit)}
              note="no valid certificate, or reported lost"
            />
          )}
          <Stat label="In repair" value={count(c.inRepair)} />
          <Stat label="Retired" value={count(c.retired)} />
        </div>
      )}
      {page && <Rollout page={page} me={me} onDone={done} />}

      <h2>All screens</h2>
      <div className="areas filters" role="group" aria-label="Show">
        {LIVES.map((l) => (
          <label key={l}>
            <input
              type="checkbox"
              checked={lives.has(l)}
              onChange={(e) => {
                const next = new Set(lives);
                if (e.target.checked) next.add(l);
                else next.delete(l);
                setLives(next);
              }}
            />
            {LIFE_NAMES[l]}
          </label>
        ))}
        <input
          className="rc-input"
          aria-label="Find a screen"
          placeholder="Screen, plate or serial"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {open &&
        page &&
        (() => {
          const row = page.screens.find((r) => r.screenId === open);
          return row ? <Manage key={open} row={row} spares={spares} onDone={done} /> : null;
        })()}
      <div className="rc-table-wrap">
        <table className="rc-table">
          <thead>
            <tr>
              <th>Screen</th>
              <th>Bike</th>
              <th>Where</th>
              <th>Now</th>
              <th>Player</th>
              <th>Health</th>
              <th>Fitting check</th>
              <th>Certificate</th>
              {canChange(me) && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.screenId}>
                <td>
                  <span className="mono">{r.screenId}</span>
                  <br />
                  <span className="muted">{r.serial}</span>
                </td>
                <td>{r.bike ? `${r.bike} (${r.riderId ?? ''})` : '—'}</td>
                <td>
                  <span className={`rc-chip ${LIFE_CHIP[r.life]}`}>{LIFE_NAMES[r.life]}</span>
                  {r.serviceNote && <div className="muted">{r.serviceNote}</div>}
                </td>
                <td>
                  {r.life === 'on-bike' ? (
                    <span className={`rc-chip ${STATE_CHIP[r.state]}`}>{STATE_NAMES[r.state]}</span>
                  ) : (
                    '—'
                  )}
                  {r.lastHeard && page && (
                    <div className="muted">{since(r.lastHeard, page.at)} ago</div>
                  )}
                </td>
                <td>{r.app ?? '—'}</td>
                <td>
                  {r.batteryPct !== null ? `${r.batteryPct}%` : '—'}
                  {r.boxC !== null ? ` · ${r.boxC} °C` : ''}
                  {r.alerts > 0 && (
                    <div className="error">
                      {r.alerts} alert{r.alerts > 1 ? 's' : ''}
                    </div>
                  )}
                </td>
                <td>
                  {r.fittingCheck ? (r.fittingCheck.ready ? 'Ready' : 'Not ready') : 'Not done'}
                </td>
                <td className={page && certificateSoon(r.certificateUntil, page.at) ? 'error' : ''}>
                  {r.certificateUntil ? dayOfIndia(r.certificateUntil) : 'none'}
                </td>
                {canChange(me) && (
                  <td>
                    {actionsFor(r.life).length > 0 && (
                      <button
                        className="rc-button rc-button--quiet"
                        type="button"
                        onClick={() => setOpen(open === r.screenId ? '' : r.screenId)}
                      >
                        {open === r.screenId ? 'Close' : 'Manage'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
