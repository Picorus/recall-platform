'use client';
// P5.4.1: our areas on a map, the exact shapes staff draw (the published version in force now).
// On load each outline draws itself in, one after another, then fills softly; with reduced motion
// everything is simply there. Hovering or tapping an area (or its name in the list beside the map,
// also with the keyboard) highlights it and says its name and size. On the Book page the areas the
// brand picked stand out, and the card under a tapped area picks or removes it.
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoJSONSource, Map as MapLibre, MapLayerMouseEvent } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import {
  boundsOf,
  closedLine,
  drawingEnds,
  drawnAt,
  drawOrder,
  outlineUpTo,
  sizeText,
  svgPaths,
  type MapArea,
} from './area-shapes';
import { mapColours, newMap } from './map';

/** The areas that are on now, from GET /portal/areas; an error in words when they cannot come. */
export function useOurAreas(): { areas: readonly MapArea[] | undefined; error: string } {
  const [areas, setAreas] = useState<readonly MapArea[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ areas: MapArea[] }>('/areas')
      .then((r) => setAreas(r.areas))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  }, []);
  return { areas, error };
}

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface AreasMapProps {
  readonly areas: readonly MapArea[];
  /** The base map style (BRAND_MAP_STYLE_URL), or '' for our shapes on plain ground. */
  readonly styleUrl: string;
  /** Areas the brand picked (the Book page): they stand out. */
  readonly picked?: readonly string[];
  /** Pick or remove an area (the Book page); only for the areas that can be booked. */
  readonly onPick?: (areaId: string) => void;
  readonly canPick?: (areaId: string) => boolean;
  /** What the map is called for screen readers. */
  readonly label?: string;
}

