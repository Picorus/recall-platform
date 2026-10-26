// The Areas page's helpers: corners as text (one "lat, lng" per line: easy to check and paste) and
// India time for when a change starts.

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

/**
 * A "datetime-local" value read as India time ("2026-11-01T06:00") → UTC ISO
 * ("2026-11-01T00:30:00.000Z"); empty means now (the server's time).
 */
export function indiaToUtc(local: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000).toISOString();
}
