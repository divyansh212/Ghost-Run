#!/usr/bin/env -S node --experimental-strip-types

// Determinism + anti-cheat proof. Run: npm test
//
// 1. Record a bot run, replay it twice → identical hashes at every checkpoint.
// 2. The shared validator ACCEPTS the genuine submission.
// 3. The validator REJECTS tampered inputs, inflated tickCounts, forged
//    hashes, and malformed event streams.
//
// If test 1 ever fails, there is hidden state in the sim (the skill's
// debugging procedure, step 1). If test 3 fails, the leaderboard is cheatable.

import assert from "node:assert/strict";
import { createSim, step, hashState, scoreOf, INPUT, MAX_TICKS, SIM_VERSION } from "../src/shared/sim.ts";
import { makeRecorder, makeReplayer, type ReplayEvent } from "../src/shared/replay.ts";
import { validateRun, CHECKPOINT_EVERY, type Submission } from "../src/shared/validate.ts";
import { mulberry32, dailySeed } from "../src/shared/prng.ts";

const seed = dailySeed("2026-07-04");

// ── bot plays a run with pseudo-random inputs ────────────────────────────────

function playBotRun(botSeed: number): Submission & { score: number } {
  const bot = mulberry32(botSeed); // bot's brain — NOT the sim's rng
  const sim = createSim(seed);
  let held = 0;
  let holdLeft = 0;
  const rec = makeRecorder(() => {
    if (holdLeft-- <= 0) {
      const r = bot.next();
      held = r < 0.25 ? INPUT.JUMP : r < 0.35 ? INPUT.DUCK : 0;
      holdLeft = bot.nextInt(4, 30);
    }
    return held;
  });

  const checkpoints: number[] = [];
  while (!sim.dead && sim.tick < MAX_TICKS) {
    step(sim, rec.getInput(sim.tick));
    if (sim.tick % CHECKPOINT_EVERY === 0) checkpoints.push(hashState(sim));
  }
  return {
    simVersion: SIM_VERSION,
    events: rec.events,
    tickCount: sim.tick,
    finalHash: hashState(sim),
    checkpoints,
    score: scoreOf(sim),
  };
}

function replayHashes(events: ReplayEvent[], tickCount: number): number[] {
  const sim = createSim(seed);
  const input = makeReplayer(events);
  const hashes: number[] = [];
  for (let t = 0; t < tickCount; t++) {
    step(sim, input.getInput(t));
    hashes.push(hashState(sim));
  }
  return hashes;
}

// ── 1. determinism: two replays are bit-identical at EVERY tick ─────────────

const run = playBotRun(0xc0ffee);
assert.ok(run.tickCount > 60, `bot should survive past the first second (got ${run.tickCount} ticks)`);

const a = replayHashes(run.events, run.tickCount);
const b = replayHashes(run.events, run.tickCount);
assert.deepEqual(a, b, "two local replays diverged — hidden state in the sim!");
assert.equal(a[a.length - 1], run.finalHash, "replay does not reproduce the live run");
console.log(`✓ determinism: ${run.tickCount} ticks, ${run.events.length} events, replay is bit-identical (score ${run.score}px)`);

// payload size sanity — must sit comfortably in a Redis value
const bytes = Buffer.byteLength(JSON.stringify(run.events));
assert.ok(bytes < 50_000, `replay too large: ${bytes} bytes`);
console.log(`✓ payload: ${bytes} bytes as JSON`);

// ── 2. validator accepts the genuine run ─────────────────────────────────────

const ok = validateRun(seed, run);
assert.ok(ok.ok, `validator rejected a genuine run: ${!ok.ok ? ok.reason : ""}`);
assert.equal(ok.ok && ok.score, run.score, "server score != client score");
console.log(`✓ validator accepts the genuine run (server-computed score ${run.score}px)`);

// ── 3. validator rejects cheating ────────────────────────────────────────────

// 3a. tampered input stream (claim a jump that never happened)
const tampered: Submission = { ...run, events: run.events.map((e) => [...e] as ReplayEvent) };
tampered.events[Math.floor(tampered.events.length / 2)]![1] ^= INPUT.JUMP;
const r1 = validateRun(seed, tampered);
assert.ok(!r1.ok, "validator accepted tampered inputs");
console.log(`✓ rejects tampered inputs (${!r1.ok ? r1.reason : ""} @tick ${!r1.ok ? r1.divergedAtTick : ""})`);

// 3b. inflated tick count (claim a longer run than played)
const r2 = validateRun(seed, { ...run, tickCount: run.tickCount + 600 });
assert.ok(!r2.ok, "validator accepted an inflated tickCount");
console.log(`✓ rejects inflated tickCount (${!r2.ok ? r2.reason : ""})`);

// 3c. forged final hash
const r3 = validateRun(seed, { ...run, finalHash: (run.finalHash + 1) >>> 0 });
assert.ok(!r3.ok, "validator accepted a forged final hash");
console.log(`✓ rejects forged final hash`);

// 3d. absurd payloads
assert.ok(!validateRun(seed, { ...run, tickCount: MAX_TICKS * 10 }).ok);
assert.ok(!validateRun(seed, { ...run, events: [[-1, 99]] as ReplayEvent[] }).ok);
console.log(`✓ rejects out-of-range tickCount and malformed events`);

// 3e. wrong sim version (stale cached client after a tuning patch)
const r5 = validateRun(seed, { ...run, simVersion: SIM_VERSION - 1 });
assert.ok(!r5.ok, "validator accepted a stale sim version");
console.log(`✓ rejects stale sim versions (${!r5.ok ? r5.reason : ""})`);

// ── 4. wrong-seed cross-check (yesterday's replay can't score today) ─────────

const r4 = validateRun(dailySeed("2026-07-03"), run);
assert.ok(!r4.ok, "a replay from another day's seed validated against today");
console.log(`✓ rejects replays recorded against a different daily seed`);

console.log("\nALL TESTS PASSED — the leaderboard only accepts runs it can reproduce.");
