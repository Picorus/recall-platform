'use client';
// Every area on the map with its versions; an Operations admin edits a shape (drag its corners on
// the map, click to add one, draw it again corner by corner, or type the corners), its edge zone or
// name, as a new version (or a draft); a super admin draws new areas and turns areas on or off.
// Corners snap onto a neighbour's corner or border (P1.1.7: neighbours may share a border, never
// overlap). "Check" asks the area rules (no overlap, no crossing border, edge zone 0–2,000 m) and
// shows the gap, shared border or overlap with each neighbour, on the map too, before saving.
import type { GeoJSONSource, Map as MapLibre, MapMouseEvent } from 'maplibre-gl';
import { Fold } from '@recall/web-ui';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import {
  addCorner,
  closeRing,
  closeGap,
  cornersText,
  parseCorners,
  snapCorner,
  snapMetres,
  type Corner,
  type Neighbour,
  type Snap,
} from '../../lib/areas';
import { count, dayOfIndia, clock, noSpaces, tidyBox } from '../../lib/format';
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

/** How the shape sits next to one neighbour (the API's Check, P1.1.7). */
interface Beside {
  readonly areaId: string;
  readonly name: string;
  readonly gapMeters: number;
  readonly gap: { readonly from: Corner; readonly to: Corner } | null;
  readonly sharedMeters: number;
  readonly overlapSqm: number;
  readonly overlap: readonly (readonly Corner[])[];
}

const isSuper = (m: Member) => m.role === 'super-admin';
const canEdit = (m: Member) => isSuper(m) || (m.role === 'admin' && m.areas.includes('operations'));
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const status = (a: AreaVersion) => (!a.active ? 'Off' : a.draft ? 'Draft' : 'On');
const polygon = (ring: readonly Corner[]) => [
  [...ring, ring[0]].filter((p): p is Corner => p !== undefined).map((p) => [p.lng, p.lat]),
];
/** "212 m" or "1.8 km". */
const distance = (m: number) =>
  m < 1_000 ? `${count(Math.round(m))} m` : `${(Math.round(m / 100) / 10).toFixed(1)} km`;
/** A click this close (screen pixels) to the first corner closes the shape. */
const CLOSE_PIXELS = 10;
/** "Close the gap" is offered for gaps up to this, and moves corners up to 100 m beyond the gap. */
const CLOSE_GAP_UP_TO = 500;

