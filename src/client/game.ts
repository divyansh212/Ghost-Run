// Ghost Run — Phaser client.
//
// Architecture:
//   Phaser update(time, delta)  →  accumulator  →  N × sim.step(input)
//   Rendering READS sim state and interpolates; it never writes it.
//   Live play, ghost playback, and server validation all run the same step().
//
// IMPORTANT: no game logic lives in Phaser's delta-driven update. Phaser is a
// dumb renderer over the deterministic sim in ../shared/sim.ts. Everything in
// this file — the 3D-extruded boxes, parallax, particles, shake, audio — is
// cosmetic and can change freely without invalidating replays.

import Phaser from "phaser";
import {
  createSim,
  step,
  hashState,
  scoreOf,
  speedAt,
  TICK_MS,
  INPUT,
  FP,
  SIM_VERSION,
  PLAYER_W,
  PLAYER_H,
  PLAYER_H_DUCK,
  type Sim,
} from "../shared/sim.ts";
import { makeRecorder, makeReplayer, type Recorder, type InputSource } from "../shared/replay.ts";
import { CHECKPOINT_EVERY } from "../shared/validate.ts";
import { mulberry32 } from "../shared/prng.ts";
import { ApiEndpoint } from "../shared/api.ts";
import type {
  GhostBlob,
  InitResponse,
  ReplayResponse,
  SubmitRequest,
  SubmitResponse,
} from "../shared/api.ts";

// ── responsive logical canvas ────────────────────────────────────────────────
// The sim is resolution-independent; only this renderer cares. We pick a
// logical size matching the container's aspect so phones get a tall, legible
// canvas instead of a letterboxed strip.

const W = 880;
const H = Math.round(
  Math.min(1050, Math.max(495, (W * window.innerHeight) / Math.max(1, window.innerWidth))),
);
const GROUND_Y = H - Math.round(H * 0.17);
const PLAYER_SCREEN_X = Math.round(W * 0.16);
const UI = Math.min(1.6, Math.max(1, H / 520)); // font scale for tall/mobile canvases

// ── palette: navy · white · black ───────────────────────────────────────────
const C = {
  skyTop: 0x0d1d3a,
  skyBottom: 0x04070d,
  skylineFar: 0x0a1730,
  skylineNear: 0x102548,
  grid: 0x1b2f55,
  groundLine: 0xf2f6ff,
  blockFront: 0xe9eef9,
  blockTop: 0xffffff,
  blockSide: 0x9fb0cc,
  outline: 0x04070d,
  barFront: 0x132b52,
  barSide: 0x0c1d3a,
  barEdge: 0xf2f6ff,
  player: 0xf5f8ff,
  playerShade: 0xc9d4ea,
  eye: 0x0a1626,
  ghost: 0x9fc6ff,
  textMain: "#f2f6ff",
  textDim: "#8ea2c9",
  textGhost: "#9fc6ff",
  textBad: "#ff8f9f",
} as const;

const BOX_DX = 9; // 3D extrusion offset (up-right)
const BOX_DY = -7;

// ── tiny WebAudio SFX (no assets) ────────────────────────────────────────────

class Sfx {
  private ctx: AudioContext | null = null;
  private ensure(): AudioContext | null {
    try {
      this.ctx ??= new (window.AudioContext ?? (window as never)["webkitAudioContext"])();
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol = 0.1): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  jump(): void { this.tone("square", 340, 560, 0.09); }
  duck(): void { this.tone("triangle", 220, 120, 0.08, 0.08); }
  death(): void { this.tone("sawtooth", 320, 55, 0.4, 0.14); }
  verify(): void { this.tone("sine", 660, 660, 0.09); setTimeout(() => this.tone("sine", 880, 880, 0.14), 90); }
  crowned(): void { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone("sine", f, f, 0.12, 0.09), i * 90)); }
}

// ── render-only particle ─────────────────────────────────────────────────────
type Particle = { x: number; y: number; vx: number; vy: number; life: number; size: number; color: number };

type Phase = "ready" | "running" | "dead";
type SubmitState = "inflight" | "done" | "retry" | "gaveup";

