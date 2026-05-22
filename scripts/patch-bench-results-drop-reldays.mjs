#!/usr/bin/env node
/**
 * Post-hoc patch for a recall-bench result that was scored against a Q&A set
 * containing bench-internal relative-day references ("day 14", "between day
 * 176 and day 181"). The memory system can't interpret those — they're a
 * bench bookkeeping leak — so any pair using that notation was unfairly
 * scored. This script rebuilds the result JSON and progress JSONL with those
 * pairs excluded, then leaves the heatmap script to render the cleaned view.
 *
 * Limitation: cached checkpoints (loaded from a prior run's JSONL) only have
 * aggregated category/overall scores, not per-question results. They're
 * passed through unchanged. The script reports how many such ranges exist.
 *
 * Usage:
 *   node scripts/patch-bench-results-drop-reldays.mjs <result.json> <qa.yaml> <out-prefix>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const [resultPath, qaPath, outPrefix] = process.argv.slice(2);
if (!resultPath || !qaPath || !outPrefix) {
  console.error("Usage: <result.json> <qa.yaml> <out-prefix>");
  process.exit(2);
}

// Detect which Q&A pair ids carry a bench-internal relative-day reference
// AFTER the fix script ran — i.e., the question wording from BEFORE the fix
// that the bench used. We re-derive this by checking the .bak file written
// by the fix script: any pair whose question/answer differs between bak and
// current is a relative-day pair.
const bakPath = qaPath + ".bak-pre-fix";
const beforePairs = YAML.parse(readFileSync(resolve(bakPath), "utf-8"));
const afterPairs = YAML.parse(readFileSync(resolve(qaPath), "utf-8"));
const afterById = new Map(afterPairs.map((p) => [p.id, p]));
const relDayIds = new Set();
for (const before of beforePairs) {
  const after = afterById.get(before.id);
  if (!after) continue;
  if (before.question !== after.question || before.answer !== after.answer) {
    relDayIds.add(before.id);
  }
}
console.log(`identified ${relDayIds.size} relative-day Q&A pairs`);

const result = JSON.parse(readFileSync(resolve(resultPath), "utf-8"));

// Per-range recomputation. Keep ranges with no questionResults (cached
// resumed ranges) untouched; their summary fields stand as-is.
let totalDropped = 0;
let cachedRanges = 0;
const persona = result.personas[0];
const newRangeResults = persona.rangeResults.map((rr) => {
  if (!rr.questionResults || rr.questionResults.length === 0) {
    cachedRanges++;
    return rr;
  }
  const kept = rr.questionResults.filter((q) => !relDayIds.has(q.qa.id));
  const dropped = rr.questionResults.length - kept.length;
  totalDropped += dropped;
  if (dropped === 0) return rr;

  // Recompute aggregates from kept question results.
  const compositeOf = (q) => q.score.correctness + q.score.completeness + q.score.hallucination;
  const overallScore = kept.length > 0 ? kept.reduce((s, q) => s + compositeOf(q), 0) / kept.length : 0;
  const hallucinatedCount = kept.filter((q) => q.score.hallucination === 0).length;
  const hallucinationRate = kept.length > 0 ? (hallucinatedCount / kept.length) * 100 : 0;

  // Per-category
  const byCat = new Map();
  for (const q of kept) {
    const arr = byCat.get(q.qa.category) ?? [];
    arr.push(q);
    byCat.set(q.qa.category, arr);
  }
  const categoryScores = rr.categoryScores.map((c) => {
    const arr = byCat.get(c.category) ?? [];
    const mean = arr.length > 0 ? arr.reduce((s, q) => s + compositeOf(q), 0) / arr.length : 0;
    return {
      ...c,
      meanScore: mean,
      questionCount: arr.length,
      scores: arr.map(compositeOf),
    };
  });

  // Per-difficulty
  const diffOut = { easy: { mean: 0, count: 0 }, medium: { mean: 0, count: 0 }, hard: { mean: 0, count: 0 } };
  for (const diff of ["easy", "medium", "hard"]) {
    const arr = kept.filter((q) => q.qa.difficulty === diff);
    if (arr.length > 0) {
      diffOut[diff] = {
        mean: arr.reduce((s, q) => s + compositeOf(q), 0) / arr.length,
        count: arr.length,
      };
    }
  }

  return {
    ...rr,
    questionsEvaluated: kept.length,
    overallScore,
    hallucinationRate,
    categoryScores,
    difficultyScores: diffOut,
    questionResults: kept,
  };
});

persona.rangeResults = newRangeResults;
// Recompute persona-level totals
persona.totalEvalsRun = newRangeResults.reduce((s, rr) => s + rr.questionsEvaluated, 0);

// Top-level metadata
const newTotalEvals = result.personas.reduce((s, p) => s + p.totalEvalsRun, 0);
result.metadata.totalEvalsRun = newTotalEvals;

// Rebuild aggregate heatmap from the recomputed rangeResults. The heatmap
// generator only needs per-range, per-category meanScores so it'll pick up
// the new numbers naturally when we re-render from the progress JSONL.

// Write patched JSON
const outJson = resolve(`${outPrefix}.json`);
writeFileSync(outJson, JSON.stringify(result, null, 2), "utf-8");

// Write a progress JSONL the heatmap script can render. Reuses the bench's
// existing JSONL schema (header + checkpoint per range + summary).
const labels = result.metadata;
const header = {
  type: "header",
  timestamp: result.timestamp,
  adapterName: result.adapterName,
  ranges: result.ranges,
  sample: result.metadata.sample,
  judgeMemoryWindow: result.metadata.judgeMemoryWindow,
  groupsEnabled: result.metadata.groupsEnabled,
  synthesisModel: labels.synthesisModel,
  embeddingProvider: labels.embeddingProvider,
  embeddingModel: labels.embeddingModel,
  judgeModel: labels.judgeModel,
  appellateJudgeModel: labels.appellateJudgeModel,
};
const total = newRangeResults.length;
const lines = [JSON.stringify(header)];
for (let i = 0; i < newRangeResults.length; i++) {
  const rr = newRangeResults[i];
  lines.push(JSON.stringify({
    type: "checkpoint",
    timestamp: result.timestamp,
    personaId: persona.personaId,
    checkpointIndex: i + 1,
    totalCheckpoints: total,
    range: rr.range,
    daysIngested: rr.daysIngested,
    questionsEvaluated: rr.questionsEvaluated,
    overallScore: rr.overallScore,
    hallucinationRate: rr.hallucinationRate,
    categoryScores: rr.categoryScores.map((c) => ({
      category: c.category,
      meanScore: c.meanScore,
      questionCount: c.questionCount,
      eligibleCount: c.eligibleCount,
    })),
    difficultyScores: rr.difficultyScores,
  }));
}
lines.push(JSON.stringify({
  type: "summary",
  timestamp: new Date().toISOString(),
  durationMs: result.metadata.durationMs,
  totalEvalsRun: newTotalEvals,
  uniqueQAPairCount: result.metadata.uniqueQAPairCount,
  appellateInvocations: result.metadata.appellateInvocations,
}));
const outJsonl = resolve(`${outPrefix}.progress.jsonl`);
writeFileSync(outJsonl, lines.join("\n") + "\n", "utf-8");

console.log(`wrote ${outJson}`);
console.log(`wrote ${outJsonl}`);
console.log(`  ranges with per-question data (recomputed): ${total - cachedRanges}`);
console.log(`  cached ranges (passed through unchanged): ${cachedRanges}`);
console.log(`  total evaluations dropped: ${totalDropped}`);
console.log(`  new total evaluations: ${newTotalEvals}`);
