// Inline feed view. Kept intentionally tiny — no Phaser here. Heavy
// dependencies live in game.html only (per Devvit template guidance).

import { context, requestExpandedMode } from "@devvit/web/client";
import { ApiEndpoint } from "../shared/api.ts";
import type { InitResponse } from "../shared/api.ts";

const title = document.getElementById("title");
if (title) {
  title.textContent = `Ready, u/${context.username ?? "runner"}?`;
}

const startButton = document.getElementById("start-button");
startButton?.addEventListener("click", (e) => {
  requestExpandedMode(e as MouseEvent, "game");
});

// Best-effort live teaser: today's ghost to dethrone. Fail silent — the
// splash must render instantly with or without the server.
void (async () => {
  try {
    const rsp = await fetch(ApiEndpoint.Init);
    if (!rsp.ok) return;
    const init = (await rsp.json()) as InitResponse;
    const line = document.getElementById("ghost-line");
    if (!line) return;
    line.textContent = init.ghost
      ? `today's ghost: u/${init.ghost.username} — ${(init.ghost.score / 10).toFixed(0)}m. dethrone them.`
      : "no ghost yet today — set the first run.";
  } catch {
    /* leave the static tagline */
  }
})();
