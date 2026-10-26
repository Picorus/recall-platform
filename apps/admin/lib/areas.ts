// The Areas page's helpers: corners as text (one "lat, lng" per line: easy to check and paste).

export interface Corner {
  readonly lat: number;
  readonly lng: number;
}

/** "17.448000, 78.391000" per line, 6 decimals (about 10 cm). */
export function cornersText(ring: readonly Corner[]): string {
  return ring.map((p) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`).join('\n');
}

/** Corners from text, or what is wrong (blank lines are skipped). */
export function parseCorners(text: string): { ring: Corner[] } | { problem: string } {
  const ring: Corner[] = [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(line);
    const lat = Number(m?.[1]);
    const lng = Number(m?.[2]);
    if (!m || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return { problem: `Line ${i + 1} is not "latitude, longitude"` };
    ring.push({ lat, lng });
  }
  if (ring.length < 3) return { problem: 'An area needs at least 3 corners' };
  return { ring };
}
