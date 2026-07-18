// Server-side (and locally testable) run validation.
//
// Receive { simVersion, events, tickCount, finalHash, checkpoints } for a
// known daily seed, re-run the sim headless, and compare hashes. Because the
// level derives from the seed on BOTH sides, the client sends no level data —
// there is nothing to tamper with except the input stream itself, and any
// tampering changes the hashes.

import { createSim, step, hashState, scoreOf, MAX_TICKS, SIM_VERSION } from "./sim.ts";
import { makeReplayer, type ReplayEvent } from "./replay.ts";

export const CHECKPOINT_EVERY = 60; // one hash per simulated second

export type Submission = {
  simVersion: number;
  events: ReplayEvent[];
  tickCount: number;
  finalHash: number;
  checkpoints: number[]; // hash after ticks 60, 120, 180...
};

export type ValidationResult =
  | { ok: true; score: number; finishedDead: boolean }
  | { ok: false; reason: string; divergedAtTick?: number };

export function validateRun(seed: number, sub: Submission): ValidationResult {
  // Version gate FIRST: a stale cached client would otherwise fail with a
  // confusing hash mismatch after any sim/level tuning.
  if (sub.simVersion !== SIM_VERSION) {
    return { ok: false, reason: "outdated game version — refresh to update" };
  }

  // Sanity caps BEFORE simulating — cheap rejection of garbage/DoS payloads.
  if (!Number.isInteger(sub.tickCount) || sub.tickCount <= 0 || sub.tickCount > MAX_TICKS) {
    return { ok: false, reason: "tickCount out of range" };
  }
  if (!Array.isArray(sub.events) || sub.events.length > sub.tickCount) {
    return { ok: false, reason: "too many input events" };
  }
  let prevTick = -1;
  for (const e of sub.events) {
    if (
      !Array.isArray(e) ||
      !Number.isInteger(e[0]) ||
      !Number.isInteger(e[1]) ||
      e[0] < 0 ||
      e[0] >= sub.tickCount ||
      e[0] <= prevTick || // strictly increasing: the recorder never emits duplicates
      e[1] < 0 ||
      e[1] > 3
    ) {
      return { ok: false, reason: "malformed event stream" };
    }
    prevTick = e[0];
  }

  const sim = createSim(seed);
  const input = makeReplayer(sub.events);

  for (let t = 0; t < sub.tickCount; t++) {
    step(sim, input.getInput(t));
    const done = t + 1;
    if (done % CHECKPOINT_EVERY === 0) {
      const idx = done / CHECKPOINT_EVERY - 1;
      const expected = sub.checkpoints[idx];
      if (expected !== undefined && expected !== hashState(sim)) {
        // First failing checkpoint pinpoints WHICH second diverged.
        return { ok: false, reason: "checkpoint mismatch", divergedAtTick: done };
      }
    }
  }

  // step() freezes on death (tick stops advancing), so a submission padded
  // with ticks after death would still hash-match. Reject the padding.
  if (sim.tick !== sub.tickCount) {
    return { ok: false, reason: "ticks submitted after death", divergedAtTick: sim.tick };
  }

  if (hashState(sim) !== sub.finalHash) {
    return { ok: false, reason: "final hash mismatch", divergedAtTick: sub.tickCount };
  }

  return { ok: true, score: scoreOf(sim), finishedDead: sim.dead };
}