class RunScene extends Phaser.Scene {
  private init!: InitResponse;

  private phase: Phase = "ready";
  private sim!: Sim;
  private recorder!: Recorder;
  private checkpoints: number[] = [];
  private accumulator = 0;

  private ghostSim: Sim | null = null;
  private ghostInput: InputSource | null = null;
  private ghostBlob: GhostBlob | null = null;
  private ghostLabel = "";

  // live input flags (read OUTSIDE the sim, fed in via the recorder's poll)
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private touchJump = false;
  private touchDuck = false;

  // render-only state (never touches the sim)
  private fxRng = mulberry32((Date.now() >>> 0) ^ 0x5f3759df);
  private particles: Particle[] = [];
  private shakeT = 0;
  private flashT = 0;
  private squashT = 0;
  private prevGrounded = true;
  private prevInput = 0;
  private bobPhase = 0;
  private diedAt = 0; // wall-clock; guards accidental instant restarts
  private submitState: SubmitState = "done";
  private pendingPayload: SubmitRequest | null = null;
  private sfx = new Sfx();

  // render objects
  private gfx!: Phaser.GameObjects.Graphics;
  private scoreText!: Phaser.GameObjects.Text;
  private ghostText!: Phaser.GameObjects.Text;
  private titleShadow!: Phaser.GameObjects.Text;
  private centerText!: Phaser.GameObjects.Text;
  private subText!: Phaser.GameObjects.Text;
  private boardTitle!: Phaser.GameObjects.Text;
  private boardRows: Phaser.GameObjects.Text[] = [];
  private streakText!: Phaser.GameObjects.Text;

  constructor() {
    super("run");
  }

