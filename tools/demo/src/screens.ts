// The demo's screens: each holds its play key and numbers its reports as a real box does, and signs
// every play. History (plays already made) goes in through the same upload path a box uses.
import { storeUpload } from '@recall/db';
import { playBytes, type AreaVersion, type Numbered, type PlayReport } from '@recall/domain';
import { sign, type KeyObject } from 'node:crypto';
import type pg from 'pg';

export interface DemoScreen {
  readonly screenId: string;
  readonly riderId: string;
  readonly key: KeyObject;
  /** The last report number used. */
  seq: number;
  /** The area it mostly rides in. */
  readonly home: string;
}

/** A point well inside an area (its box, 30% in from each side), slightly different each time. */
export function pointIn(area: AreaVersion, r: number): { latE6: number; lngE6: number } {
  const lats = area.ring.map((p) => p.lat);
  const lngs = area.ring.map((p) => p.lng);
  const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const f = (a: number, b: number, k: number) => a + (b - a) * (0.3 + 0.4 * k);
  return {
    latE6: Math.round(f(s, n, r) * 1e6),
    lngE6: Math.round(f(w, e, (r * 7.13) % 1) * 1e6),
  };
}

/** A signed play, as the box makes it. */
export function signedPlay(
  s: DemoScreen,
  body: Omit<PlayReport, 'sig' | 'kind' | 'keyId'>,
): Numbered {
  s.seq += 1;
  const b: Omit<PlayReport, 'sig'> = { kind: 'play', keyId: 'k1', ...body };
  const sig = sign('sha256', Buffer.from(playBytes(s.screenId, s.seq, b)), {
    key: s.key,
    dsaEncoding: 'der',
  }).toString('base64');
  return { seq: s.seq, at: b.startAt + b.lengthS, report: { ...b, sig } };
}

export interface LinePlays {
  readonly screen: DemoScreen;
  readonly lineId: string;
  readonly area: string;
  readonly startsAt: number;
  readonly ads: readonly string[];
}

/** One screen's plays for one line-hour (a spot every 15 s, a few missed, as on a real road), and
 * its minute summaries. */
export function playsFor(
  x: LinePlays,
): { screen: DemoScreen; startAt: number; make: (a: AreaVersion) => Numbered }[] {
  const out: { screen: DemoScreen; startAt: number; make: (a: AreaVersion) => Numbered }[] = [];
  for (let i = 0; i < 240; i++) {
    // About 205 of 240 spots shown (traffic, a stop with the screen off).
    if ((i * 7 + x.screen.screenId.charCodeAt(5)) % 41 < 6) continue;
    const startAt = x.startsAt + i * 15;
    out.push({
      screen: x.screen,
      startAt,
      make: (area) =>
        signedPlay(x.screen, {
          slot: 'brand',
          ref: x.lineId,
          adId: x.ads[i % Math.max(1, x.ads.length)] ?? 'ad',
          startAt,
          lengthS: 15,
          ...pointIn(area, ((i * 13) % 97) / 97),
          accuracyM: 6,
          place: `inside:${x.area}@${area.version}`,
          people: 2 + ((i * 3) % 9),
        }),
    });
  }
  // And what each minute of the hour held (moving time: his pay's hours; most minutes moving).
  for (let k = 0; k < 60; k++) {
    const minute = x.startsAt + k * 60;
    const moving = 30 + ((k * 11 + x.screen.screenId.charCodeAt(6)) % 31);
    out.push({
      screen: x.screen,
      startAt: minute + 59,
      make: (area) => {
        x.screen.seq += 1;
        const place = `inside:${x.area}@${area.version}`;
        return {
          seq: x.screen.seq,
          at: minute + 60,
          report: {
            kind: 'minute',
            minute,
            secondsAt: { [place]: 60 },
            clockSeconds: moving,
            clockAt: { [place]: moving },
            payClockSeconds: moving,
            movingSeconds: moving,
            distanceM: moving * 7,
            plays: 4,
            people: 10,
          },
        };
      },
    });
  }
  return out;
}

/** Sends the plays already made, screen by screen in time order, as their boxes would have. */
export async function sendHistory(
  pool: pg.Pool,
  plays: readonly { screen: DemoScreen; startAt: number; make: (a: AreaVersion) => Numbered }[],
  areas: readonly AreaVersion[],
  log: (l: string) => void,
): Promise<void> {
  const byScreen = new Map<DemoScreen, typeof plays>();
  for (const p of plays) byScreen.set(p.screen, [...(byScreen.get(p.screen) ?? []), p]);
  let sent = 0;
  const send = async (screen: DemoScreen, list: typeof plays) => {
    const sorted = [...list].sort((a, b) => a.startAt - b.startAt);
    const area = areas.find((a) => a.areaId === screen.home);
    if (!area) return;
    for (let i = 0; i < sorted.length; i += 400) {
      const batch = sorted.slice(i, i + 400).map((p) => p.make(area));
      const first = batch[0];
      const lastAt = batch.at(-1)?.at ?? 0;
      if (!first) continue;
      // Sent a few minutes after the last of them, as a box on a mobile line does.
      await storeUpload(pool, screen.screenId, batch, first.seq, lastAt + 120);
      sent += batch.length;
    }
  };
  // Eight screens at a time (each screen's own uploads in order).
  const all = [...byScreen];
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < all.length) {
        const [screen, list] = all[next++] ?? [];
        if (screen && list) await send(screen, list);
      }
    }),
  );
  log(`  ${sent.toLocaleString('en-IN')} plays and minutes sent`);
}
