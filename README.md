# 👻 Ghost Run

A daily deterministic runner for Reddit (Devvit Web + Phaser). Everyone on the
subreddit gets the **same course from the same daily seed**, races the
**ghost of today's #1 run**, and every score on the leaderboard is
**re-simulated and verified on the server** before it counts.

No screenshots-as-proof. No client-trusted scores. The leaderboard only
accepts runs it can reproduce, bit for bit.

## Why this wins

Most hackathon leaderboard games trust the client: `POST /score {9999999}`.
Ghost Run doesn't send a score at all — it sends the **inputs**
(`[tick, bitmask]` pairs, typically well under 1 KB), and the server replays
them through the exact same simulation module the browser ran. If the replay's
state hashes don't match at every checkpoint, the run is rejected and the
first failing checkpoint pinpoints the divergent second.

The same property powers the headline feature for free: because a replay
reproduces a run *exactly*, the top run of the day plays back as a live
translucent **ghost** racing alongside you — same `step()` function, different
input source, exact by construction.

## Architecture

```
             ┌──────────────── src/shared (the moat) ────────────────┐
             │ sim.ts       pure fixed-timestep sim, integer math    │
             │ level.ts     course = f(daily seed), generated twice  │
             │ replay.ts    recorder / replayer (same interface)     │
             │ validate.ts  re-run + checkpoint hash comparison      │
             │ prng.ts      mulberry32 + FNV-1a (no Math.random)     │
             └──────────────┬───────────────────────┬────────────────┘
                            │                       │
              src/client (Phaser)             src/server (Devvit)
              renders sim state,              /api/init   daily seed, board, ghost
              records inputs,                 /api/submit validate → zAdd → ghost
              runs the ghost sim              Redis: lb:{date}, ghost:{date},
                                                     replay:{date}:{user}
```

The one law (from the ghost-replay skill): **the sim depends only on
(seed, input stream, tick count)**. No `Math.random()`, no `Date.now()`, no
frame delta, no Phaser physics, no transcendental math — positions are
integers in 1/256-px fixed point, so every JS engine produces identical bits.

Phaser is a dumb renderer: a fixed-timestep accumulator drives `sim.step()`
at exactly 60 ticks/sec regardless of display refresh rate, and rendering
interpolates between ticks for smoothness without ever touching sim state.

## Run it

```bash
npm install

# 1. Prove the core claim (determinism + anti-cheat suite)
npm test          # unit: bit-identical replays, rejects 6 tamper classes
npm run test:e2e  # over HTTP: genuine run accepted, tampered run rejected

# 2. Instant browser playtest — no Reddit round-trip
npm run local     # → http://localhost:8080/game.html
                  # (in-memory server with the REAL validator)

# 3. Real Devvit playtest
npm run login
npm run build
npm run dev       # devvit playtest — then open a post in your test subreddit

# 4. Ship
npm run launch
```

Requires Node ≥ 22.6. Before `npm run dev`, create a test subreddit and set
the app name in `devvit.json` if `ghost-run` is taken (0–16 chars).


## v2 — hackathon polish pass

**Gameplay & feel**
- Deterministic **jump buffering** (6 ticks, inside the sim & the state hash) — taps just before landing no longer get eaten.
- **Speed-aware level generation**: all gaps are placed in *ticks of reaction time*, never pixels, so no spacing can fall inside the 41-tick jump arc ("dead zones"). A lookahead solver bot completes the full 5-minute course on 40/40 test seeds.
- New pattern chunks: long slabs, rhythm doubles, block→bar combos, bar tunnels, plus a gentler warm-up.

**Retention & community**
- **Daily scheduled post** (cron `0 0 * * *`, idempotent) + automatic **podium comment** on yesterday's post.
- **Streaks** (consecutive UTC days played) shown in-game.
- **Race anyone**: tap a leaderboard name to race that user's exact best run; "race YOUR best" shortcut when you're not the top ghost.
- Splash shows a live teaser of today's ghost to dethrone.

**Hardening**
- `SIM_VERSION` gate — stale cached clients get "refresh to update", not a hash mismatch; ghosts stay consistent across tuning patches.
- Logged-out users are politely rejected (no more shared "anonymous" identity).
- UTC-rollover submissions return a friendly "new day started" instead of a scary mismatch.
- Request body cap (64 KB), per-user submit rate limit, TTL on replay blobs.
- Failed submits keep the payload and offer one tap-to-retry.

