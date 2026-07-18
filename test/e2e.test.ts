#!/usr/bin/env -S node --experimental-strip-types

// HTTP-level end-to-end test: boots a validator endpoint (same shared
// validateRun the Devvit server uses), has a bot play today's seed, and
// submits both a genuine and a tampered run over the wire.
// Run: npm run test:e2e

import http from "node:http";
import assert from "node:assert/strict";
import { createSim, step, hashState, INPUT, MAX_TICKS, SIM_VERSION } from "../src/shared/sim.ts";
import { makeRecorder } from "../src/shared/replay.ts";
import { CHECKPOINT_EVERY, validateRun } from "../src/shared/validate.ts";
import { mulberry32, dailySeed } from "../src/shared/prng.ts";

const dateKey = new Date().toISOString().slice(0, 10);
const seed = dailySeed(dateKey);
const PORT = 8123;

const srv = http.createServer(async (req, rsp) => {
  const chunks: Uint8Array[] = [];
  for await (const c of req) chunks.push(c as Uint8Array);
  const sub = JSON.parse(Buffer.concat(chunks).toString());
  rsp.setHeader("Content-Type", "application/json");
  rsp.end(JSON.stringify(validateRun(seed, sub)));
});
await new Promise<void>((res) => srv.listen(PORT, "127.0.0.1", res));

// bot plays today's actual seed
const sim = createSim(seed);
const bot = mulberry32(42);
let held = 0;
let holdLeft = 0;
const rec = makeRecorder(() => {
  if (holdLeft-- <= 0) {
    const r = bot.next();
    held = r < 0.3 ? INPUT.JUMP : r < 0.4 ? INPUT.DUCK : 0;
    holdLeft = bot.nextInt(4, 25);
  }
  return held;
});
const checkpoints: number[] = [];
while (!sim.dead && sim.tick < MAX_TICKS) {
  step(sim, rec.getInput(sim.tick));
  if (sim.tick % CHECKPOINT_EVERY === 0) checkpoints.push(hashState(sim));
}
const payload = {
  simVersion: SIM_VERSION,
  events: rec.events,
  tickCount: sim.tick,
  finalHash: hashState(sim),
  checkpoints,
};

async function post(p: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/submit`, {
    method: "POST",
    body: JSON.stringify(p),
  });
  return r.json();
}

const genuine = await post(payload);
assert.ok(genuine.ok, `genuine run rejected over HTTP: ${genuine.reason}`);
console.log(`✓ genuine run verified over HTTP — server score ${genuine.score}px (${payload.tickCount} ticks)`);

payload.events[2]![1] ^= INPUT.JUMP; // flip one input bit
const tampered = await post(payload);
assert.ok(!tampered.ok, "tampered run was accepted!");
console.log(`✓ tampered run rejected over HTTP — ${tampered.reason} @tick ${tampered.divergedAtTick}`);

srv.close();
console.log("\nE2E PASSED");
