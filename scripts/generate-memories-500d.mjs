#!/usr/bin/env node
/**
 * Wrapper for the recall-bench `generate` command that adds two missing
 * conveniences for long memory-generation runs:
 *
 *   1. **Auto-resume** — scans the target memories dir for the highest
 *      existing `day-NNNN.md` and bumps `--start` to that day + 1. No
 *      flag needed; just re-run after a crash and it picks up where it
 *      left off. Pass `--force-start <N>` to override.
 *
 *   2. **History-gap warning** — the generator's per-session history is
 *      in-memory only, so days right after a resume point have a 3-day
 *      blank context window. We surface this so you know to expect a
 *      brief continuity dip for ~3 days after the resume seam.
 *
 * Every other generate flag is passed through unchanged.
 *
 * Defaults are tuned for the EA 500-day corpus on Azure gpt-5.4-mini.
 */

import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { config as dotenvConfig } from "dotenv";

const REPO_ROOT = "C:/source/recall";
dotenvConfig({ path: `${REPO_ROOT}/.env` });
const PERSONA_DIR = `${REPO_ROOT}/packages/recall-bench/personas/executive-assistant`;
const MEMORIES_DIR = `${PERSONA_DIR}/memories-500d`;
const CLI = `${REPO_ROOT}/packages/recall-bench/dist/cli.js`;

const DEFAULTS = {
  arcs: "arcs-500d.yaml",
  memoriesDir: "memories-500d",
  end: 500,
  model: "azure:gpt-5.4-mini",
  temperature: 0.7,
  maxTokens: 2000,
  historyWindow: 3,
  timeout: 120000,
};

// Allow --force-start <N> to override auto-resume
let forceStart = null;
const passthrough = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--force-start" && argv[i + 1]) {
    forceStart = parseInt(argv[i + 1], 10);
    i++;
  } else {
    passthrough.push(argv[i]);
  }
}

if (!existsSync(MEMORIES_DIR)) {
  mkdirSync(MEMORIES_DIR, { recursive: true });
}

// Scan for highest existing day file
let maxDay = 0;
const dayRe = /^day-(\d+)\.md$/;
for (const f of readdirSync(MEMORIES_DIR)) {
  const m = dayRe.exec(f);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > maxDay) maxDay = n;
  }
}

const start = forceStart ?? (maxDay > 0 ? maxDay + 1 : 1);
const resuming = maxDay > 0 && forceStart === null;

console.log("=== recall-bench memory generation (500d, Azure gpt-5.4-mini) ===");
console.log(`  persona dir   : ${PERSONA_DIR}`);
console.log(`  memories dir  : ${MEMORIES_DIR}`);
console.log(`  arcs file     : ${DEFAULTS.arcs}`);
console.log(`  model         : ${DEFAULTS.model}`);
console.log(`  range         : day ${start} → ${DEFAULTS.end}`);
console.log(`  existing days : ${maxDay} (highest day-NNNN.md found)`);
if (resuming) {
  console.log("");
  console.log("  ⚠ RESUMING from a prior partial run.");
  console.log("    Per-session history is in-memory only, so the first ~3 days");
  console.log(`    after the resume seam (days ${start}..${start + 2}) will have`);
  console.log("    empty prior-day context. Expect a brief continuity dip in those");
  console.log("    days before the rolling history rebuilds. Each subsequent day");
  console.log("    re-establishes the window normally.");
}
if (forceStart !== null) {
  console.log(`  ⚠ --force-start override: ignoring existing days, starting at ${forceStart}`);
}
console.log("");

if (start > DEFAULTS.end) {
  console.log(`Nothing to do — day ${start} > end ${DEFAULTS.end}. Corpus is complete.`);
  process.exit(0);
}

const args = [
  CLI,
  "generate",
  "--persona", PERSONA_DIR,
  "--arcs", DEFAULTS.arcs,
  "--memories-dir", DEFAULTS.memoriesDir,
  "--model", DEFAULTS.model,
  "--start", String(start),
  "--end", String(DEFAULTS.end),
  "--temperature", String(DEFAULTS.temperature),
  "--max-tokens", String(DEFAULTS.maxTokens),
  "--history-window", String(DEFAULTS.historyWindow),
  "--timeout", String(DEFAULTS.timeout),
  ...passthrough,
];

const child = spawn("node", args, {
  stdio: "inherit",
  env: { ...process.env },
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to spawn bench CLI:", err);
  process.exit(1);
});
