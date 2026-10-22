// A small seeded random number generator, so every simulation can be repeated exactly (P1.4.7).

export interface Rng {
  /** A number in [0, 1). */
  next(): number;
  /** A whole number in [min, max]. */
  int(min: number, max: number): number;
  /** A number in [min, max). */
  between(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** A normal (bell-curve) number with mean 0 and spread `sd`. */
  normal(sd: number): number;
}

/** mulberry32: fast, good enough for simulation, fully determined by the seed. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    between: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    normal: (sd) => {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()) * sd;
    },
  };
}