export function AreasMap({
  areas,
  styleUrl,
  picked = [],
  onPick,
  canPick = () => true,
  label = 'Map of our areas',
}: AreasMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState(false);
  const [noMap, setNoMap] = useState(false);
  const [drawn, setDrawn] = useState(false);
  /** Under the pointer or the keyboard's focus. */
  const [hover, setHover] = useState<string>();
  /** Tapped or clicked: stays highlighted until another tap. */
  const [chosen, setChosen] = useState<string>();
  const hot = hover ?? chosen;
  const byId = useMemo(() => new Map(areas.map((a) => [a.areaId, a])), [areas]);
  const shown = hot ? byId.get(hot) : undefined;
  // The map's handlers are set once; they read the newest areas through this.
  const live = useRef(areas);
  live.current = areas;

  // The map, once there are areas to show.
  useEffect(() => {
    if (!box.current || map.current || areas.length === 0) return;
    const m = newMap(box.current, styleUrl, 11.5);
    if (!m) {
      setNoMap(true);
      setDrawn(true);
      return;
    }
    let frame = 0;
    const paint = () => {
      const c = mapColours();
      if (m.getLayer('ground')) m.setPaintProperty('ground', 'background-color', c.ground);
      if (!m.getLayer('areas-fill')) return;
      m.setPaintProperty('areas-fill', 'fill-color', [
        'case',
        ['boolean', ['feature-state', 'picked'], false],
        c.brand,
        c.areaLine,
      ]);
      m.setPaintProperty('areas-line', 'line-color', [
        'case',
        ['boolean', ['feature-state', 'picked'], false],
        c.ink,
        c.areaLine,
      ]);
    };
    m.on('load', () => {
      const all = live.current;
      const empty = { type: 'FeatureCollection' as const, features: [] };
      m.addSource('areas', {
        type: 'geojson',
        promoteId: 'areaId',
        data: {
          type: 'FeatureCollection',
          features: all.map((a) => ({
            type: 'Feature',
            properties: { areaId: a.areaId },
            geometry: { type: 'Polygon', coordinates: [closedLine(a.ring)] },
          })),
        },
      });
      m.addSource('outlines', { type: 'geojson', promoteId: 'areaId', data: empty });
      m.addLayer({
        id: 'areas-fill',
        type: 'fill',
        source: 'areas',
        paint: {
          'fill-opacity': [
            '*',
            ['coalesce', ['feature-state', 'shown'], 0],
            [
              'case',
              ['boolean', ['feature-state', 'hot'], false],
              0.5,
              ['boolean', ['feature-state', 'picked'], false],
              0.42,
              0.16,
            ],
          ],
        },
      });
      m.addLayer({
        id: 'areas-line',
        type: 'line',
        source: 'outlines',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hot'], false],
            3.5,
            ['boolean', ['feature-state', 'picked'], false],
            3,
            2,
          ],
        },
      });
      paint();
      const b = boundsOf(all);
      if (b) m.fitBounds(b, { padding: 28, duration: 0 });

      // Each outline draws itself in, one after another, then fills (P5.4.1).
      // West to east, so the drawing sweeps across the city.
      const reduced = reducedMotion();
      const order = drawOrder(all);
      const start = performance.now();
      const step = () => {
        const ms = performance.now() - start;
        const at = (a: MapArea) => drawnAt(order.get(a.areaId) ?? 0, ms, reduced);
        (m.getSource('outlines') as GeoJSONSource | undefined)?.setData({
          type: 'FeatureCollection',
          features: all.map((a) => ({
            type: 'Feature',
            properties: { areaId: a.areaId },
            geometry: { type: 'LineString', coordinates: outlineUpTo(a.ring, at(a).line) },
          })),
        });
        all.forEach((a) =>
          m.setFeatureState({ source: 'areas', id: a.areaId }, { shown: at(a).fill }),
        );
        if (!reduced && ms < drawingEnds(all.length)) frame = requestAnimationFrame(step);
        else setDrawn(true);
      };
      step();

      m.on('mousemove', 'areas-fill', (e: MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.areaId;
        if (typeof id === 'string') setHover(id);
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', 'areas-fill', () => {
        setHover(undefined);
        m.getCanvas().style.cursor = '';
      });
      m.on('click', (e) => {
        const f = m.queryRenderedFeatures(e.point, { layers: ['areas-fill'] })[0];
        const id = f?.properties?.areaId;
        setChosen(typeof id === 'string' ? id : undefined);
      });
      setReady(true);
    });
    // Light or dark changed (the theme switch, or the device): the map's colours follow.
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    dark.addEventListener('change', paint);
    const watch = new MutationObserver(paint);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    map.current = m;
    return () => {
      cancelAnimationFrame(frame);
      dark.removeEventListener('change', paint);
      watch.disconnect();
      m.remove();
      map.current = null;
    };
  }, [areas, styleUrl]);

  // Highlight and picks, as feature states (no redraw of the shapes).
  useEffect(() => {
    const m = map.current;
    if (!ready || !m) return;
    for (const a of areas) {
      const state = { hot: a.areaId === hot, picked: picked.includes(a.areaId) };
      m.setFeatureState({ source: 'areas', id: a.areaId }, state);
      m.setFeatureState({ source: 'outlines', id: a.areaId }, state);
    }
  }, [ready, areas, hot, picked]);

  const paths = useMemo(() => (noMap ? svgPaths(areas, 600, 420) : []), [noMap, areas]);

  return (
    <div
      className="areas-map"
      data-state={drawn ? 'drawn' : 'drawing'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setChosen(undefined);
          setHover(undefined);
        }
      }}
    >
      <div className="areas-map__frame">
        <div ref={box} className="areas-map__map" role="region" aria-label={label}>
          {noMap && (
            // This computer cannot draw maps (no WebGL): the same shapes, drawn plainly.
            <svg viewBox="0 0 600 420" className="areas-map__svg" aria-hidden="true">
              {paths.map((p) => (
                <path
                  key={p.areaId}
                  d={p.d}
                  className={[
                    picked.includes(p.areaId) ? 'picked' : '',
                    p.areaId === hot ? 'hot' : '',
                  ].join(' ')}
                  onMouseEnter={() => setHover(p.areaId)}
                  onMouseLeave={() => setHover(undefined)}
                  onClick={() => setChosen(p.areaId)}
                />
              ))}
            </svg>
          )}
        </div>
        <div className="areas-map__card rc-card" aria-live="polite">
          {shown ? (
            <>
              <b>{shown.name}</b>
              <span className="muted">
                {sizeText(shown.sqKm)}
                {picked.includes(shown.areaId) ? ' · Picked' : ''}
              </span>
              {onPick && canPick(shown.areaId) && (
                <button
                  type="button"
                  className="rc-button rc-button--small rc-button--secondary"
                  onClick={() => onPick(shown.areaId)}
                >
                  {picked.includes(shown.areaId) ? `Remove ${shown.name}` : `Pick ${shown.name}`}
                </button>
              )}
            </>
          ) : (
            <span className="muted">Tap an area to see its name and size.</span>
          )}
        </div>
      </div>
      <ul className="areas-map__list" aria-label="Our areas">
        {areas.map((a) => (
          <li key={a.areaId}>
            <button
              type="button"
              className={[
                'areas-map__item',
                a.areaId === hot ? 'hot' : '',
                picked.includes(a.areaId) ? 'picked' : '',
              ].join(' ')}
              aria-pressed={chosen === a.areaId}
              onMouseEnter={() => setHover(a.areaId)}
              onMouseLeave={() => setHover(undefined)}
              onFocus={() => setHover(a.areaId)}
              onBlur={() => setHover(undefined)}
              onClick={() => setChosen(chosen === a.areaId ? undefined : a.areaId)}
            >
              <span className="areas-map__swatch" aria-hidden="true" />
              <span className="areas-map__name">{a.name}</span>
              <span className="areas-map__size">{sizeText(a.sqKm)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
