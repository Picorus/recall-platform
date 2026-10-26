'use client';
// Shared map set-up for the admin pages (fleet map, areas): MapLibre with its worker served by this
// site, the design tokens' colours, and a plain map when there is no base style or no WebGL.
import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';

/** Hyderabad, Hitech City. */
export const CENTRE: [number, number] = [78.3772, 17.4435];

/** The design tokens' colours, read from the page (light or dark). */
export function mapColours() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ground: v('--surface-0', '#F4F5F0'),
    areaFill: v('--data-soft', '#E6E8FF'),
    areaLine: v('--data', '#3B47D9'),
    brand: v('--brand', '#C8F54A'),
    data: v('--data', '#3B47D9'),
    stop: v('--stop', '#C2341B'),
    ink: v('--ink', '#0E121B'),
  };
}

/** A map with no outside tiles: our own layers on the page's ground colour. */
function plainStyle(ground: string): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'ground', type: 'background', paint: { 'background-color': ground } }],
  };
}

/** A new map in `box`, or null when this computer cannot draw maps (no WebGL). */
export function newMap(box: HTMLElement, styleUrl: string, zoom = 11.5): maplibregl.Map | null {
  // MapLibre's worker, served by this site (copied at build: scripts/copy-map-worker.mjs).
  maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
  try {
    const m = new maplibregl.Map({
      container: box,
      style: styleUrl || plainStyle(mapColours().ground),
      center: CENTRE,
      zoom,
      attributionControl: styleUrl ? {} : false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    return m;
  } catch {
    return null;
  }
}