  create(data: { init: InitResponse }): void {
    this.init = data.init;
    this.setGhost(this.init.ghost, this.init.ghost ? `today's #1 · u/${this.init.ghost.username}` : "");

    const kb = this.input.keyboard!;
    this.keys = {
      space: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      w: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      s: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
    };

    // touch: top ⅔ of screen = jump, bottom ⅓ = duck (hold)
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.phase !== "running") {
        this.handleMetaTap();
        return;
      }
      if (p.y > H * 0.66) this.touchDuck = true;
      else this.touchJump = true;
    });
    this.input.on("pointerup", () => {
      this.touchJump = false;
      this.touchDuck = false;
    });

    this.gfx = this.add.graphics();

    const mono = "ui-monospace, Menlo, Consolas, monospace";
    this.scoreText = this.add
      .text(W - 18, 16, "", { fontFamily: mono, fontSize: `${Math.round(26 * UI)}px`, color: C.textMain, fontStyle: "bold" })
      .setOrigin(1, 0)
      .setShadow(0, 3, "#04070d", 6, true, true);
    this.ghostText = this.add
      .text(W - 18, 20 + 30 * UI, "", { fontFamily: mono, fontSize: `${Math.round(15 * UI)}px`, color: C.textGhost })
      .setOrigin(1, 0)
      .setShadow(0, 2, "#04070d", 4, true, true);
    this.titleShadow = this.add
      .text(W / 2 + 4, H / 2 - 64 * UI + 5, "", { fontFamily: mono, fontSize: `${Math.round(40 * UI)}px`, color: "#04070d", fontStyle: "bold" })
      .setOrigin(0.5);
    this.centerText = this.add
      .text(W / 2, H / 2 - 64 * UI, "", { fontFamily: mono, fontSize: `${Math.round(40 * UI)}px`, color: C.textMain, fontStyle: "bold", align: "center" })
      .setOrigin(0.5)
      .setShadow(0, 0, "#9fc6ff", 18, false, true);
    this.subText = this.add
      .text(W / 2, H / 2 + 8, "", { fontFamily: mono, fontSize: `${Math.round(16 * UI)}px`, color: C.textDim, align: "center", lineSpacing: 6 })
      .setOrigin(0.5)
      .setShadow(0, 2, "#04070d", 4, true, true);
    this.boardTitle = this.add
      .text(18, 16, "", { fontFamily: mono, fontSize: `${Math.round(14 * UI)}px`, color: C.textDim, fontStyle: "bold" })
      .setShadow(0, 2, "#04070d", 4, true, true);
    this.streakText = this.add
      .text(18, H - 16, "", { fontFamily: mono, fontSize: `${Math.round(14 * UI)}px`, color: C.textGhost })
      .setOrigin(0, 1)
      .setShadow(0, 2, "#04070d", 4, true, true);

    this.showReady();
  }

  // ── ghost selection ────────────────────────────────────────────────────────

  private setGhost(blob: GhostBlob | null, label: string): void {
    this.ghostBlob = blob;
    this.ghostLabel = label;
  }

  private async raceUser(name: string): Promise<void> {
    if (name === this.init.username && this.init.myReplay) {
      this.setGhost(this.init.myReplay, "racing your best");
      this.showReady();
      return;
    }
    try {
      const rsp = await fetch(ApiEndpoint.Replay, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name }),
      });
      const data = (await rsp.json()) as ReplayResponse;
      if (data.ghost) this.setGhost(data.ghost, `racing u/${data.ghost.username}`);
    } catch {
      /* keep current ghost */
    }
    this.showReady();
  }

  // ── phase transitions ──────────────────────────────────────────────────────

  private showReady(): void {
    this.phase = "ready";
    this.resetRun();
    this.titleShadow.setText("GHOST RUN");
    this.centerText.setText("GHOST RUN");
    const ghostLine = this.ghostBlob
      ? `${this.ghostLabel || "today's ghost"} — ${fmt(this.ghostBlob.score)}`
      : "no ghost yet — set the first run of the day";
    const login = this.init.loggedIn ? "" : "\n(log in to Reddit to join the board)";
    this.subText.setColor(C.textDim);
    this.subText.setText(
      `course of ${this.init.dateKey}\n${ghostLine}${login}\n\ntap high = JUMP · hold low = DUCK\n(SPACE / ↓ on keyboard)\n\ntap to start`,
    );
    this.streakText.setText(this.init.streak > 0 ? `🔥 ${this.init.streak}-day streak` : "");
    this.renderBoard(this.init.leaderboard);
  }

  private startRun(): void {
    this.phase = "running";
    this.titleShadow.setText("");
    this.centerText.setText("");
    this.subText.setText("");
    this.clearBoardRows();
    this.boardTitle.setText("");
    this.resetRun();
  }

  private resetRun(): void {
    this.sim = createSim(this.init.seed);
    this.recorder = makeRecorder(() => this.pollInput());
    this.checkpoints = [];
    this.accumulator = 0;
    this.particles = [];
    this.squashT = 0;
    this.prevGrounded = true;
    this.prevInput = 0;
    if (this.ghostBlob) {
      this.ghostSim = createSim(this.init.seed);
      this.ghostInput = makeReplayer(this.ghostBlob.events);
    } else {
      this.ghostSim = null;
      this.ghostInput = null;
    }
  }

  private handleMetaTap(): void {
    if (this.phase === "ready") {
      this.startRun();
      return;
    }
    if (this.phase === "dead") {
      if (Date.now() - this.diedAt < 600) return; // swallow frantic mid-death taps
      if (this.submitState === "inflight") return;
      if (this.submitState === "retry" && this.pendingPayload) {
        void this.submitRun(this.pendingPayload, true);
        return;
      }
      this.showReady();
    }
  }

  private onDeath(): void {
    this.phase = "dead";
    this.diedAt = Date.now();
    this.sfx.death();
    this.spawnDeathBurst();
    this.shakeT = 1;
    this.flashT = 1;

    const score = scoreOf(this.sim);
    this.titleShadow.setText(`${fmt(score)}`);
    this.centerText.setText(`${fmt(score)}`);

    const payload: SubmitRequest = {
      simVersion: SIM_VERSION,
      dateKey: this.init.dateKey,
      events: this.recorder.events,
      tickCount: this.sim.tick,
      finalHash: hashState(this.sim),
      checkpoints: this.checkpoints,
    };
    void this.submitRun(payload, false);
  }

  private async submitRun(payload: SubmitRequest, isRetry: boolean): Promise<void> {
    this.submitState = "inflight";
    this.pendingPayload = payload;
    this.subText.setColor(C.textDim);
    this.subText.setText(isRetry ? "retrying…" : "verifying run on server…");

    try {
      const rsp = await fetch(ApiEndpoint.Submit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await rsp.json()) as SubmitResponse;
      this.submitState = "done";
      this.pendingPayload = null;

      if (data.ok) {
        this.init.streak = data.streak;
        if (data.isNewTopGhost) this.sfx.crowned();
        else this.sfx.verify();
        const lines = [
          `verified ✓  rank #${data.rank}`,
          data.newPersonalBest ? "new personal best!" : "",
          data.isNewTopGhost ? "YOU are today's ghost now 👻" : "",
          "",
          "tap to run again",
        ].filter((l) => l !== "");
        this.subText.setText(lines.join("\n"));
        this.renderBoard(data.leaderboard);
        this.streakText.setText(data.streak > 0 ? `🔥 ${data.streak}-day streak` : "");
        if (data.newPersonalBest) {
          this.init.myReplay = {
            username: this.init.username,
            score: data.score,
            tickCount: payload.tickCount,
            events: payload.events,
          };
        }
        if (data.isNewTopGhost && this.init.myReplay) {
          this.setGhost(this.init.myReplay, "racing your best");
        }
      } else if (data.code === "stale_day") {
        this.subText.setColor(C.textBad);
        this.subText.setText("🌅 a new day started!\nfetching today's course…");
        await this.reloadInit();
      } else if (data.code === "not_logged_in") {
        this.subText.setColor(C.textBad);
        this.subText.setText("log in to Reddit to join the leaderboard\n\ntap to run again");
      } else if (data.code === "rate_limited") {
        this.submitState = "retry";
        this.subText.setText("server is catching its breath —\ntap to retry submit");
      } else {
        this.subText.setColor(C.textBad);
        this.subText.setText(`run rejected: ${data.reason}\ntap to run again`);
      }
    } catch {
      if (isRetry) {
        this.submitState = "gaveup";
        this.subText.setColor(C.textBad);
        this.subText.setText("couldn't reach server — score not saved\ntap to run again");
      } else {
        this.submitState = "retry";
        this.subText.setColor(C.textBad);
        this.subText.setText("couldn't reach server —\ntap to retry submit");
      }
    }
  }

  private async reloadInit(): Promise<void> {
    try {
      const rsp = await fetch(ApiEndpoint.Init);
      this.init = (await rsp.json()) as InitResponse;
      this.setGhost(this.init.ghost, this.init.ghost ? `today's #1 · u/${this.init.ghost.username}` : "");
      this.showReady();
    } catch {
      this.subText.setText("couldn't refresh — reload the post");
    }
  }

  // ── input ─────────────────────────────────────────────────────────────────

  private pollInput(): number {
    let i = 0;
    if (this.keys.space!.isDown || this.keys.up!.isDown || this.keys.w!.isDown || this.touchJump)
      i |= INPUT.JUMP;
    if (this.keys.down!.isDown || this.keys.s!.isDown || this.touchDuck) i |= INPUT.DUCK;
    return i;
  }

  // ── the loop: fixed timestep accumulator ──────────────────────────────────

  override update(_time: number, delta: number): void {
    this.bobPhase += delta / 1000;
    if (this.phase === "ready" || this.phase === "dead") {
      if (Phaser.Input.Keyboard.JustDown(this.keys.space!)) this.handleMetaTap();
      this.decayFx(delta);
      this.draw(0);
      return;
    }

    this.accumulator += delta;
    let ticksThisFrame = 0;
    while (this.accumulator >= TICK_MS && ticksThisFrame < 5) {
      // clamp: tabbed-out browser must not spiral
      const input = this.recorder.getInput(this.sim.tick);
      this.cueSfx(input);
      step(this.sim, input);
      if (this.sim.tick % CHECKPOINT_EVERY === 0) {
        this.checkpoints.push(hashState(this.sim));
      }
      if (this.ghostSim && this.ghostInput && !this.ghostSim.dead) {
        step(this.ghostSim, this.ghostInput.getInput(this.ghostSim.tick));
      }
      this.accumulator -= TICK_MS;
      ticksThisFrame++;
    }
    if (ticksThisFrame === 5) this.accumulator = 0;

    // landing squash (render-only)
    const grounded = this.sim.y === 0 && this.sim.vy === 0;
    if (grounded && !this.prevGrounded) this.squashT = 1;
    this.prevGrounded = grounded;

    if (this.sim.dead) this.onDeath();

    this.decayFx(delta);
    this.draw(this.accumulator / TICK_MS);
  }

  private cueSfx(input: number): void {
    const grounded = this.sim.y === 0 && this.sim.vy === 0;
    const pressedJump = (input & INPUT.JUMP) !== 0 && (this.prevInput & INPUT.JUMP) === 0;
    const pressedDuck = (input & INPUT.DUCK) !== 0 && (this.prevInput & INPUT.DUCK) === 0;
    if (pressedJump && grounded) this.sfx.jump();
    if (pressedDuck && grounded) this.sfx.duck();
    this.prevInput = input;
  }

  private decayFx(delta: number): void {
    this.shakeT = Math.max(0, this.shakeT - delta / 260);
    this.flashT = Math.max(0, this.flashT - delta / 180);
    this.squashT = Math.max(0, this.squashT - delta / 140);
    for (const p of this.particles) {
      p.x += (p.vx * delta) / 1000;
      p.y += (p.vy * delta) / 1000;
      p.vy += (900 * delta) / 1000;
      p.life -= delta / 900;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private spawnDeathBurst(): void {
    const px = PLAYER_SCREEN_X + PLAYER_W / FP / 2;
    const py = GROUND_Y - this.sim.y / FP - PLAYER_H / FP / 2;
    for (let i = 0; i < 30; i++) {
      const a = this.fxRng.next() * Math.PI * 2;
      const v = 120 + this.fxRng.next() * 340;
      this.particles.push({
        x: px,
        y: py,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 160,
        life: 0.7 + this.fxRng.next() * 0.5,
        size: 3 + this.fxRng.next() * 5,
        color: this.fxRng.next() < 0.6 ? C.player : C.ghost,
      });
    }
  }

  // ── rendering (reads sim state; never writes it) ──────────────────────────

  private draw(alpha: number): void {
    const g = this.gfx;
    g.clear();

    // screen shake (render-only)
    const shakeAmp = this.shakeT * 9;
    const ox = shakeAmp ? (this.fxRng.next() - 0.5) * 2 * shakeAmp : 0;
    const oy = shakeAmp ? (this.fxRng.next() - 0.5) * 2 * shakeAmp : 0;

    // sky: navy → black vertical gradient
    g.fillGradientStyle(C.skyTop, C.skyTop, C.skyBottom, C.skyBottom, 1);
    g.fillRect(0, 0, W, H);

    // camera x: interpolate for smoothness — purely cosmetic
    const camX = this.sim.worldX + Math.round(speedAt(this.sim.tick) * alpha);
    const camPx = camX / FP;
    const toScreenX = (worldFp: number) => ox + PLAYER_SCREEN_X + (worldFp - camX) / FP;

    // parallax skylines (two depths of navy silhouettes)
    this.drawSkyline(g, camPx * 0.18, C.skylineFar, GROUND_Y - 120 * UI, 90 * UI, 140);
    this.drawSkyline(g, camPx * 0.4, C.skylineNear, GROUND_Y - 52 * UI, 62 * UI, 90);

    // ground: white edge + receding perspective grid
    g.fillGradientStyle(0x0a1626, 0x0a1626, 0x04070d, 0x04070d, 1);
    g.fillRect(0, GROUND_Y + oy, W, H - GROUND_Y);
    g.lineStyle(3, C.groundLine, 0.9);
    g.lineBetween(0, GROUND_Y + oy, W, GROUND_Y + oy);
    g.lineStyle(1, C.grid, 0.8);
    for (let d = 1; d <= 4; d++) {
      const gy = GROUND_Y + oy + d * d * 5;
      if (gy < H) g.lineBetween(0, gy, W, gy);
    }
    for (let sx = -(camPx % 90); sx < W + 90; sx += 90) {
      // verticals converge slightly toward center for cheap perspective
      const lean = (sx - W / 2) * 0.16;
      g.lineBetween(sx + ox, GROUND_Y + oy, sx + lean + ox, H);
    }

    // speed streaks at high velocity (cosmetic, seeded from world position)
    const spd = speedAt(this.sim.tick) / FP;
    if (this.phase === "running" && spd > 6.5) {
      g.lineStyle(2, 0xf2f6ff, 0.08 + (spd - 6.5) * 0.03);
      for (let i = 0; i < 5; i++) {
        const yy = ((camPx * (i + 3) * 13) % (GROUND_Y - 60)) + 30;
        const xx = W - ((camPx * (2 + i * 1.7)) % (W + 220));
        g.lineBetween(xx, yy, xx + 90 + i * 25, yy);
      }
    }

    // obstacles in the visible window — 3D extruded boxes
    for (let i = Math.max(0, this.sim.nextObs - 4); i < this.sim.obstacles.length; i++) {
      const o = this.sim.obstacles[i]!;
      const sx = toScreenX(o.x);
      if (sx > W + 80) break;
      const wpx = o.w / FP;
      if (sx + wpx < -80) continue;
      if (o.kind === 0) {
        const hpx = o.h / FP;
        this.drawBox3D(g, sx, GROUND_Y + oy - hpx, wpx, hpx, C.blockFront, C.blockTop, C.blockSide);
      } else {
        this.drawBar3D(g, sx, oy, wpx, GROUND_Y + oy - o.h / FP);
      }
    }

    // opponent ghost (translucent, drawn before the player so we overlap it)
    if (this.ghostSim && this.ghostBlob) {
      const gh = (this.ghostSim.ducking ? PLAYER_H_DUCK : PLAYER_H) / FP;
      const gx = toScreenX(this.ghostSim.worldX);
      const gy = GROUND_Y + oy - this.ghostSim.y / FP - gh;
      const alive = !this.ghostSim.dead;
      this.drawGhostBody(g, gx, gy, PLAYER_W / FP, gh, C.ghost, alive ? 0.34 : 0.12, true);

      const deltaM = (this.ghostSim.worldX - this.sim.worldX) >> 8;
      this.ghostText.setText(
        alive
          ? `👻 ${deltaM >= 0 ? "+" : ""}${fmt(deltaM)} · u/${this.ghostBlob.username}`
          : `👻 ghost fell at ${fmt(scoreOf(this.ghostSim))}`,
      );
    } else {
      this.ghostText.setText("");
    }

    // player drop shadow (grounds them in the scene — cheap 3D cue)
    const airFrac = Math.min(1, this.sim.y / FP / 120);
    g.fillStyle(0x000000, 0.4 - airFrac * 0.25);
    g.fillEllipse(
      PLAYER_SCREEN_X + PLAYER_W / FP / 2 + ox,
      GROUND_Y + oy + 7,
      (PLAYER_W / FP) * (1.5 - airFrac * 0.6),
      9 - airFrac * 4,
    );

    // player: little white ghost with squash & stretch
    const rising = this.sim.vy > FP;
    const squash = this.squashT * 0.28;
    const stretch = rising ? 0.12 : 0;
    const baseH = (this.sim.ducking ? PLAYER_H_DUCK : PLAYER_H) / FP;
    const ph = baseH * (1 - squash + stretch);
    const pw = (PLAYER_W / FP) * (1 + squash - stretch);
    const py = GROUND_Y + oy - (this.sim.y + Math.round(this.sim.vy * alpha)) / FP - ph;
    const px = PLAYER_SCREEN_X + ox - (pw - PLAYER_W / FP) / 2;
    this.drawGhostBody(g, px, Math.min(py, GROUND_Y + oy - ph), pw, ph, C.player, this.sim.dead ? 0.5 : 1, false);

    // particles
    for (const p of this.particles) {
      g.fillStyle(p.color, Math.max(0, Math.min(1, p.life)));
      g.fillRect(p.x + ox, p.y + oy, p.size, p.size);
    }

    // death flash
    if (this.flashT > 0) {
      g.fillStyle(0xf2f6ff, this.flashT * 0.28);
      g.fillRect(0, 0, W, H);
    }

    this.scoreText.setText(fmt(scoreOf(this.sim)));
  }

  /** Extruded 3D box: front face + lit top + shaded side, black outline. */
  private drawBox3D(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    front: number,
    top: number,
    side: number,
  ): void {
    // side (right)
    g.fillStyle(side, 1);
    g.fillPoints(
      [
        { x: x + w, y },
        { x: x + w + BOX_DX, y: y + BOX_DY },
        { x: x + w + BOX_DX, y: y + BOX_DY + h },
        { x: x + w, y: y + h },
      ],
      true,
    );
    // top
    g.fillStyle(top, 1);
    g.fillPoints(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w + BOX_DX, y: y + BOX_DY },
        { x: x + BOX_DX, y: y + BOX_DY },
      ],
      true,
    );
    // front
    g.fillStyle(front, 1);
    g.fillRect(x, y, w, h);
    g.lineStyle(2, C.outline, 0.85);
    g.strokeRect(x, y, w, h);
  }

  /** Hanging bar: navy pillar from the sky with a glowing white danger edge. */
  private drawBar3D(g: Phaser.GameObjects.Graphics, x: number, oy: number, w: number, bottom: number): void {
    // side extrusion
    g.fillStyle(C.barSide, 1);
    g.fillPoints(
      [
        { x: x + w, y: oy },
        { x: x + w + BOX_DX, y: oy },
        { x: x + w + BOX_DX, y: bottom + BOX_DY },
        { x: x + w, y: bottom },
      ],
      true,
    );
    // front
    g.fillStyle(C.barFront, 1);
    g.fillRect(x, oy, w, bottom - oy);
    g.lineStyle(2, C.outline, 0.85);
    g.strokeRect(x, oy - 4, w, bottom - oy + 4);
    // glowing bottom edge (the part that kills you)
    g.fillStyle(C.barEdge, 0.25);
    g.fillRect(x - 2, bottom - 7, w + 4, 7);
    g.fillStyle(C.barEdge, 1);
    g.fillRect(x, bottom - 3, w, 3);
  }

  /** Procedural ghost: dome head, wavy hem, eyes. Same body for player & rival. */
  private drawGhostBody(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    color: number,
    alphaV: number,
    isRival: boolean,
  ): void {
    const bob = Math.sin(this.bobPhase * 6 + (isRival ? 2 : 0)) * 1.5;
    const yy = y + (this.phase === "running" ? bob : 0);
    const r = w / 2;
    // body + dome
    g.fillStyle(color, alphaV);
    g.fillRoundedRect(x, yy, w, h - 5, { tl: r, tr: r, bl: 0, br: 0 });
    // wavy hem: three down-pointing scallops
    const hemY = yy + h - 5;
    const third = w / 3;
    for (let i = 0; i < 3; i++) {
      g.fillTriangle(x + i * third, hemY, x + (i + 0.5) * third, hemY + 6, x + (i + 1) * third, hemY);
    }
    // left-side shading strip (cheap volume)
    if (!isRival) {
      g.fillStyle(C.playerShade, alphaV * 0.5);
      g.fillRoundedRect(x, yy, w * 0.3, h - 5, { tl: r, tr: 0, bl: 0, br: 0 });
    }
    // eyes (X-ed out when dead)
    const eyeY = yy + Math.min(16, h * 0.3);
    const e1 = x + w * 0.32;
    const e2 = x + w * 0.68;
    if (!isRival && this.sim.dead) {
      g.lineStyle(2, C.eye, alphaV);
      for (const ex of [e1, e2]) {
        g.lineBetween(ex - 3, eyeY - 3, ex + 3, eyeY + 3);
        g.lineBetween(ex - 3, eyeY + 3, ex + 3, eyeY - 3);
      }
    } else {
      g.fillStyle(C.eye, alphaV);
      g.fillCircle(e1, eyeY, 3);
      g.fillCircle(e2, eyeY, 3);
    }
  }

  /** Rolling navy silhouettes for parallax depth. Deterministic from x-bucket. */
  private drawSkyline(
    g: Phaser.GameObjects.Graphics,
    scrollPx: number,
    color: number,
    baseY: number,
    maxH: number,
    spanPx: number,
  ): void {
    g.fillStyle(color, 1);
    const start = Math.floor(scrollPx / spanPx);
    for (let i = -1; i < W / spanPx + 2; i++) {
      const bucket = start + i;
      // hash the bucket for a stable pseudo-random height/width
      let hsh = (bucket * 2654435761) >>> 0;
      hsh = (hsh ^ (hsh >>> 13)) >>> 0;
      const bh = 24 + (hsh % Math.max(1, Math.round(maxH)));
      const bw = spanPx * (0.55 + ((hsh >>> 8) % 40) / 100);
      const bx = bucket * spanPx - scrollPx;
      g.fillRect(bx, baseY - bh, bw, GROUND_Y - (baseY - bh));
    }
  }

  // ── leaderboard: tappable rows — race anyone on the board ─────────────────

  private clearBoardRows(): void {
    for (const r of this.boardRows) r.destroy();
    this.boardRows = [];
  }

  private renderBoard(rows: { username: string; score: number }[]): void {
    this.clearBoardRows();
    const mono = "ui-monospace, Menlo, Consolas, monospace";
    if (rows.length === 0) {
      this.boardTitle.setText("today's board is empty");
      return;
    }
    this.boardTitle.setText("TODAY — tap a name to race their ghost");
    const lineH = Math.round(19 * UI);
    rows.slice(0, 8).forEach((r, i) => {
      const t = this.add
        .text(18, 20 + 20 * UI + i * lineH, `${String(i + 1).padStart(2)}. ${fmt(r.score).padStart(6)}  u/${r.username}`, {
          fontFamily: mono,
          fontSize: `${Math.round(14 * UI)}px`,
          color: r.username === this.init.username ? "#ffffff" : C.textDim,
        })
        .setShadow(0, 2, "#04070d", 4, true, true)
        .setInteractive({ useHandCursor: true });
      t.on("pointerdown", (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation(); // don't also trigger the start-run tap
        if (this.phase !== "running") void this.raceUser(r.username);
      });
      this.boardRows.push(t);
    });
    // race-your-best shortcut when you're on the board but not the ghost
    if (this.init.myReplay && this.ghostBlob?.username !== this.init.username) {
      const t = this.add
        .text(18, 20 + 20 * UI + Math.min(rows.length, 8) * lineH + 6, `▸ race YOUR best (${fmt(this.init.myReplay.score)})`, {
          fontFamily: mono,
          fontSize: `${Math.round(14 * UI)}px`,
          color: C.textGhost,
        })
        .setShadow(0, 2, "#04070d", 4, true, true)
        .setInteractive({ useHandCursor: true });
      t.on("pointerdown", (_p: Phaser.Input.Pointer, _x: number, _y: number, ev: Phaser.Types.Input.EventData) => {
        ev.stopPropagation();
        if (this.phase !== "running") void this.raceUser(this.init.username);
      });
      this.boardRows.push(t);
    }
  }
}

function fmt(px: number): string {
  return `${(px / 10).toFixed(0)}m`;
}

// ── boot: fetch server-authoritative init, then start Phaser ────────────────

async function boot(): Promise<void> {
  const statusEl = document.getElementById("status");
  let init: InitResponse;
  try {
    const rsp = await fetch(ApiEndpoint.Init);
    if (!rsp.ok) throw new Error(`init failed: ${rsp.status}`);
    init = (await rsp.json()) as InitResponse;
  } catch (err) {
    if (statusEl) statusEl.textContent = "couldn't load today's challenge — refresh to retry";
    console.error(err);
    return;
  }
  statusEl?.remove();

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game-root",
    width: W,
    height: H,
    backgroundColor: "#04070d",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [],
  });
  game.scene.add("run", RunScene, true, { init });
}

void boot();
