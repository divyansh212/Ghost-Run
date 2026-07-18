#!/usr/bin/env -S node --experimental-strip-types

// Bundles client → public/*.js and server → dist/server/index.js.
// Flags: --minify, --watch

import fs from "node:fs";
import type { BuildOptions } from "esbuild";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify");

const opts: BuildOptions = {
  bundle: true,
  minify,
  logLevel: "info",
  sourcemap: "linked",
  target: "es2023",
};

const clientOpts: BuildOptions = {
  ...opts,
  entryPoints: ["src/client/splash.ts", "src/client/game.ts"],
  format: "esm",
  outdir: "public",
  platform: "browser",
};

const serverOpts: BuildOptions = {
  ...opts,
  entryPoints: ["src/server/index.ts"],
  format: "cjs",
  outExtension: { ".js": ".js" },
  outdir: "dist/server",
  platform: "node",
};

if (watch) {
  const clientCtx = await esbuild.context(clientOpts);
  const serverCtx = await esbuild.context(serverOpts);
  await Promise.all([clientCtx.watch(), serverCtx.watch()]);
} else {
  fs.rmSync("dist", { recursive: true, force: true });
  await Promise.all([esbuild.build(clientOpts), esbuild.build(serverOpts)]);
}
