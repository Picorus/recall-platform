'use client';
// Every area on the map with its versions; an Operations admin edits a shape (drag its corners on
// the map, click to add one, or type the corners), its edge zone or name, as a new version (or a
// draft); a super admin adds areas and turns them on or off. "Check" asks the area rules (no
// overlap, no crossing border, edge zone 0–2,000 m) before saving.
import type { GeoJSONSource, Map as MapLibre, MapMouseEvent } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import { cornersText, indiaToUtc, parseCorners, type Corner } from '../../lib/areas';
import { count, dayOfIndia, clock } from '../../lib/format';
import { mapColours, newMap } from '../../lib/map';
import { Shell, useMember } from '../../lib/session';

interface AreaVersion {
  readonly areaId: string;
  readonly version: number;
  readonly name: string;
  readonly city: string;
  readonly ring: readonly Corner[];
  readonly edgeMeters: number;
  readonly validFrom: string;
  readonly draft: boolean;
  readonly active: boolean;
}

interface AreaRecord {
  readonly area: AreaVersion;
  readonly savedBy: string;
  readonly savedAt: string;
  readonly reason: string | null;
}

interface Page {
  readonly areas: readonly { latest: AreaVersion; history: readonly AreaRecord[] }[];
  readonly defaultEdgeMeters: number;
}

const isSuper = (m: Member) => m.role === 'super-admin';
const canEdit = (m: Member) => isSuper(m) || (m.role === 'admin' && m.areas.includes('operations'));
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const status = (a: AreaVersion) => (!a.active ? 'Off' : a.draft ? 'Draft' : 'On');
const polygon = (ring: readonly Corner[]) => [
  [...ring, ring[0]].filter((p): p is Corner => p !== undefined).map((p) => [p.lng, p.lat]),
];

