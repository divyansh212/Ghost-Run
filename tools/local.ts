#!/usr/bin/env -S node --experimental-strip-types

// Local playtest harness. Serves public/ and mocks the Devvit server API with
// an in-memory store — including REAL server-side validation via the shared
// validator. This gives an instant browser dev loop (no `devvit playtest`,
// no Reddit round-trip) while exercising the exact same sim + validate code
// the production server runs.
//
//   npm run local   →   http://localhost:8080/game.html

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { dailySeed } from "../src/shared/prng.ts";
import { validateRun } from "../src/shared/validate.ts";
import type { GhostBlob, InitResponse, ReplayResponse, SubmitRequest, SubmitResponse } from "../src/shared/api.ts";

const PORT = 8080;
const PUBLIC = path.resolve(import.meta.dirname, "../public");

// in-memory "redis"
const scores = new Map<string, number>();
const replays = new Map<string, GhostBlob>();
let topGhost: GhostBlob | null = null;
let streak = 0;
const USER = "local-dev";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
};

function dateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function leaderboard() {
  return [...scores.entries()]
    .map(([username, score]) => ({ username, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

const server = http.createServer(async (req, rsp) => {
  const url = (req.url ?? "/").split("?")[0]!;
  const json = (body: unknown) => {
    rsp.writeHead(200, { "Content-Type": "application/json" });
    rsp.end(JSON.stringify(body));
  };
  const readBody = async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of req) chunks.push(c as Uint8Array);
    return JSON.parse(Buffer.concat(chunks).toString());
  };

  if (url === "/api/init") {
    const body: InitResponse = {
      type: "init",
      postId: "local",
      username: USER,
      loggedIn: true,
      dateKey: dateKey(),
      seed: dailySeed(dateKey()),
      personalBest: scores.get(USER) ?? 0,
      streak,
      leaderboard: leaderboard(),
      ghost: topGhost,
      myReplay: replays.get(USER) ?? null,
    };
    json(body);
    return;
  }

  if (url === "/api/replay") {
    const { username } = (await readBody()) as { username: string };
    const body: ReplayResponse = { type: "replay", ghost: replays.get(username) ?? null };
    json(body);
    return;
  }

  if (url === "/api/submit") {
    const sub = (await readBody()) as SubmitRequest;

    if (sub.dateKey !== dateKey()) {
      json({ type: "submit", ok: false, code: "stale_day", reason: "a new day started — refresh for today's course" } satisfies SubmitResponse);
      return;
    }
    const result = validateRun(dailySeed(dateKey()), sub);
    let body: SubmitResponse;
    if (!result.ok) {
      console.log(`✗ rejected: ${result.reason} @tick ${result.divergedAtTick ?? "?"}`);
      body = { type: "submit", ok: false, code: "invalid", reason: result.reason };
    } else {
      const prev = scores.get(USER) ?? -1;
      const newPB = result.score > prev;
      streak = Math.max(streak, 1);
      if (newPB) {
        scores.set(USER, result.score);
        replays.set(USER, { username: USER, score: result.score, tickCount: sub.tickCount, events: sub.events });
      }
      let isNewTopGhost = false;
      if (newPB && result.score > (topGhost?.score ?? -1)) {
        topGhost = replays.get(USER)!;
        isNewTopGhost = true;
      }
      console.log(`✓ verified run: ${result.score}px, ${sub.tickCount} ticks, ${sub.events.length} input events`);
      body = {
        type: "submit",
        ok: true,
        score: result.score,
        rank: leaderboard().findIndex((r) => r.username === USER) + 1,
        streak,
        newPersonalBest: newPB,
        isNewTopGhost,
        leaderboard: leaderboard(),
      };
    }
    json(body);
    return;
  }

  // static files
  const file = path.join(PUBLIC, url === "/" ? "game.html" : url);
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    rsp.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    rsp.end(fs.readFileSync(file));
    return;
  }
  rsp.writeHead(404);
  rsp.end("not found");
});

server.listen(PORT, () => {
  console.log(`Ghost Run local playtest → http://localhost:${PORT}/game.html`);
  console.log(`(run "npm run build" or "npm run watch" first so public/game.js exists)`);
});
