// P7.1: the messages waiting their turn at the gateway, with limits so no screen, and no flood,
// can push everyone else's out: a share for each screen, a cap on how many and on how many bytes.
// What does not fit is dropped unanswered; its box keeps it and sends it again.

/** Messages waiting beyond this are dropped. */
export const MOST_WAITING = 10_000;
/** Bytes waiting beyond this are dropped (a message is at most a few hundred KB). */
export const MOST_BYTES = 256 * 1024 * 1024;
/** One screen's messages waiting at once: a few uploads and a hello is all a real one has. */
export const MOST_PER_SCREEN = 8;

/** The screen a topic belongs to: recall/v1/s/<screen>/up/<kind>. */
const screenOf = (topic: string) => topic.split('/')[3] ?? '';

export class Waiting {
  private readonly line: [string, Buffer][] = [];
  private readonly perScreen = new Map<string, number>();
  private bytes = 0;

  get length(): number {
    return this.line.length;
  }

  /** Puts a message in line, or says no (it is dropped). */
  add(topic: string, payload: Buffer): boolean {
    const screen = screenOf(topic);
    const mine = this.perScreen.get(screen) ?? 0;
    if (
      this.line.length >= MOST_WAITING ||
      this.bytes + payload.length > MOST_BYTES ||
      mine >= MOST_PER_SCREEN
    )
      return false;
    this.line.push([topic, payload]);
    this.perScreen.set(screen, mine + 1);
    this.bytes += payload.length;
    return true;
  }

  /** The next message, oldest first. */
  next(): [string, Buffer] | undefined {
    const m = this.line.shift();
    if (!m) return undefined;
    const screen = screenOf(m[0]);
    const left = (this.perScreen.get(screen) ?? 1) - 1;
    if (left > 0) this.perScreen.set(screen, left);
    else this.perScreen.delete(screen);
    this.bytes -= m[1].length;
    return m;
  }
}
