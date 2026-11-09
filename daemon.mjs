// daemon.mjs: runs engine.mjs continuously on a VPS, without GitHub Actions cron.
// engine.mjs decides whether to act on each call (based on
// state/plan.json, active hours, daily cap); this daemon only "polls" it regularly.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Tiny built-in .env loader (no dotenv dependency needed) -- VPS runs this under pm2, which
// doesn't source .env files on its own. GitHub Actions never needed this since it injected
// env vars directly via the workflow file.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dir, ".env"));

const MIN_INTERVAL_MIN = Number(process.env.DAEMON_MIN_INTERVAL_MIN || "3");
const MAX_INTERVAL_MIN = Number(process.env.DAEMON_MAX_INTERVAL_MIN || "7");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelayMs() {
  const span = MAX_INTERVAL_MIN - MIN_INTERVAL_MIN;
  const min = MIN_INTERVAL_MIN + Math.random() * span;
  return Math.round(min * 60_000);
}

async function main() {
  console.log(`=== daemon start (${process.env.BOT_NAME || "bot"}) ===`);
  while (true) {
    const res = spawnSync("node", [path.join(__dir, "engine.mjs")], {
      stdio: "inherit",
      env: process.env,
    });
    if (res.error) console.error("[daemon] engine.mjs spawn error:", res.error);

    const delay = nextDelayMs();
    console.log(`[daemon] next check in ~${Math.round(delay / 60000)} min`);
    await sleep(delay);
  }
}

main();