export default function AreasEditor({ styleUrl }: { readonly styleUrl: string }) {
  const me = useMember();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(''); // an area id, or 'new'
  const [ring, setRing] = useState<Corner[]>([]);
  const [snaps, setSnaps] = useState<(Snap | undefined)[]>([]);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [snap, setSnap] = useState(true);
  const [snapNote, setSnapNote] = useState('');
  const [problems, setProblems] = useState<string[]>();
  const [beside, setBeside] = useState<readonly Beside[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const [noMap, setNoMap] = useState(false);
  const drag = useRef<number | null>(null);
  /** The shape before drawing started, for Cancel. */
  const before = useRef<Corner[]>([]);
  // The map's handlers are set once; they read the newest state through these.
  const live = useRef({
    adding,
    drawing,
    snap,
    ring,
    snaps,
    others: [] as Neighbour[],
  });

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
  // A new area's city is one from Settings (P3.17).
  const [cities, setCities] = useState<readonly string[]>(['Hyderabad']);
  useEffect(() => {
    if (me)
      api<{ settings: { cities: { value: { name: string }[] } } }>('/settings')
        .then((x) => setCities(x.settings.cities.value.map((c) => c.name)))
        .catch(() => undefined);
  }, [me]);

  const current = useMemo(() => page?.areas.find((a) => a.latest.areaId === open), [page, open]);
  /** The other areas that are on: what a corner snaps to. */
  const others = useMemo<Neighbour[]>(
    () =>
      (page?.areas ?? [])
        .map((a) => a.latest)
        .filter((a) => a.areaId !== open && a.active)
        .map((a) => ({ areaId: a.areaId, name: a.name, ring: a.ring })),
    [page, open],
  );
  live.current = { adding, drawing, snap, ring, snaps, others };
  // Corners show (and can be dragged) only for someone who may save the change.
  const editable = !!me && open !== '' && canEdit(me) && (open !== 'new' || isSuper(me));

  const choose = (id: string, draw = false) => {
    setOpen(id);
    setProblems(undefined);
    setBeside([]);
    setNote('');
    setSnapNote('');
    setAdding(false);
    const r = page?.areas.find((a) => a.latest.areaId === id)?.latest.ring ?? [];
    before.current = [...r];
    setRing(draw ? [] : [...r]);
    setSnaps([]);
    setText(draw ? '' : cornersText(r));
    setDrawing(draw);
  };
  const setCorners = useCallback((r: Corner[], s: (Snap | undefined)[] = []) => {
    setRing(r);
    setSnaps(s);
    setText(cornersText(r));
    setProblems(undefined);
    setBeside([]);
  }, []);

  // Drawing: start (from nothing), finish (close the shape), undo a corner, cancel.
  const startDrawing = () => {
    before.current = ring;
    setCorners([]);
    setAdding(false);
    setDrawing(true);
    setSnapNote('Click the map corner by corner.');
  };
  const finishDrawing = useCallback(() => {
    const l = live.current;
    if (l.ring.length < 3) return;
    // Last and first corner on the same neighbour: the closing side follows its border too.
    const closed = closeRing(l.ring, l.snaps, l.others);
    live.current = { ...l, ring: closed.ring, snaps: closed.snaps };
    setRing(closed.ring);
    setSnaps(closed.snaps);
    setText(cornersText(closed.ring));
    setProblems(undefined);
    setBeside([]);
    setDrawing(false);
    setSnapNote(`Shape closed with ${closed.ring.length} corners. Check it, then save.`);
  }, []);
  const cancelDrawing = useCallback(() => {
    setDrawing(false);
    setCorners(before.current);
    setSnapNote('Drawing cancelled.');
  }, [setCorners]);
  const undoCorner = () => {
    setCorners(ring.slice(0, -1), snaps.slice(0, -1));
    setSnapNote(ring.length > 1 ? 'Last corner taken away.' : '');
  };
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrawing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, cancelDrawing]);

  /** Says where a corner snapped, for everyone (also read out by screen readers). */
  const said = (s: Snap | undefined) =>
    setSnapNote(
      s
        ? `Snapped to ${s.name}'s ${s.kind === 'corner' ? 'corner' : 'border'}.`
        : live.current.snap
          ? 'Not near a neighbour: placed where clicked.'
          : 'Placed where clicked.',
    );

  // The map, once: areas, the shape being edited, its corners (drag to move), Check's findings.
  useEffect(() => {
    if (!me || !box.current || map.current) return;
    const c = mapColours();
    const m = newMap(box.current, styleUrl, 12);
    if (!m) {
      setNoMap(true);
      return;
    }
    const radius = (lat: number) => (live.current.snap ? snapMetres(m.getZoom(), lat) : 0);
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
      m.addSource('check', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'check-overlap',
        type: 'fill',
        source: 'check',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': c.stop, 'fill-opacity': 0.55 },
      });
      m.addLayer({
        id: 'check-gap',
        type: 'line',
        source: 'check',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': c.stop, 'line-width': 3, 'line-dasharray': [1, 1] },
      });
      m.addSource('edit', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'edit-line',
        type: 'line',
        source: 'edit',
        paint: { 'line-color': c.ink, 'line-width': 2, 'line-dasharray': [2, 1] },
      });
      m.addSource('rubber', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'rubber',
        type: 'line',
        source: 'rubber',
        paint: { 'line-color': c.ink, 'line-width': 1, 'line-opacity': 0.6 },
      });
      m.addSource('corners', { type: 'geojson', data: empty });
      m.addLayer({
        id: 'corners',
        type: 'circle',
        source: 'corners',
        paint: {
          // While drawing, the first corner is bigger: click it to close the shape.
          'circle-radius': ['case', ['get', 'first'], 8, 6],
          'circle-color': c.brand,
          'circle-stroke-color': c.ink,
          'circle-stroke-width': 1.5,
        },
      });
      const rubber = (to: [number, number] | null) => {
        const last = live.current.ring[live.current.ring.length - 1];
        (m.getSource('rubber') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features:
            to && last
              ? [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: [[last.lng, last.lat], to] },
                  },
                ]
              : [],
        });
      };
      m.on('mousedown', 'corners', (e) => {
        if (live.current.drawing) return;
        const i = e.features?.[0]?.properties?.i;
        if (typeof i !== 'number') return;
        e.preventDefault();
        drag.current = i;
        m.dragPan.disable();
      });
      m.on('mousemove', (e: MapMouseEvent) => {
        if (live.current.drawing) rubber([e.lngLat.lng, e.lngLat.lat]);
        if (drag.current === null) return;
        const i = drag.current;
        setRing((r) => {
          const next = r.map((p, j) => (j === i ? { lat: e.lngLat.lat, lng: e.lngLat.lng } : p));
          setText(cornersText(next));
          return next;
        });
      });
      m.on('mouseup', (e: MapMouseEvent) => {
        if (drag.current === null) return;
        const i = drag.current;
        drag.current = null;
        m.dragPan.enable();
        // Where it was let go: snapped onto a neighbour, to 6 decimals.
        const s = snapCorner(
          { lat: e.lngLat.lat, lng: e.lngLat.lng },
          live.current.others,
          radius(e.lngLat.lat),
        );
        setRing((r) => {
          const next = r.map((p, j) => (j === i ? s.point : p));
          setText(cornersText(next));
          return next;
        });
        setSnaps((x) => x.map((v, j) => (j === i ? s.snap : v)));
        said(s.snap);
        setProblems(undefined);
        setBeside([]);
      });
      m.on('mouseout', () => rubber(null));
      m.on('click', (e: MapMouseEvent) => {
        const l = live.current;
        if (!l.drawing && !l.adding) return;
        const first = l.ring[0];
        if (l.drawing && first && l.ring.length >= 3) {
          const p = m.project([first.lng, first.lat]);
          if (Math.hypot(p.x - e.point.x, p.y - e.point.y) <= CLOSE_PIXELS) {
            rubber(null);
            finishDrawing();
            return;
          }
        }
        const out = addCorner(
          l.ring,
          l.snaps,
          { lat: e.lngLat.lat, lng: e.lngLat.lng },
          l.others,
          radius(e.lngLat.lat),
        );
        // The newest state at once: a second click can come before React draws again.
        live.current = { ...l, ring: out.ring, snaps: out.snaps };
        setRing(out.ring);
        setSnaps(out.snaps);
        setText(cornersText(out.ring));
        said(out.snap);
        setProblems(undefined);
        setBeside([]);
      });
      m.on('mouseenter', 'corners', () => {
        if (!live.current.drawing) m.getCanvas().style.cursor = 'move';
      });
      m.on('mouseleave', 'corners', () => (m.getCanvas().style.cursor = ''));
      setReady(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [me, styleUrl, finishDrawing]);

  useEffect(() => {
    const m = map.current;
    if (!ready || !m || !page) return;
    m.getCanvas().style.cursor = drawing || adding ? 'crosshair' : '';
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
    // While drawing, the line stays open until the shape is closed.
    const line = drawing ? ring.map((p) => [p.lng, p.lat]) : (polygon(ring)[0] ?? []);
    (m.getSource('edit') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features:
        open && ring.length >= 2
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: line },
              },
            ]
          : [],
    });
    if (!drawing)
      (m.getSource('rubber') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    (m.getSource('corners') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: editable
        ? ring.map((p, i) => ({
            type: 'Feature',
            properties: { i, first: drawing && i === 0 },
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          }))
        : [],
    });
    (m.getSource('check') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: beside.flatMap((b) => [
        ...b.overlap.map((piece) => ({
          type: 'Feature' as const,
          properties: { areaId: b.areaId },
          geometry: { type: 'Polygon' as const, coordinates: polygon(piece) },
        })),
        ...(b.gap
          ? [
              {
                type: 'Feature' as const,
                properties: { areaId: b.areaId },
                geometry: {
                  type: 'LineString' as const,
                  coordinates: [
                    [b.gap.from.lng, b.gap.from.lat],
                    [b.gap.to.lng, b.gap.to.lat],
                  ],
                },
              },
            ]
          : []),
      ]),
    });
  }, [ready, page, open, ring, editable, drawing, adding, beside]);

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
    setBeside([]);
    const r = parseCorners(t);
    if ('ring' in r) {
      setRing(r.ring);
      setSnaps([]);
    }
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

  const check = (edgeMeters: number, corners = text) =>
    call(async () => {
      const r = parseCorners(corners);
      if ('problem' in r) {
        setBeside([]);
        return setProblems([r.problem]);
      }
      const x = await api<{ problems: string[]; neighbours?: Beside[] }>('/areas/check', {
        areaId: open === 'new' ? undefined : open,
        ring: r.ring,
        edgeMeters,
      });
      setProblems(x.problems);
      setBeside(x.neighbours ?? []);
    });

  /** "Close the gap with <neighbour>": move the corners near it onto its border, then Check. */
  const closeGapWith = (b: Beside, edgeMeters: number) => {
    const n = others.find((o) => o.areaId === b.areaId);
    if (!n) return;
    const next = closeGap(ring, n, b.gapMeters + 100);
    setCorners(next);
    setSnapNote(`Corners near ${b.name} moved onto its border.`);
    void check(edgeMeters, cornersText(next));
  };

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = parseCorners(text);
    if ('problem' in r) return setProblems([r.problem]);
    const edgeMeters = Number(f.get('edge'));
    const reason = String(f.get('reason') ?? '');
    void call(async () => {
      if (open === 'new') {
        await api('/areas', {
          areaId: noSpaces(String(f.get('areaId') ?? '')),
          name: String(f.get('name') ?? ''),
          city: String(f.get('city') ?? ''),
          ring: r.ring,
          edgeMeters,
          draft: f.get('draft') === 'on',
          reason,
        });
      } else {
        await api(`/areas/${open}/versions`, {
          name: String(f.get('name') ?? ''),
          ring: r.ring,
          edgeMeters,
          draft: f.get('draft') === 'on',
          reason,
        });
      }
      setNote(open === 'new' ? 'Area added.' : 'New version saved.');
      setOpen('');
      setAdding(false);
      setDrawing(false);
      setBeside([]);
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
  const edgeOf = (form: HTMLFormElement | null | undefined) =>
    Number(
      (form?.elements.namedItem('edge') as HTMLInputElement | null)?.value ??
        page?.defaultEdgeMeters ??
        300,
    );
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
          onClick={() => choose('new', !noMap)}
        >
          Draw a new area
        </button>
      )}
      <div className="fleet">
        <div
          ref={box}
          className="fleet-map"
          aria-label="Map of the areas"
          data-ready={ready ? 'yes' : undefined}
        >
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
                    onChange={tidyBox(noSpaces)}
                    required
                  />
                </label>
                <label className="rc-field">
                  <span className="rc-field__label">City</span>
                  <select className="rc-input" name="city" required>
                    {cities.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
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

            <fieldset className="stack draw-panel" aria-label="Drawing">
              <legend className="rc-field__label">On the map</legend>
              <label>
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{' '}
                Snap to neighbours (a corner within about 30 m of another area’s corner or border
                goes exactly onto it)
              </label>
              {drawing ? (
                <>
                  <p className="muted">
                    Click the map corner by corner. Click the first corner or press Finish to close
                    the shape; Esc cancels.
                  </p>
                  <div className="areas">
                    <button
                      className="rc-button rc-button--primary rc-button--small"
                      type="button"
                      onClick={finishDrawing}
                      disabled={ring.length < 3}
                    >
                      Finish
                    </button>
                    <button
                      className="rc-button rc-button--quiet rc-button--small"
                      type="button"
                      onClick={undoCorner}
                      disabled={ring.length === 0}
                    >
                      Undo last corner
                    </button>
                    <button
                      className="rc-button rc-button--quiet rc-button--small"
                      type="button"
                      onClick={cancelDrawing}
                    >
                      Cancel drawing
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="areas">
                    <button
                      className="rc-button rc-button--secondary rc-button--small"
                      type="button"
                      onClick={startDrawing}
                      disabled={noMap}
                    >
                      {open === 'new' ? 'Draw on the map' : 'Draw the shape again'}
                    </button>
                    <button
                      className="rc-button rc-button--quiet rc-button--small"
                      type="button"
                      onClick={() => setCorners(ring.slice(0, -1), snaps.slice(0, -1))}
                      disabled={ring.length === 0}
                    >
                      Remove last corner
                    </button>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={adding}
                      onChange={(e) => setAdding(e.target.checked)}
                    />{' '}
                    Click the map to add corners
                  </label>
                  <p className="muted">Drag a corner on the map to move it.</p>
                </>
              )}
              <p className="muted" role="status" aria-live="polite">
                {snapNote}
              </p>
            </fieldset>

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
                disabled={busy || drawing}
                onClick={(e) => void check(edgeOf(e.currentTarget.form))}
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
            {problems && beside.length > 0 && (
              <ul className="stack beside" aria-label="Next to other areas">
                {beside.map((b) => (
                  <li key={b.areaId}>
                    {b.overlapSqm > 1 ? (
                      <span className="error">
                        Overlaps {b.name} by about {count(Math.ceil(b.overlapSqm))} m² (red on the
                        map)
                      </span>
                    ) : b.gapMeters === 0 ? (
                      <span>
                        {b.sharedMeters >= 1
                          ? `Shares ${distance(b.sharedMeters)} of border with ${b.name}`
                          : `Touches ${b.name} at a corner`}
                      </span>
                    ) : (
                      <>
                        <span>
                          {distance(b.gapMeters)} gap to {b.name} (dashed on the map)
                        </span>{' '}
                        {b.gapMeters <= CLOSE_GAP_UP_TO && (
                          <button
                            className="rc-button rc-button--quiet rc-button--small"
                            type="button"
                            disabled={busy || drawing}
                            onClick={(e) => closeGapWith(b, edgeOf(e.currentTarget.form))}
                          >
                            Close the gap with {b.name}
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted">The change starts as soon as it is saved.</p>
            <label>
              <input type="checkbox" name="draft" defaultChecked={latest?.draft ?? false} /> Draft
              (cannot be sold until a later version is not a draft)
            </label>
            <label className="rc-field">
              <span className="rc-field__label">Reason (logged)</span>
              <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
            </label>
            <div className="areas">
              <button
                className="rc-button rc-button--primary"
                type="submit"
                disabled={busy || drawing}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                className="rc-button rc-button--quiet"
                type="button"
                onClick={() => {
                  setOpen('');
                  setDrawing(false);
                  setBeside([]);
                }}
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
        <Fold
          // Who cannot change areas opens one to read its history: open for them.
          open={!canEdit(me)}
          title={`${current.latest.name}: versions`}
          hint={`${current.history.length} ${current.history.length === 1 ? 'version' : 'versions'}, latest from ${dayOfIndia(secs(current.latest.validFrom))} · who saved each, and why`}
        >
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
        </Fold>
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
