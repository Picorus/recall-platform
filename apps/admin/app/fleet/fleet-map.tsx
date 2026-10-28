'use client';
// Every screen live on the map (positions only ever from the screens themselves), filtered by
// state, area and plate; click a bike for its route, health, fittings and commands. Refreshes every
// 30 seconds.
import 'maplibre-gl/dist/maplibre-gl.css';
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { Fold, foldHint, latestOf } from '@recall/web-ui';
import { mapColours, newMap } from '../../lib/map';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import {
  areaOf,
  batteryText,
  counts,
  shown,
  signalText,
  STATE_CHIP,
  STATE_NAMES,
  type Area,
  type FleetScreen,
  type FleetState,
  type Position,
} from '../../lib/fleet';
import { ALERT_NAMES, clock, count, dayOfIndia, since } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';

const STATES: readonly FleetState[] = ['moving', 'stopped', 'offline', 'at-hub'];

interface Fleet {
  readonly at: number;
  readonly screens: readonly FleetScreen[];
  readonly areas: readonly Area[];
  readonly commands: readonly string[];
}

interface Detail {
  readonly screen: FleetScreen;
  readonly route: readonly Position[];
  readonly health: null | {
    t: number;
    app: string;
    batteryPct: number | null;
    charging: boolean | null;
    batteryC: number | null;
    boxC: number | null;
    freeMb: number;
    signalDbm: number | null;
    ledFault: boolean | null;
    tamper: boolean | null;
  };
  readonly fittings: readonly {
    from: number;
    bike: string | null;
    riderId: string | null;
    reason: string;
  }[];
  readonly commands: readonly {
    id: string;
    command: string;
    value: number | null;
    by: string;
    reason: string;
    made: number;
    state: string;
    note: string;
  }[];
}

const COMMAND_NAMES: Record<string, string> = {
  reboot: 'Restart',
  blank: 'Blank the screen',
  unblank: 'Show ads again',
  'test-pattern': 'Test pattern',
  brightness: 'Brightness',
  'send-logs': 'Send logs',
  'clear-cache': 'Clear cache',
};