**Look (navy · white · black)**
- Gradient navy sky, two-depth parallax skyline, perspective ground grid.
- Obstacles render as **3D-extruded boxes** (lit top / shaded side); bars are hanging pillars with a glowing white danger edge.
- Procedural ghost character with squash & stretch, drop shadow, wavy hem; the rival ghost is a translucent ice-blue twin.
- Death burst particles, screen shake, flash; WebAudio SFX synthesized in-code (no assets).
- Responsive logical canvas — portrait phones get a tall, legible layout instead of a letterboxed strip.

`devvit.json` (including the scheduler) is validated against the official schema in `@devvit/shared-types`.

## Controls

- **Jump**: SPACE / ↑ / W / tap upper screen (buffered: an early press fires on landing)
- **Duck**: ↓ / S / hold lower third of screen
- White blocks → jump. Navy bars with the glowing white edge → duck.

## What's in v2

- **Sim versioning** — `SIM_VERSION` gates submissions, so tuning patches can't
  silently break cached clients or stored ghosts (`npm test` covers it).
- **Jump buffering** (6 ticks, inside the sim + hash) — touch-friendly feel,
  still bit-exact in replays.
- **Pattern-based level gen** — double blocks, block→bar combos, bar tunnels,
  three bar heights, gentle warm-up; density scales with distance. A reactive
  bot probe over 30 seeds confirms every course stays clearable.
- **Daily scheduler** — cron at 00:00 UTC creates the day's post and comments
  the final podium on yesterday's (idempotent; safe on retries).
- **Race anyone** — every verified PB replay is stored (3-day TTL); tap a
  leaderboard row to race that exact run, or race your own best.
- **Streaks** — consecutive-day counter per user, shown in the UI.
- **Hardened server** — login required to submit (no shared "anonymous"),
  64 KB body cap, per-user submit cooldown, friendly UTC-rollover rejection.
- **New look** — navy/white/black, 3D-extruded obstacles, parallax skyline,
  procedural ghost character with squash & stretch, particles, screen shake,
  WebAudio SFX (no asset files), responsive canvas for portrait phones.

## Anti-cheat model (for the judges)

The client submits `{events, tickCount, finalHash, checkpoints}`. The server:

1. Applies sanity caps (≤5-min runs, events ≤ ticks, bitmask range, monotonic ticks).
2. Regenerates the course from the daily seed — the client never sends level data,
   so there's nothing to tamper with except inputs.
3. Re-simulates every tick, comparing an FNV-1a state hash every 60 ticks.
4. Rejects on the first mismatch (with the divergent tick, which also makes
   desync debugging mechanical), padding after death, forged hashes, or
   replays recorded against a different day's seed.
5. Writes the **server-computed** score to `lb:{date}` via `zAdd`, stores the
   replay blob, and promotes it to `ghost:{date}` if it beats the current top.

The test suite (`npm test`) demonstrates each rejection class.

## Demo script (60 seconds)

1. `npm test` on screen — "two replays, bit-identical at all 194 ticks; six
   cheat classes rejected."
2. Open the post, play a run, die — "verifying run on server…" → rank appears.
3. Play again — the purple ghost of the top run races you in real time.
4. Open devtools, replay the tampered `POST /api/submit` — rejected with the
   exact second of divergence.

## Notes / known trade-offs

- Devvit APIs move fast. Server code follows the current
  `devvit-template-hello-world` (`@devvit/web` 0.13.x, `devvit.json` config
  schema v1). If an API drifted, check https://developers.reddit.com/docs.
- The anti-cheat guarantees a run is *reproducible*, not *human* — a solver
  bot could submit optimal inputs (TAS-style). Beat the robot if you can.
- Top-ghost promotion has a benign read-modify-write race under simultaneous
  submits; worst case the ghost lags one run behind. Fine for a hackathon,
  fixable with a Redis watch/txn later.
- The daily rollover uses UTC. A run submitted across midnight UTC now gets a
  friendly "new day started" response and the client refreshes to the new course.
