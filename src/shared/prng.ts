// Deterministic PRNG + hashing. Integer ops only — identical output in every
// JS engine (browser client, Devvit's Node server). Math.random() is BANNED
// inside the sim; this is the only source of randomness.

export type Prng = {
  next(): number;
  nextInt(min: number, max: number): number;
  getState(): number;
  setState(s: number): void;
};

/** mulberry32 — tiny, fast, fully deterministic across JS engines. */
export function mulberry32(seed: number): Prng {
  let a = seed >>> 0;
  return {
    next(): number {
      // float in [0, 1)
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    nextInt(min: number, max: number): number {
      // inclusive min, exclusive max
      return min + Math.floor(this.next() * (max - min));
    },
    getState(): number {
      return a >>> 0;
    },
    setState(s: number): void {
      a = s >>> 0;
    },
  };
}

/** FNV-1a — used for state checksums and deriving the daily seed from a date string. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Daily seed derived from a UTC date key like "2026-07-04". Same for every player. */
export function dailySeed(dateKey: string): number {
  return fnv1a(`ghost-run:${dateKey}`);
}