function Panel({
  id,
  me,
  commands,
  onClose,
  onRoute,
}: {
  readonly id: string;
  readonly me: Member;
  readonly commands: readonly string[];
  readonly onClose: () => void;
  readonly onRoute: (r: readonly Position[]) => void;
}) {
  const [d, setD] = useState<Detail>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [command, setCommand] = useState('reboot');
  const [sending, setSending] = useState(false);
  const canAct =
    me.role === 'super-admin' || (me.role === 'admin' && me.areas.includes('operations'));

  const load = useCallback(() => {
    api<Detail>(`/fleet/screens/${id}`)
      .then((x) => {
        setD(x);
        onRoute(x.route);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, [id, onRoute]);
  useEffect(load, [load]);

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = String(f.get('value') ?? '').trim();
    setError('');
    setNote('');
    setSending(true);
    try {
      const r = await api<{ repeated: boolean }>(`/fleet/screens/${id}/commands`, {
        command,
        value: raw === '' ? null : Number(raw),
        reason: String(f.get('reason') ?? ''),
      });
      setNote(
        r.repeated
          ? 'Already sent a moment ago: not sent twice.'
          : 'Sent. The screen answers within a minute when its line is open, else when it next connects.',
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setSending(false);
    }
  };

  const needsValue = command === 'brightness' || command === 'test-pattern';
  return (
    <aside className="rc-card stack fleet-panel" aria-label="Screen">
      <div className="areas" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{d?.screen.bike ?? 'Screen'}</h2>
        <button className="rc-button rc-button--quiet" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!d ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p>
            <span className={`rc-chip ${STATE_CHIP[d.screen.state]}`}>
              {STATE_NAMES[d.screen.state]}
            </span>{' '}
            <span className="mono">{d.screen.screenId}</span>
          </p>
          <dl className="facts">
            <dt>Rider</dt>
            <dd>{d.screen.riderId ?? '—'}</dd>
            <dt>Last heard</dt>
            <dd>
              {d.screen.lastHeard
                ? `${since(d.screen.lastHeard, Math.floor(Date.now() / 1000))} ago`
                : 'never'}
            </dd>
            <dt>Area</dt>
            <dd>{areaOf(d.screen.position?.place) ?? 'outside the areas'}</dd>
            <dt>Player</dt>
            <dd>{d.screen.app ?? '—'}</dd>
            <dt>Alerts</dt>
            <dd>
              {d.screen.alerts.length
                ? d.screen.alerts.map((a) => ALERT_NAMES[a] ?? a).join(', ')
                : 'none'}
            </dd>
          </dl>
          <h3>Health</h3>
          {d.health ? (
            <dl className="facts">
              <dt>Reported</dt>
              <dd>{clock(d.health.t)}</dd>
              <dt>Battery</dt>
              <dd>
                {batteryText(d.health.batteryPct, d.health.charging)}
                {d.health.batteryC !== null ? `, ${d.health.batteryC} °C` : ''}
              </dd>
              <dt>Box</dt>
              <dd>{d.health.boxC !== null ? `${d.health.boxC} °C` : 'not known'}</dd>
              <dt>Signal</dt>
              <dd>{signalText(d.health.signalDbm)}</dd>
              <dt>Free storage</dt>
              <dd>{count(d.health.freeMb)} MB</dd>
            </dl>
          ) : (
            <p className="muted">No health report yet.</p>
          )}
          <p className="muted">
            Route: the last 2 hours ({count(d.route.length)} positions) is drawn on the map.
          </p>

          {canAct && (
            <form className="stack" onSubmit={send}>
              <h3>Send a command</h3>
              <label className="rc-field">
                <span className="rc-field__label">Command</span>
                <select
                  className="rc-input"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                >
                  {commands.map((c) => (
                    <option key={c} value={c}>
                      {COMMAND_NAMES[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
              {needsValue && (
                <label className="rc-field">
                  <span className="rc-field__label">
                    {command === 'brightness'
                      ? 'Brightness % (1–100; empty: automatic)'
                      : 'Seconds (5–600)'}
                  </span>
                  <input className="rc-input" name="value" inputMode="numeric" />
                </label>
              )}
              <label className="rc-field">
                <span className="rc-field__label">Reason (logged)</span>
                <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
              </label>
              {note && <p role="status">{note}</p>}
              <button className="rc-button rc-button--primary" type="submit" disabled={sending}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </form>
          )}

          <Fold
            title="Commands sent"
            hint={foldHint(
              d.commands.length,
              ['command', 'commands'],
              latestOf(d.commands.map((c) => Math.floor(c.made / 1000))),
            )}
          >
            {d.commands.length === 0 ? (
              <p className="muted">None sent.</p>
            ) : (
              <ul className="plain">
                {d.commands.map((c) => (
                  <li key={c.id}>
                    {dayOfIndia(Math.floor(c.made / 1000))} {clock(Math.floor(c.made / 1000))} ·{' '}
                    {COMMAND_NAMES[c.command] ?? c.command}
                    {c.value !== null ? ` ${c.value}` : ''} · <strong>{c.state}</strong> · {c.by}:{' '}
                    {c.reason}
                    {c.note && c.command !== 'send-logs' ? ` (${c.note})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Fold>
          <Fold
            title="Fittings"
            hint={foldHint(
              d.fittings.length,
              ['fitting', 'fittings'],
              latestOf(d.fittings.map((f) => f.from)),
            )}
          >
            <ul className="plain">
              {d.fittings.map((f) => (
                <li key={f.from}>
                  {dayOfIndia(f.from)} ·{' '}
                  {f.bike ? `on ${f.bike} (${f.riderId ?? ''})` : 'taken off'} · {f.reason}
                </li>
              ))}
            </ul>
          </Fold>
        </>
      )}
    </aside>
  );
}

export default function FleetMap({ styleUrl }: { readonly styleUrl: string }) {
  const me = useMember();
  const [fleet, setFleet] = useState<Fleet>();
  const [error, setError] = useState('');
  const [states, setStates] = useState<Set<FleetState>>(new Set(STATES));
  const [area, setArea] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [noMap, setNoMap] = useState(false);

  const load = useCallback(() => {
    api<Fleet>('/fleet')
      .then((f) => {
        setFleet(f);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (!me) return;
    load();
    const every = setInterval(load, 30_000);
    return () => clearInterval(every);
  }, [me, load]);

  const visible = useMemo(
    () => (fleet ? fleet.screens.filter((s) => shown(s, { states, area, search })) : []),
    [fleet, states, area, search],
  );

  // The map, once.
  useEffect(() => {
    if (!me || !box.current || map.current) return;
    const c = mapColours();
    const m = newMap(box.current, styleUrl);
    if (!m) {
      // No WebGL on this computer: the list and the screen panels still work.
      setNoMap(true);
      return;
    }
    m.on('load', () => {
      m.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({
        id: 'area-fill',
        type: 'fill',
        source: 'areas',
        paint: { 'fill-color': c.areaFill, 'fill-opacity': 0.45 },
      });
      m.addLayer({
        id: 'area-line',
        type: 'line',
        source: 'areas',
        paint: { 'line-color': c.areaLine, 'line-width': 1.5 },
      });
      m.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        paint: { 'line-color': c.areaLine, 'line-width': 3 },
      });
      m.addSource('bikes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({
        id: 'bikes',
        type: 'circle',
        source: 'bikes',
        paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'state'], 'moving', c.brand, 'stopped', c.data, c.stop],
          'circle-stroke-color': c.ink,
          'circle-stroke-width': 1,
        },
      });
      m.on('click', 'bikes', (e) => {
        const id = e.features?.[0]?.properties?.screenId;
        if (typeof id === 'string') setOpen(id);
      });
      m.on('mouseenter', 'bikes', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'bikes', () => (m.getCanvas().style.cursor = ''));
      setReady(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [me, styleUrl]);

  // Areas and bikes on the map.
  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !fleet) return;
    (m.getSource('areas') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: fleet.areas.map((a) => ({
        type: 'Feature',
        properties: { name: a.name },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [...a.ring, a.ring[0]].filter((p) => p !== undefined).map((p) => [p.lng, p.lat]),
          ],
        },
      })),
    });
    (m.getSource('bikes') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: visible.flatMap((s) =>
        s.position && s.state !== 'at-hub'
          ? [
              {
                type: 'Feature' as const,
                properties: { screenId: s.screenId, state: s.state },
                geometry: { type: 'Point' as const, coordinates: [s.position.lng, s.position.lat] },
              },
            ]
          : [],
      ),
    });
  }, [ready, fleet, visible]);

  const showRoute = useCallback((r: readonly Position[]) => {
    const m = map.current;
    if (!m || !m.getSource('route')) return;
    (m.getSource('route') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features:
        r.length > 1
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: r.map((p) => [p.lng, p.lat]) },
              },
            ]
          : [],
    });
  }, []);
  const close = () => {
    setOpen('');
    showRoute([]);
  };

  if (!me) return <p className="narrow muted">Loading…</p>;
  const n = fleet ? counts(fleet.screens) : undefined;
  return (
    <Shell member={me}>
      <h1>Fleet map</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="areas filters" role="group" aria-label="Show">
        {STATES.map((s) => (
          <label key={s}>
            <input
              type="checkbox"
              checked={states.has(s)}
              onChange={(e) => {
                const next = new Set(states);
                if (e.target.checked) next.add(s);
                else next.delete(s);
                setStates(next);
              }}
            />
            {STATE_NAMES[s]} {n ? `(${count(n[s])})` : ''}
          </label>
        ))}
        <select
          className="rc-input"
          aria-label="Area"
          value={area}
          onChange={(e) => setArea(e.target.value)}
        >
          <option value="">Every area</option>
          {fleet?.areas.map((a) => (
            <option key={a.areaId} value={a.areaId}>
              {a.name}
            </option>
          ))}
        </select>
        <input
          className="rc-input"
          aria-label="Find a bike"
          placeholder="Number plate or screen"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="fleet">
        <div ref={box} className="fleet-map">
          {noMap && (
            <p className="muted" style={{ padding: 16 }}>
              This computer cannot draw the map. The list below still works.
            </p>
          )}
        </div>
        {open && fleet && (
          <Panel
            key={open}
            id={open}
            me={me}
            commands={fleet.commands}
            onClose={close}
            onRoute={showRoute}
          />
        )}
      </div>
      <h2>Bikes ({count(visible.length)})</h2>
      <div className="rc-table-wrap">
        <table className="rc-table">
          <thead>
            <tr>
              <th>Bike</th>
              <th>State</th>
              <th>Area</th>
              <th>Last heard</th>
              <th>Alerts</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.screenId}>
                <td>
                  <button
                    className="rc-button rc-button--quiet"
                    type="button"
                    onClick={() => setOpen(s.screenId)}
                  >
                    {s.bike ?? s.screenId}
                  </button>
                </td>
                <td>
                  <span className={`rc-chip ${STATE_CHIP[s.state]}`}>{STATE_NAMES[s.state]}</span>
                </td>
                <td>{areaOf(s.position?.place) ?? '—'}</td>
                <td>{s.lastHeard && fleet ? `${since(s.lastHeard, fleet.at)} ago` : 'never'}</td>
                <td>{s.alerts.map((a) => ALERT_NAMES[a] ?? a).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
