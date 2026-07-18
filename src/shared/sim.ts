// ─────────────────────────────────────────────────────────────────────────────
// Ghost Run deterministic simulation.
//
// THE ONE LAW: the sim depends ONLY on (seed, input stream, tick count).
// No Date.now(), no performance.now(), no Math.random(), no frame delta,
// no Phaser, no DOM. The tick counter IS the clock.
//
// This exact module runs in the browser (live play + ghost playback) and on
// the Devvit server (validation). Same step() everywhere = replays are exact
// by construction.
//
// All positions/velocities are integers in 1/256-pixel fixed point. Only
// + - * / >> on integers — bit-identical in every JS engine, no
// transcendental functions anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { mulberry32, fnv1a, type Prng } from "./prng.ts";
import { generateLevel, FP, type Obstacle } from "./level.ts";

export { FP };

// Bump this whenever ANY sim-affecting constant or rule changes (physics,
// level generation, buffering). The server rejects submissions from other
// versions, so stale cached clients fail with a clear "refresh" message
// instead of a mysterious hash mismatch — and stored ghosts stay consistent.
export const SIM_VERSION = 2;

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_TICKS = TICK_RATE * 300; // 5-minute run cap (validator enforces)

// Input bitmask
export const INPUT = { JUMP: 1, DUCK: 2 } as const;

// Physics constants (fixed-point)
const GRAVITY = Math.round(0.45 * FP);
const JUMP_V = Math.round(9.2 * FP);
const SPEED_BASE = Math.round(4.0 * FP);
const SPEED_MAX = Math.round(9.5 * FP);
const SPEED_STEP = Math.round(0.25 * FP); // gained every 256 ticks (~4.3s)

// Jump input buffering: a JUMP pressed while airborne is honoured if the
// player lands within this many ticks. Lives INSIDE the sim (and inside the
// state hash) so buffered jumps replay exactly.
export const JUMP_BUFFER_TICKS = 6;

// Player hitbox (fixed-point)
export const PLAYER_W = 24 * FP;
export const PLAYER_H = 56 * FP;
export const PLAYER_H_DUCK = 28 * FP;

export type Sim = {
  tick: number;
  rng: Prng; // owned by the sim; hashed as part of state
  worldX: number; // player's absolute x (left edge), fp — this is also the score
  y: number; // feet height above ground, fp (0 = grounded)
  vy: number; // vertical velocity, fp (positive = up)
  ducking: boolean;
  dead: boolean;
  jumpBuf: number; // ticks remaining on a buffered airborne jump press
  obstacles: Obstacle[]; // static, derived from seed — NOT hashed
  nextObs: number; // index of first obstacle not yet fully behind the player
};

export function createSim(seed: number): Sim {
  return {
    tick: 0,
    rng: mulberry32(seed),
    worldX: 0,
    y: 0,
    vy: 0,
    ducking: false,
    dead: false,
    jumpBuf: 0,
    obstacles: generateLevel(seed),
    nextObs: 0,
  };
}

/** Current horizontal speed — a pure function of tick (integer schedule). */
export function speedAt(tick: number): number {
  const s = SPEED_BASE + (tick >> 8) * SPEED_STEP;
  return s < SPEED_MAX ? s : SPEED_MAX;
}

/**
 * Advance the sim one tick. Pure function of (state, input).
 * Convention: input recorded at tick N is applied DURING tick N — the recorder
 * and the replayer both follow this (see replay.ts).
 */
export function step(sim: Sim, input: number): void {
  if (sim.dead || sim.tick >= MAX_TICKS) return;

  const grounded = sim.y === 0 && sim.vy === 0;
  const wantJump = (input & INPUT.JUMP) !== 0;

  // 1. Input → intent (with deterministic jump buffering)
  sim.ducking = grounded && (input & INPUT.DUCK) !== 0;
  if (!grounded && wantJump) {
    sim.jumpBuf = JUMP_BUFFER_TICKS; // remember the press until we land
  }
  if (grounded && !sim.ducking && (wantJump || sim.jumpBuf > 0)) {
    sim.vy = JUMP_V;
    sim.jumpBuf = 0;
  } else if (sim.jumpBuf > 0) {
    sim.jumpBuf -= 1;
  }

  // 2. Physics — integer math only
  if (!(sim.y === 0 && sim.vy === 0) || sim.vy > 0) {
    sim.vy -= GRAVITY;
    sim.y += sim.vy;
    if (sim.y <= 0) {
      sim.y = 0;
      sim.vy = 0;
    }
  }
  sim.worldX += speedAt(sim.tick);

  // 3. Collisions — array walk in index order (deterministic resolution order)
  const px0 = sim.worldX;
  const px1 = sim.worldX + PLAYER_W;
  const ph = sim.ducking ? PLAYER_H_DUCK : PLAYER_H;
  const obs = sim.obstacles;

  // advance the window past obstacles fully behind us
  while (sim.nextObs < obs.length && obs[sim.nextObs]!.x + obs[sim.nextObs]!.w < px0) {
    sim.nextObs++;
  }
  for (let i = sim.nextObs; i < obs.length; i++) {
    const o = obs[i]!;
    if (o.x > px1) break; // sorted by x — nothing further can overlap
    const overlapX = px0 < o.x + o.w && px1 > o.x;
    if (!overlapX) continue;
    if (o.kind === 0) {
      // ground block: hit if feet below block top
      if (sim.y < o.h) sim.dead = true;
    } else {
      // hanging bar: hit if head above bar bottom
      if (sim.y + ph > o.h) sim.dead = true;
    }
  }

  sim.tick += 1;
}

/** Score in whole pixels travelled (integer — safe to compare across engines). */
export function scoreOf(sim: Sim): number {
  return sim.worldX >> 8;
}

/**
 * State checksum. Serialize in FIXED field order, integers only.
 * Obstacles are excluded — they're a pure function of the seed and never mutate.
 */
export function hashState(sim: Sim): number {
  return fnv1a(
    [
      sim.tick,
      sim.worldX,
      sim.y,
      sim.vy,
      sim.ducking ? 1 : 0,
      sim.dead ? 1 : 0,
      sim.jumpBuf,
      sim.nextObs,
      sim.rng.getState(),
    ].join("|"),
  );
}
