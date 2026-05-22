#!/usr/bin/env node
/**
 * Wrapper for the recall-bench `generate-qa` command. Mirrors the memory-gen
 * wrapper's conveniences:
 *
 *   1. Loads `.env` from the repo root so Azure credentials are visible to
 *      the spawned bench CLI process.
 *   2. Defaults tuned for the EA 500-day corpus on Azure gpt-5.4-mini.
 *
 * No auto-resume: the bench's `generate-qa` writes one questions.yaml at
 * end-of-run, so failures abandon all in-flight work. If we hit that we'll
 * patch the CLI to checkpoint per-interval.
 */

import { spawn } from "node:child_process";
import { config as dotenvConfig } from "dotenv";

const REPO_ROOT = "C:/source/recall";
dotenvConfig({ path: `${REPO_ROOT}/.env` });

const PERSONA_DIR = `${REPO_ROOT}/packages/recall-bench/personas/executive-assistant`;
const CLI = `${REPO_ROOT}/packages/recall-bench/dist/cli.js`;

const DEFAULTS = {
  arcs: "arcs-500d.yaml",
  memoriesDir: "memories-500d",
  qaDir: "qa-500d",
  // gpt-5.4-mini drops quotes on JSON value tokens often enough to crash
  // a long QA run. The full model is much more reliable for structured
  // output; the cost delta is small for a one-shot generation.
  model: "azure:gpt-5.4",
  mode: "standard",
  interval: 7,
  pairsPerCheckpoint: 12,
  temperature: 0.7,
  maxTokens: 4000,
  timeout: 120000,
};

console.log("=== recall-bench QA generation (500d, Azure gpt-5.4-mini) ===");
console.log(`  persona dir          : ${PERSONA_DIR}`);
console.log(`  arcs                 : ${DEFAULTS.arcs}`);
console.log(`  memories-dir         : ${DEFAULTS.memoriesDir}`);
console.log(`  qa-dir               : ${DEFAULTS.qaDir}`);
console.log(`  mode                 : ${DEFAULTS.mode}`);
console.log(`  interval             : every ${DEFAULTS.interval} days`);
console.log(`  pairs per checkpoint : ${DEFAULTS.pairsPerCheckpoint}`);
console.log(`  expected pairs       : ~${Math.floor(500 / DEFAULTS.interval) * DEFAULTS.pairsPerCheckpoint}`);
console.log(`  model                : ${DEFAULTS.model}`);
console.log("");

const args = [
  CLI,
  "generate-qa",
  "--persona", PERSONA_DIR,
  "--arcs", DEFAULTS.arcs,
  "--memories-dir", DEFAULTS.memoriesDir,
  "--qa-dir", DEFAULTS.qaDir,
  "--mode", DEFAULTS.mode,
  "--model", DEFAULTS.model,
  "--interval", String(DEFAULTS.interval),
  "--pairs-per-checkpoint", String(DEFAULTS.pairsPerCheckpoint),
  "--temperature", String(DEFAULTS.temperature),
  "--max-tokens", String(DEFAULTS.maxTokens),
  "--timeout", String(DEFAULTS.timeout),
  ...process.argv.slice(2),
];

const child = spawn("node", args, { stdio: "inherit", env: { ...process.env } });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to spawn bench CLI:", err);
  process.exit(1);
});
