#!/usr/bin/env node
/**
 * Stitch two recall-bench progress JSONL files into one unified record set.
 * Use case: a run that crashed mid-way + a resume run that picked up at the
 * next checkpoint. The two halves share the same `range.days` value space
 * but were emitted by separate processes (so the resume run renumbers
 * `checkpointIndex` to start at 1).
 *
 * Output is a JSONL the heatmap script can consume directly:
 *   - One `header` record (from the most-recent run)
 *   - Concatenated `checkpoint` records, sorted by range.days, deduped by label
 *   - One `summary` record with combined totals + the latest durationMs (best
 *     available; the first run's wall-clock is partial)
 *
 * Usage:
 *   node scripts/merge-progress-jsonl.mjs <out-path> <part1.jsonl> <part2.jsonl> [...]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: merge-progress-jsonl.mjs <out> <in1> <in2> [...]");
  process.exit(2);
}
const [outPath, ...inputs] = args;

function load(path) {
  return readFileSync(resolve(path), "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const inputs_records = inputs.map(load);

let header = null;
const checkpoints = new Map(); // range.label -> checkpoint record
let durationMs = 0;
let summaryUniqueQAPairCount = 316;
let summaryAppellateInvocations = 0;
let anySummary = false;

for (const recs of inputs_records) {
  for (const r of recs) {
    if (r.type === "header") {
      // Use the most-recent (last seen) header so model labels etc. reflect
      // the final run's configuration. They should be identical anyway.
      header = r;
    } else if (r.type === "checkpoint") {
      const key = r.range?.label;
      if (!key) continue;
      // Later runs win on duplicate labels — preserves the most recent data.
      checkpoints.set(key, r);
    } else if (r.type === "summary") {
      anySummary = true;
      summaryAppellateInvocations += r.appellateInvocations ?? 0;
      durationMs += r.durationMs ?? 0;
      if (r.uniqueQAPairCount) summaryUniqueQAPairCount = r.uniqueQAPairCount;
    }
  }
}

// Sort checkpoints by range.days ascending.
const sortedCheckpoints = [...checkpoints.values()].sort(
  (a, b) => (a.range?.days ?? 0) - (b.range?.days ?? 0),
);

// Re-stamp checkpointIndex / totalCheckpoints to a single monotonic numbering.
const total = sortedCheckpoints.length;
for (let i = 0; i < sortedCheckpoints.length; i++) {
  sortedCheckpoints[i] = {
    ...sortedCheckpoints[i],
    checkpointIndex: i + 1,
    totalCheckpoints: total,
  };
}

// Always recompute totalEvalsRun from the merged checkpoint set — summary
// records from individual runs only cover their own slice and miss crashed
// segments where the run never wrote a summary.
const totalEvalsRun = sortedCheckpoints.reduce(
  (s, c) => s + (c.questionsEvaluated ?? 0),
  0,
);

// Appellate invocations: optionally accept --failure-log paths as a more
// accurate source than summaries (each failure-log line = one appellate
// invocation). Sum all if any provided; otherwise fall back to summary totals.
const failureLogPaths = process.env.FAILURE_LOGS
  ? process.env.FAILURE_LOGS.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  : [];
let appellateInvocations = summaryAppellateInvocations;
if (failureLogPaths.length > 0) {
  appellateInvocations = 0;
  for (const p of failureLogPaths) {
    const raw = readFileSync(resolve(p), "utf-8");
    appellateInvocations += raw.split(/\r?\n/).filter((l) => l.trim()).length;
  }
}

const summary = {
  type: "summary",
  timestamp: new Date().toISOString(),
  durationMs, // sum across runs — partial wall-clock for crashed segments
  totalEvalsRun,
  uniqueQAPairCount: summaryUniqueQAPairCount,
  appellateInvocations,
};

const lines = [];
if (header) lines.push(JSON.stringify({ ...header, ranges: sortedCheckpoints.map((c) => c.range) }));
for (const c of sortedCheckpoints) lines.push(JSON.stringify(c));
lines.push(JSON.stringify(summary));

writeFileSync(resolve(outPath), lines.join("\n") + "\n", "utf-8");
console.log(`Wrote ${outPath}`);
console.log(`  checkpoints: ${sortedCheckpoints.length}`);
console.log(`  total evals: ${totalEvalsRun}`);
console.log(`  appellate reviews: ${appellateInvocations}`);
console.log(`  range coverage: ${sortedCheckpoints[0]?.range.label} → ${sortedCheckpoints[sortedCheckpoints.length - 1]?.range.label}`);
