// Ghost Run — Devvit server.
//
// Endpoints:
//   POST/GET /api/init    → daily seed, personal best, streak, board, ghosts
//   POST     /api/submit  → validate replay server-side, then write score
//   POST     /api/replay  → fetch a named user's best replay today (race them)
//   /internal/*           → menu item, install trigger, daily post cron
//
// The critical property: a score ONLY reaches the leaderboard after the replay
// has been re-simulated here (see shared/validate.ts). The client's claimed
// score is never trusted — the score is whatever the server's re-run produces.

import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis } from "@devvit/web/server";
import type { TriggerResponse, UiResponse } from "@devvit/web/shared";

import { ApiEndpoint } from "../shared/api.ts";
import type {
  GhostBlob,
  InitResponse,
  LeaderboardRow,
  ReplayRequest,
  ReplayResponse,
  SubmitRequest,
  SubmitResponse,
} from "../shared/api.ts";
import { dailySeed } from "../shared/prng.ts";
import { validateRun } from "../shared/validate.ts";

const MAX_BODY_BYTES = 64 * 1024; // real payloads are <1 KB; cap the rest
const SUBMIT_COOLDOWN_S = 2; // per-user rate limit on /api/submit
const REPLAY_TTL_S = 3 * 24 * 60 * 60; // keep replays 3 days, then let Redis reap

// ── request routing ──────────────────────────────────────────────────────────

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON(500, { error: msg, status: 500 }, rsp);
  }
}

async function onRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  const url = (req.url ?? "").split("?")[0];
  switch (url) {
    case ApiEndpoint.Init:
      writeJSON(200, await onInit(), rsp);
      return;
    case ApiEndpoint.Submit:
      writeJSON(200, await onSubmit(req), rsp);
      return;
    case ApiEndpoint.Replay:
      writeJSON(200, await onReplay(req), rsp);
      return;
    case ApiEndpoint.OnPostCreate:
      writeJSON(200, await onMenuNewPost(), rsp);
      return;
    case ApiEndpoint.OnAppInstall:
      writeJSON(200, await onAppInstall(), rsp);
      return;
    case ApiEndpoint.DailyPost:
      writeJSON(200, await onDailyPost(), rsp);
      return;
    default:
      writeJSON(404, { error: "not found", status: 404 }, rsp);
  }
}

// ── keys & helpers ───────────────────────────────────────────────────────────

function utcDateKey(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}
const lbKey = (d: string) => `lb:${d}`;
const ghostKey = (d: string) => `ghost:${d}`;
const replayKey = (d: string, u: string) => `replay:${d}:${u}`;
const streakKey = (u: string) => `streak:${u}`;
const postKey = (d: string) => `post:${d}`;
const rateKey = (u: string) => `rl:${u}`;

/** Logged-in username, or null. Never coalesce to a shared fake identity. */
function username(): string | null {
  return context.username ?? null;
}

async function topRows(dateKey: string, n = 10): Promise<LeaderboardRow[]> {
  const entries = await redis.zRange(lbKey(dateKey), 0, n - 1, {
    by: "rank",
    reverse: true,
  });
  return entries.map((e) => ({ username: e.member, score: e.score }));
}

async function getBlob(key: string): Promise<GhostBlob | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GhostBlob;
  } catch {
    return null;
  }
}

type StreakRecord = { count: number; last: string };

async function getStreak(user: string | null): Promise<StreakRecord> {
  if (!user) return { count: 0, last: "" };
  const raw = await redis.get(streakKey(user));
  if (!raw) return { count: 0, last: "" };
  try {
    return JSON.parse(raw) as StreakRecord;
  } catch {
    return { count: 0, last: "" };
  }
}

/** Called on a user's first valid run of the day. Returns the updated streak. */
async function bumpStreak(user: string, today: string): Promise<number> {
  const s = await getStreak(user);
  if (s.last === today) return s.count; // already counted today
  const next: StreakRecord = {
    count: s.last === utcDateKey(-1) ? s.count + 1 : 1,
    last: today,
  };
  await redis.set(streakKey(user), JSON.stringify(next));
  return next.count;
}

// ── /api/init ────────────────────────────────────────────────────────────────

async function onInit(): Promise<InitResponse> {
  const dateKey = utcDateKey();
  const user = username();

  const [pb, leaderboard, ghost, myReplay, streak] = await Promise.all([
    user ? redis.zScore(lbKey(dateKey), user) : Promise.resolve(undefined),
    topRows(dateKey),
    getBlob(ghostKey(dateKey)),
    user ? getBlob(replayKey(dateKey, user)) : Promise.resolve(null),
    getStreak(user),
  ]);

  return {
    type: "init",
    postId: context.postId ?? "",
    username: user ?? "runner",
    loggedIn: user !== null,
    dateKey,
    seed: dailySeed(dateKey),
    personalBest: pb ?? 0,
    streak: streak.last === dateKey ? streak.count : streak.last === utcDateKey(-1) ? streak.count : 0,
    leaderboard,
    ghost,
    myReplay,
  };
}

// ── /api/submit ──────────────────────────────────────────────────────────────