export default function AreasEditor({ styleUrl }: { readonly styleUrl: string }) {
  const me = useMember();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(''); // an area id, or 'new'
  const [ring, setRing] = useState<Corner[]>([]);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [problems, setProblems] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const [noMap, setNoMap] = useState(false);
  const drag = useRef<number | null>(null);
  const addingRef = useRef(false);
  addingRef.current = adding;

  const load = useCallback(() => {
    api<Page>('/areas')
      .then(setPage)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const current = useMemo(() => page?.areas.find((a) => a.latest.areaId === open), [page, open]);
  // Corners show (and can be dragged) only for someone who may save the change.
  const editable = !!me && open !== '' && canEdit(me) && (open !== 'new' || isSuper(me));

  const choose = (id: string) => {
    setOpen(id);
    setProblems(undefined);
    setNote('');
    setAdding(id === 'new');
    const r = page?.areas.find((a) => a.latest.areaId === id)?.latest.ring ?? [];
    setRing([...r]);
    setText(cornersText(r));
  };
  const setCorners = useCallback((r: Corner[]) => {
    setRing(r);
    setText(cornersText(r));
    setProblems(undefined);
  }, []);

  // The map, once: areas, the shape being edited, and its corners (drag to move).
  useEffect(() => {
    if (!me || !box.current || map.current) return;
    const c = mapColours();
    const m = newMap(box.current, styleUrl, 12);
    if (!m) {
      setNoMap(true);
      return;
    }
    m.on('load', () => {
      const empty = { type: 'FeatureCollection' as const, features: [] };
      m.addSource('areas', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'area-fill',
        type: 'fill',
        source: 'areas',
        paint: { 'fill-color': c.areaFill, 'fill-opacity': 0.4 },
      });
      m.addLayer({
        id: 'area-line',
        type: 'line',
        source: 'areas',
        paint: { 'line-color': c.areaLine, 'line-width': 1.5 },
      });
      m.addSource('edit', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'edit-line',
        type: 'line',
        source: 'edit',
        paint: { 'line-color': c.ink, 'line-width': 2, 'line-dasharray': [2, 1] },
      });
      m.addSource('corners', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'corners',
        type: 'circle',
        source: 'corners',
        paint: {
          'circle-radius': 6,
          'circle-color': c.brand,
          'circle-stroke-color': c.ink,
          'circle-stroke-width': 1.5,
        },
      });
      m.on('mousedown', 'corners', (e) => {
        const i = e.features?.[0]?.properties?.i;
        if (typeof i !== 'number') return;
        e.preventDefault();
        drag.current = i;
        m.dragPan.disable();
      });
      m.on('mousemove', (e: MapMouseEvent) => {
        if (drag.current === null) return;
        const i = drag.current;
        setRing((r) => {
          const next = r.map((p, j) => (j === i ? { lat: e.lngLat.lat, lng: e.lngLat.lng } : p));
          setText(cornersText(next));
          return next;
        });
      });
      m.on('mouseup', () => {
        if (drag.current === null) return;
        drag.current = null;
        m.dragPan.enable();
        setProblems(undefined);
      });
      m.on('click', (e: MapMouseEvent) => {
        if (!addingRef.current) return;
        setRing((r) => {
          const next = [...r, { lat: e.lngLat.lat, lng: e.lngLat.lng }];
          setText(cornersText(next));
          return next;
        });
        setProblems(undefined);
      });
      m.on('mouseenter', 'corners', () => (m.getCanvas().style.cursor = 'move'));
      m.on('mouseleave', 'corners', () => (m.getCanvas().style.cursor = ''));
      setReady(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [me, styleUrl]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !page) return;
    (m.getSource('areas') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: page.areas
        .filter((a) => a.latest.areaId !== open && a.latest.active)
        .map((a) => ({
          type: 'Feature',
          properties: { name: a.latest.name },
          geometry: { type: 'Polygon', coordinates: polygon(a.latest.ring) },
        })),
    });
    (m.getSource('edit') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features:
        open && ring.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: polygon(ring)[0] ?? [] },
              },
            ]
          : [],
    });
    (m.getSource('corners') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: editable
        ? ring.map((p, i) => ({
            type: 'Feature',
            properties: { i },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          }))
        : [],
    });
  }, [ready, page, open, ring, editable]);

  // Show the whole area when it is opened.
  useEffect(() => {
    const m = map.current;
    const r = current?.latest.ring ?? [];
    if (!ready || !m || r.length === 0) return;
    const lats = r.map((p) => p.lat);
    const lngs = r.map((p) => p.lng);
    m.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, maxZoom: 15 },
    );
  }, [ready, current]);

  const onText = (t: string) => {
    setText(t);
    setProblems(undefined);
    const r = parseCorners(t);
    if ('ring' in r) setRing(r.ring);
  };

  const call = async (f: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const check = (edgeMeters: number) =>
    call(async () => {
      const r = parseCorners(text);
      if ('problem' in r) return setProblems([r.problem]);
      const x = await api<{ problems: string[] }>('/areas/check', {
        areaId: open === 'new' ? undefined : open,
        ring: r.ring,
        edgeMeters,
      });
      setProblems(x.problems);
    });

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = parseCorners(text);
    if ('problem' in r) return setProblems([r.problem]);
    const edgeMeters = Number(f.get('edge'));
    const validFrom = indiaToUtc(String(f.get('from') ?? ''));
    const reason = String(f.get('reason') ?? '');
    void call(async () => {
      if (open === 'new') {
        await api('/areas', {
          areaId: String(f.get('areaId') ?? ''),
          name: String(f.get('name') ?? ''),
          city: String(f.get('city') ?? ''),
          ring: r.ring,
          edgeMeters,
          draft: f.get('draft') === 'on',
          validFrom,
          reason,
        });
      } else {
        await api(`/areas/${open}/versions`, {
          name: String(f.get('name') ?? ''),
          ring: r.ring,
          edgeMeters,
          draft: f.get('draft') === 'on',
          validFrom,
          reason,
        });
      }
      setNote(open === 'new' ? 'Area added.' : 'New version saved.');
      setOpen('');
      setAdding(false);
      load();
    });
  };

  const onOff = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!current) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    const active = !current.latest.active;
    void call(async () => {
      await api(`/areas/${current.latest.areaId}/active`, { active, reason });
      setNote(`${current.latest.name} turned ${active ? 'on' : 'off'}.`);
      load();
    });
  };

  if (!me) return <p className="narrow muted">Loading…</p>;
  const editing = editable;
  const latest = current?.latest;
  return (
    <Shell member={me}>
      <h1>Areas</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {isSuper(me) && (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          onClick={() => choose('new')}
        >
          Add an area
        </button>
      )}
      <div className="fleet">
        <div ref={box} className="fleet-map">
          {noMap && (
            <p className="muted" style={{ padding: 16 }}>
              This computer cannot draw the map. Type the corners instead.
            </p>
          )}
        </div>
        {editing && (
          <form className="rc-card stack area-panel" onSubmit={save} aria-label="Edit area">
            <h2 style={{ margin: 0 }}>
              {open === 'new' ? 'New area' : `${latest?.name ?? ''}: new version`}
            </h2>
            {open === 'new' && (
              <>
                <label className="rc-field">
                  <span className="rc-field__label">
                    Id (lower case, dashes: e.g. hyd-gachibowli)
                  </span>
                  <input
                    className="rc-input"
                    name="areaId"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    required
                  />
                </label>
                <label className="rc-field">
                  <span className="rc-field__label">City</span>
                  <input className="rc-input" name="city" defaultValue="Hyderabad" required />
                </label>
              </>
            )}
            <label className="rc-field">
              <span className="rc-field__label">Name</span>
              <input
                className="rc-input"
                name="name"
                defaultValue={latest?.name ?? ''}
                maxLength={80}
                required
              />
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Edge zone (metres around the border, 0–2,000)</span>
              <input
                className="rc-input"
                name="edge"
                type="number"
                min={0}
                max={2000}
                step={1}
                defaultValue={latest?.edgeMeters ?? page?.defaultEdgeMeters ?? 300}
                required
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={adding}
                onChange={(e) => setAdding(e.target.checked)}
              />{' '}
              Click the map to add corners
            </label>
            <p className="muted">
              Drag a corner on the map to move it. Corners in order around the area:
            </p>
            <label className="rc-field">
              <span className="rc-field__label">Corners (latitude, longitude per line)</span>
              <textarea
                className="rc-input mono"
                rows={6}
                value={text}
                onChange={(e) => onText(e.target.value)}
              />
            </label>
            <div className="areas">
              <button
                className="rc-button rc-button--quiet"
                type="button"
                onClick={() => setCorners(ring.slice(0, -1))}
                disabled={ring.length === 0}
              >
                Remove last corner
              </button>
              <button
                className="rc-button rc-button--quiet"
                type="button"
                disabled={busy}
                onClick={(e) =>
                  void check(
                    Number(
                      (e.currentTarget.form?.elements.namedItem('edge') as HTMLInputElement | null)
                        ?.value ?? 300,
                    ),
                  )
                }
              >
                Check
              </button>
            </div>
            {problems &&
              (problems.length === 0 ? (
                <p role="status">The shape passes every rule.</p>
              ) : (
                <ul className="error" role="alert">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ))}
            <label className="rc-field">
              <span className="rc-field__label">Starts (India time; empty: now)</span>
              <input className="rc-input" name="from" type="datetime-local" />
            </label>
            <label>
              <input type="checkbox" name="draft" defaultChecked={latest?.draft ?? false} /> Draft
              (cannot be sold until a later version is not a draft)
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Reason (logged)</span>
              <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
            </label>
            <div className="areas">
              <button className="rc-button rc-button--primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                className="rc-button rc-button--quiet"
                type="button"
                onClick={() => setOpen('')}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {current && isSuper(me) && (
        <form className="areas filters" onSubmit={onOff} aria-label="Turn on or off">
          <input
            className="rc-input"
            name="reason"
            aria-label="Reason to turn on or off"
            placeholder="Reason"
            minLength={3}
            required
          />
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Turn {current.latest.name} {current.latest.active ? 'off' : 'on'}
          </button>
        </form>
      )}

      {current && (
        <section className="stack">
          <h2>{current.latest.name}: versions</h2>
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>From</th>
                  <th>State</th>
                  <th>Edge zone</th>
                  <th>Corners</th>
                  <th>Saved by</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {[...current.history].reverse().map((h) => (
                  <tr key={h.area.version}>
                    <td>{h.area.version}</td>
                    <td>
                      {dayOfIndia(secs(h.area.validFrom))} {clock(secs(h.area.validFrom))}
                    </td>
                    <td>{status(h.area)}</td>
                    <td>{count(h.area.edgeMeters)} m</td>
                    <td>{h.area.ring.length}</td>
                    <td>{h.savedBy}</td>
                    <td>{h.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <h2>All areas ({count(page?.areas.length ?? 0)})</h2>
      <div className="rc-table-wrap">
        <table className="rc-table">
          <thead>
            <tr>
              <th>Area</th>
              <th>City</th>
              <th>State</th>
              <th>Version</th>
              <th>Edge zone</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {page?.areas.map(({ latest: a }) => (
              <tr key={a.areaId}>
                <td>
                  {a.name}
                  <div className="muted mono">{a.areaId}</div>
                </td>
                <td>{a.city}</td>
                <td>
                  <span
                    className={`rc-chip ${!a.active ? 'rc-chip--offline' : a.draft ? 'rc-chip--paused' : 'rc-chip--go'}`}
                  >
                    {status(a)}
                  </span>
                </td>
                <td>{a.version}</td>
                <td>{count(a.edgeMeters)} m</td>
                <td>
                  <button
                    className="rc-button rc-button--quiet"
                    type="button"
                    onClick={() => choose(a.areaId)}
                  >
                    {canEdit(me) ? 'Open' : 'History'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
