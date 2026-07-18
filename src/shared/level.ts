// Deterministic level generation. The obstacle course is a pure function of
// the daily seed — the client and the server independently generate the exact
// same layout, so the client never sends level data (nothing to tamper with).
//
// v2: pattern-based generation with SPEED-AWARE spacing. The jump arc is a
// fixed ~41 ticks, so jump LENGTH grows with speed (164 px early → 388 px at
// max). Any pattern whose internal spacing is a fixed pixel count therefore
// has a "dead zone" at some speed where you can neither land inside the gap
// nor clear the whole thing. Instead, the generator inverts the sim's speed
// schedule to know how fast the player will be moving when they ARRIVE at
// each pattern, and spaces the pattern in units of jump length at that speed.
//
// Integer math only (integer sqrt included) — bit-identical on every engine.

import { mulberry32, type Prng } from "./prng.ts";

export const FP = 256;

export type ObstacleKind = 0 | 1; // 0 = block (jump over), 1 = bar (duck under)

export type Obstacle = {
  kind: ObstacleKind;
  x: number; // world x of left edge, fixed-point
  w: number; // width, fixed-point
  h: number; // block: height from ground. bar: bottom edge height (duck under it). fixed-point
};

// ── speed schedule inversion ─────────────────────────────────────────────────
// Sim: speed(tick) = 4 + 0.25 * (tick >> 8) px/tick, capped at 9.5.
// Smooth approximation: distance(t) ≈ 4t + t²/2048 px (exact enough for
// spacing decisions; we add safety margins on top).

function isqrt(n: number): number {
  if (n < 2) return n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

/** Approximate tick at which the player reaches `px` pixels. */
function tickAtDistance(px: number): number {
  // t = -4096 + sqrt(4096² * ... ) reduced: t = -4096 + isqrt(16_777_216 + 2048·px)
  return Math.max(0, -4096 + isqrt(16_777_216 + 2048 * px));
}

/** Speed in whole-ish px/tick when the player arrives at `px` (integer ×4). */
function speed4At(px: number): number {
  // return speed multiplied by 4 to stay integer (4.0 → 16, 9.5 → 38)
  const t = tickAtDistance(px);
  const s4 = 16 + (t >> 8); // 4·(4 + 0.25·(t>>8))
  return s4 > 38 ? 38 : s4;
}

/** n ticks of travel at the arrival speed for `px`, in pixels (integer). */
function ticksToPx(px: number, ticks: number): number {
  return (speed4At(px) * ticks) >> 2;
}

// Jump airtime is ~41 ticks (v=9.2, g=0.45). The arc is above 46 px between
// roughly ticks 6 and 35. Constants below are conservative around that.
const JUMP_TICKS = 41;

// ── level constants ──────────────────────────────────────────────────────────
// Inter-chunk gaps are measured in TICKS (i.e. reaction time), not pixels:
// a fixed pixel gap eventually falls inside the 41-tick jump arc as speed
// grows, creating an unclearable dead zone between two blocks. Keeping every
// gap above the arc (48+ ticks) guarantees land-then-rejump always works,
// and difficulty comes from shrinking *time* between obstacles — the metric
// that actually matters for reactions.
const START_GAP_PX = 460;
const BASE_GAP_TICKS = 80; // ~1.3 s between chunks early on
const MIN_GAP_TICKS = 48; // late game: still > the 41-tick jump arc
const GAP_JITTER_TICKS = 26;
const WARMUP_CHUNKS = 8;
const COURSE_LENGTH_PX = 185_000; // > max reachable distance in a 5-min run

const BLOCK_WIDTHS_PX = [22, 26, 34];
const BLOCK_HEIGHTS_PX = [28, 36, 46];
// Bar bottoms: ducking height (28) clears all of these; standing (56) hits all.
const BAR_BOTTOMS_PX = [36, 42, 48];
const BAR_WIDTH_PX = 46;

function block(rng: Prng, xPx: number, maxH = 46): Obstacle {
  const w = BLOCK_WIDTHS_PX[rng.nextInt(0, BLOCK_WIDTHS_PX.length)]!;
  let h = BLOCK_HEIGHTS_PX[rng.nextInt(0, BLOCK_HEIGHTS_PX.length)]!;
  if (h > maxH) h = maxH;
  return { kind: 0, x: xPx * FP, w: w * FP, h: h * FP };
}

function bar(rng: Prng, xPx: number, wPx = BAR_WIDTH_PX): Obstacle {
  const h = BAR_BOTTOMS_PX[rng.nextInt(0, BAR_BOTTOMS_PX.length)]!;
  return { kind: 1, x: xPx * FP, w: wPx * FP, h: h * FP };
}

/**
 * Generate the full obstacle list for a seed. Uses its OWN PRNG instance —
 * it never touches the sim's PRNG, so cosmetic randomness elsewhere can never
 * shift the level.
 */
export function generateLevel(seed: number): Obstacle[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const obstacles: Obstacle[] = [];
  let cursor = START_GAP_PX;
  let chunk = 0;

  while (cursor < COURSE_LENGTH_PX) {
    // Reaction window tightens with elapsed play TIME (via the inverted
    // speed schedule), never dipping into the jump arc.
    const elapsed = tickAtDistance(cursor);
    const shrink = Math.min(BASE_GAP_TICKS - MIN_GAP_TICKS, (elapsed / 220) | 0);
    const gapTicks = BASE_GAP_TICKS - shrink + rng.nextInt(0, GAP_JITTER_TICKS);
    cursor += ticksToPx(cursor, gapTicks);

    if (chunk < WARMUP_CHUNKS) {
      // Warm-up: low singles only, judge-survivable.
      const o = block(rng, cursor, 36);
      obstacles.push(o);
      cursor += o.w / FP;
      chunk++;
      continue;
    }

    const roll = rng.next();
    if (roll < 0.3) {
      // single block
      const o = block(rng, cursor);
      obstacles.push(o);
      cursor += o.w / FP;
    } else if (roll < 0.52) {
      // single bar
      const o = bar(rng, cursor);
      obstacles.push(o);
      cursor += o.w / FP;
    } else if (roll < 0.66) {
      // LONG block: one wide low slab — a well-timed full jump clears it.
      // Usable high-arc span is ~29 ticks of travel; use at most half of it.
      const w = Math.min(96, ticksToPx(cursor, 14));
      obstacles.push({ kind: 0, x: cursor * FP, w: w * FP, h: 28 * FP });
      cursor += w;
    } else if (roll < 0.82) {
      // rhythm doubles: two blocks spaced ONE FULL JUMP apart at arrival
      // speed (+4-tick margin), so "jump… land… jump" always works.
      const a = block(rng, cursor);
      obstacles.push(a);
      cursor += a.w / FP + ticksToPx(cursor, JUMP_TICKS + 4);
      const b = block(rng, cursor, 36);
      obstacles.push(b);
      cursor += b.w / FP;
    } else if (roll < 0.92) {
      // block → bar: even a latest-possible landing leaves ≥6 ticks to duck.
      const a = block(rng, cursor, 36);
      obstacles.push(a);
      cursor += a.w / FP + ticksToPx(cursor, JUMP_TICKS + 6);
      const b = bar(rng, cursor);
      obstacles.push(b);
      cursor += b.w / FP;
    } else {
      // bar tunnel: two bars close together — stay ducked through both.
      const a = bar(rng, cursor);
      obstacles.push(a);
      cursor += a.w / FP + 190;
      const b = bar(rng, cursor, 58);
      obstacles.push(b);
      cursor += b.w / FP;
    }
    chunk++;
  }
  return obstacles;
}