async function onSubmit(req: IncomingMessage): Promise<SubmitResponse> {
  const dateKey = utcDateKey();
  const user = username();

  if (!user) {
    return {
      type: "submit",
      ok: false,
      code: "not_logged_in",
      reason: "log in to Reddit to join the leaderboard",
    };
  }

  // Per-user rate limit: 1 submit per cooldown window.
  const hits = await redis.incrBy(rateKey(user), 1);
  if (hits === 1) await redis.expire(rateKey(user), SUBMIT_COOLDOWN_S);
  if (hits > 1) {
    return { type: "submit", ok: false, code: "rate_limited", reason: "too fast — try again in a moment" };
  }

  let body: SubmitRequest;
  try {
    body = await readJSON<SubmitRequest>(req);
  } catch (err) {
    const reason = err instanceof BodyTooLarge ? "payload too large" : "bad request body";
    return { type: "submit", ok: false, code: "invalid", reason };
  }

  // UTC rollover: a run started yesterday can't score today — say so nicely.
  if (body.dateKey !== dateKey) {
    return {
      type: "submit",
      ok: false,
      code: "stale_day",
      reason: "a new day started — refresh for today's course",
    };
  }

  // Re-simulate the run. The score comes from OUR simulation, not the client.
  const result = validateRun(dailySeed(dateKey), {
    simVersion: body.simVersion,
    events: body.events,
    tickCount: body.tickCount,
    finalHash: body.finalHash,
    checkpoints: body.checkpoints ?? [],
  });

  if (!result.ok) {
    console.warn(
      `rejected run from ${user}: ${result.reason}` +
        (result.divergedAtTick ? ` @tick ${result.divergedAtTick}` : ""),
    );
    return { type: "submit", ok: false, code: "invalid", reason: result.reason };
  }

  const score = result.score;
  const key = lbKey(dateKey);
  const prev = await redis.zScore(key, user);
  const newPersonalBest = prev === undefined || prev === null || score > prev;
  const streak = await bumpStreak(user, dateKey);

  let isNewTopGhost = false;
  if (newPersonalBest) {
    await redis.zAdd(key, { member: user, score });
    // keep the raw replay so anyone can race this exact run later
    const blob: GhostBlob = {
      username: user,
      score,
      tickCount: body.tickCount,
      events: body.events,
    };
    const rKey = replayKey(dateKey, user);
    await redis.set(rKey, JSON.stringify(blob));
    await redis.expire(rKey, REPLAY_TTL_S);

    // promote to today's ghost if it beats the current top
    const currentTop = await getBlob(ghostKey(dateKey));
    if (score > (currentTop?.score ?? -1)) {
      await redis.set(ghostKey(dateKey), JSON.stringify(blob));
      isNewTopGhost = true;
    }
  }

  // 1-based rank (zRange is ascending; rank from the top)
  const [card, rankAsc] = await Promise.all([redis.zCard(key), redis.zRank(key, user)]);
  const rank = rankAsc === undefined || rankAsc === null ? 1 : card - rankAsc;

  return {
    type: "submit",
    ok: true,
    score,
    rank,
    streak,
    newPersonalBest,
    isNewTopGhost,
    leaderboard: await topRows(dateKey),
  };
}

// ── /api/replay — fetch a named user's best run today (to race them) ────────

async function onReplay(req: IncomingMessage): Promise<ReplayResponse> {
  let body: ReplayRequest;
  try {
    body = await readJSON<ReplayRequest>(req);
  } catch {
    return { type: "replay", ghost: null };
  }
  if (typeof body.username !== "string" || body.username.length === 0 || body.username.length > 64) {
    return { type: "replay", ghost: null };
  }
  return { type: "replay", ghost: await getBlob(replayKey(utcDateKey(), body.username)) };
}

// ── daily post (scheduler cron @ 00:00 UTC) ─────────────────────────────────

function postTitle(dateKey: string): string {
  return `👻 Ghost Run — ${dateKey} — new course is live`;
}

async function createDailyPost(dateKey: string): Promise<string> {
  const post = await reddit.submitCustomPost({ title: postTitle(dateKey) });
  await redis.set(postKey(dateKey), post.id);
  return post.url;
}

async function onDailyPost(): Promise<Record<string, never>> {
  const today = utcDateKey();
  const yesterday = utcDateKey(-1);

  // Idempotent: cron retries or double-fires must not spam posts.
  const existing = await redis.get(postKey(today));
  if (!existing) {
    await createDailyPost(today);
  }

  // Comment yesterday's podium on yesterday's post — closes the daily loop.
  try {
    const yPost = await redis.get(postKey(yesterday));
    const done = await redis.get(`podium:${yesterday}`);
    if (yPost && !done) {
      const rows = await topRows(yesterday, 3);
      if (rows.length > 0) {
        const medals = ["🥇", "🥈", "🥉"];
        const lines = rows.map((r, i) => `${medals[i]} u/${r.username} — ${(r.score / 10).toFixed(0)}m`);
        await reddit.submitComment({
          id: yPost as `t3_${string}`,
          text: `Final podium for ${yesterday}:\n\n${lines.join("\n\n")}\n\nToday's course is live — can you dethrone the ghost?`,
        });
      }
      await redis.set(`podium:${yesterday}`, "1");
    }
  } catch (err) {
    console.error(`podium comment failed: ${err}`); // never block the new post
  }

  return {};
}

// ── internal endpoints ───────────────────────────────────────────────────────

async function onMenuNewPost(): Promise<UiResponse> {
  const url = await createDailyPost(utcDateKey());
  return {
    showToast: { text: `Ghost Run post created.`, appearance: "success" },
    navigateTo: url,
  };
}

async function onAppInstall(): Promise<TriggerResponse> {
  await createDailyPost(utcDateKey());
  return {};
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function writeJSON(status: number, json: unknown, rsp: ServerResponse): void {
  const body = JSON.stringify(json);
  rsp.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
  });
  rsp.end(body);
}

class BodyTooLarge extends Error {}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Uint8Array).byteLength;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge(); // trust bytes, not headers
    chunks.push(chunk as Uint8Array);
  }
  return JSON.parse(`${Buffer.concat(chunks)}`) as T;
}
