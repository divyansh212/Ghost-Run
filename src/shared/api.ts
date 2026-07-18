import type { ReplayEvent } from "./replay.ts";

export const ApiEndpoint = {
  Init: "/api/init",
  Submit: "/api/submit",
  Replay: "/api/replay",
  OnPostCreate: "/internal/menu/post-create",
  OnAppInstall: "/internal/on-app-install",
  DailyPost: "/internal/scheduler/daily-post",
} as const;
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

/** Machine-readable rejection categories the client can react to. */
export type RejectCode =
  | "not_logged_in" // viewer has no Reddit account/session
  | "stale_day" // run recorded against yesterday's seed (UTC rollover)
  | "rate_limited" // submitting too fast
  | "invalid"; // failed validation (tampering, version, malformed)

export type LeaderboardRow = { username: string; score: number };

export type GhostBlob = {
  username: string;
  score: number;
  tickCount: number;
  events: ReplayEvent[];
};

export type InitResponse = {
  type: "init";
  postId: string;
  username: string;
  loggedIn: boolean;
  dateKey: string; // "2026-07-04" (UTC)
  seed: number; // daily seed — server-authoritative
  personalBest: number; // 0 if none
  streak: number; // consecutive UTC days played (0 if never)
  leaderboard: LeaderboardRow[];
  ghost: GhostBlob | null; // today's top run to race against
  myReplay: GhostBlob | null; // your own best run today (race your PB)
};

export type SubmitRequest = {
  simVersion: number;
  dateKey: string; // the day the client THINKS it is — server verifies
  events: ReplayEvent[];
  tickCount: number;
  finalHash: number;
  checkpoints: number[];
};

export type SubmitResponse =
  | {
      type: "submit";
      ok: true;
      score: number;
      rank: number; // 1-based
      streak: number;
      newPersonalBest: boolean;
      isNewTopGhost: boolean;
      leaderboard: LeaderboardRow[];
    }
  | { type: "submit"; ok: false; code: RejectCode; reason: string };

export type ReplayRequest = { username: string };
export type ReplayResponse = { type: "replay"; ghost: GhostBlob | null };
