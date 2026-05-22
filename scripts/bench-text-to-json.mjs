#!/usr/bin/env node
/**
 * bench-text-to-json.mjs
 *
 * Parse a recall-bench text report (the default stdout when --json/--json-out
 * were not passed) and emit a JSON BenchmarkResult-shaped file the heatmap
 * script can consume. Useful for visualizing runs that pre-date the metadata
 * fields, or runs where --json-out wasn't enabled.
 *
 * Limitations: the text report doesn't include individual question results,
 * so this reconstruction is *coarse* — heatmap and per-range stats are
 * accurate, but the information-disclosure breakdown can only approximate the
 * per-bucket score (it uses the run-wide information-boundary mean, since the
 * text report doesn't distinguish refuse/partial/answer subscores).
 *
 * Usage:
 *   node scripts/bench-text-to-json.mjs \
 *     --input  <bench-log.txt>                       (required)
 *     --output <bench-result.json>                   (required)
 *     [--qa-file <persona-qa>/questions.yaml]        (for disclosure counts)
 *     [--duration-ms <N>]                            (run duration)
 *     [--synthesis-model openai:gpt-4.1-mini]
 *     [--embedding-model text-embedding-3-small]
 *     [--embedding-provider auto|openai|fts]
 *     [--judge-model openai:gpt-4.1-mini]
 *     [--persona-id executive-assistant]             (override if multiple)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import YAML from 'yaml';

function arg(name, defaultVal = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return defaultVal;
}

const inputPath = arg('input');
const outputPath = arg('output');
if (!inputPath || !outputPath) {
  console.error('Usage: bench-text-to-json.mjs --input <log> --output <json> [...]');
  process.exit(2);
}
const qaFile = arg('qa-file');
const durationMs = arg('duration-ms') ? parseInt(arg('duration-ms'), 10) : null;
const synthesisModel = arg('synthesis-model');
const embeddingModel = arg('embedding-model');
const embeddingProvider = arg('embedding-provider');
const judgeModel = arg('judge-model');
const personaOverride = arg('persona-id');

// ---------------------------------------------------------------------------
// Strip ANSI escape sequences so regexes don't have to deal with them.
// ---------------------------------------------------------------------------
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const text = readFileSync(resolve(inputPath), 'utf-8').replace(ANSI_RE, '');
const lines = text.split(/\r?\n/);

// ---------------------------------------------------------------------------
// Parse top-of-report metadata.
// ---------------------------------------------------------------------------
let adapterName = 'unknown';
let timestamp = new Date().toISOString();
let rangeLabels = [];

for (const line of lines) {
  const adapter = /^Recall Bench Report\s*[—-]+\s*(.+)$/.exec(line);
  if (adapter) adapterName = adapter[1].trim();

  const ts = /^Timestamp:\s*(.+)$/.exec(line);
  if (ts) timestamp = ts[1].trim();

  const ranges = /^Ranges:\s*(.+)$/.exec(line);
  if (ranges) {
    rangeLabels = ranges[1].split(',').map((s) => s.trim()).filter(Boolean);
    break; // We have what we need from the header
  }
}

if (rangeLabels.length === 0) {
  console.error('Could not parse "Ranges:" line — is this a recall-bench text report?');
  process.exit(1);
}

// Convert range labels back to {label, days}.
function rangeFromLabel(label) {
  const numMatch = /^(\d+)d$/.exec(label);
  if (numMatch) return { label, days: parseInt(numMatch[1], 10) };
  const moMatch = /^(\d+)mo$/.exec(label);
  if (moMatch) return { label, days: parseInt(moMatch[1], 10) * 30 };
  const yMatch = /^(\d+)y$/.exec(label);
  if (yMatch) return { label, days: parseInt(yMatch[1], 10) * 365 };
  if (label === 'full') return { label, days: Number.MAX_SAFE_INTEGER };
  throw new Error(`Cannot interpret range label "${label}"`);
}

const ranges = rangeLabels.map(rangeFromLabel);

// ---------------------------------------------------------------------------
// Walk the per-persona sections.
// ---------------------------------------------------------------------------
const personas = []; // { personaId, rangeResults: [...] }
let currentPersona = null;
let currentRange = null;

const RANGE_HEADER_RE = /^\s*\[([^\]]+)\]\s*Days:\s*(\d+)\s*\|\s*Questions:\s*(\d+)\s*\|\s*Score:\s*([\d.]+)\/6\.0.*Hallucination:\s*([\d.]+)%/;
const CATEGORY_RE = /^\s+([a-z-]+)\s+([\d.]+)\/6\.0\s+\(([\d.]+)%\)\s+\[n=(\d+)\]/;
const PERSONA_RE = /^Persona:\s*(.+)$/;

for (const line of lines) {
  const pm = PERSONA_RE.exec(line);
  if (pm) {
    currentPersona = { personaId: pm[1].trim(), rangeResults: [] };
    personas.push(currentPersona);
    currentRange = null;
    continue;
  }
  const rm = RANGE_HEADER_RE.exec(line);
  if (rm && currentPersona) {
    const label = rm[1].trim();
    const range = rangeFromLabel(label);
    currentRange = {
      range,
      daysIngested: parseInt(rm[2], 10),
      questionsEvaluated: parseInt(rm[3], 10),
      overallScore: parseFloat(rm[4]),
      hallucinationRate: parseFloat(rm[5]),
      categoryScores: [],
    };
    currentPersona.rangeResults.push(currentRange);
    continue;
  }
  const cm = CATEGORY_RE.exec(line);
  if (cm && currentRange) {
    currentRange.categoryScores.push({
      category: cm[1],
      meanScore: parseFloat(cm[2]),
      questionCount: parseInt(cm[4], 10),
    });
  }
}

if (personas.length === 0) {
  console.error('No "Persona: ..." blocks found in the log.');
  process.exit(1);
}

if (personaOverride) {
  for (const p of personas) p.personaId = personaOverride;
}

// ---------------------------------------------------------------------------
// Build heatmap cells from the per-range categoryScores.
// ---------------------------------------------------------------------------
function buildHeatmap(persona) {
  const cells = [];
  for (const rr of persona.rangeResults) {
    for (const cs of rr.categoryScores) {
      cells.push({
        range: rr.range.label,
        category: cs.category,
        score: cs.meanScore,
        questionCount: cs.questionCount,
      });
    }
  }
  return cells;
}

const personasOut = personas.map((p) => {
  const heatmap = buildHeatmap(p);
  const totalEvalsRun = p.rangeResults.reduce((s, rr) => s + rr.questionsEvaluated, 0);
  // uniqueQAPairCount: the max questionsEvaluated across ranges, since the
  // last range admits every eligible pair from the dataset.
  const uniqueQAPairCount = p.rangeResults.reduce((m, rr) => Math.max(m, rr.questionsEvaluated), 0);
  return {
    personaId: p.personaId,
    adapterName,
    rangeResults: p.rangeResults.map((rr) => ({
      ...rr,
      difficultyScores: { easy: { mean: 0, count: 0 }, medium: { mean: 0, count: 0 }, hard: { mean: 0, count: 0 } },
      questionResults: [], // not recoverable from text
    })),
    heatmap,
    totalIngestionMs: 0,
    totalQueryMs: 0,
    uniqueQAPairCount,
    totalEvalsRun,
  };
});

// Aggregate heatmap = union of per-persona cells, merged by (range, category).
function aggregateHeatmap(personaList) {
  const map = new Map();
  for (const p of personaList) {
    for (const cell of p.heatmap) {
      const k = `${cell.range}::${cell.category}`;
      const e = map.get(k) ?? { total: 0, count: 0, questions: 0 };
      e.total += cell.score * cell.questionCount;
      e.count += cell.questionCount;
      e.questions += cell.questionCount;
      map.set(k, e);
    }
  }
  const out = [];
  for (const [k, v] of map) {
    const [range, category] = k.split('::');
    out.push({
      range,
      category,
      score: v.count > 0 ? v.total / v.count : 0,
      questionCount: v.questions,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disclosure breakdown — coarse reconstruction.
// We get the *counts* of each expectedDisclosure type from the QA file, but
// only the run-wide information-boundary mean score from the text. So we
// apply that mean as an approximation to each disclosure bucket. The bench
// itself can compute this precisely going forward; this is a best-effort
// for legacy runs.
// ---------------------------------------------------------------------------
let disclosureBreakdown = null;
if (qaFile) {
  try {
    const qaRaw = readFileSync(resolve(qaFile), 'utf-8');
    const qaPairs = YAML.parse(qaRaw);
    const boundary = qaPairs.filter((q) => q.category === 'information-boundary');
    if (boundary.length > 0) {
      const buckets = { refuse: [], partial: [], answer: [] };
      for (const q of boundary) {
        const k = q.expected_disclosure ?? q.expectedDisclosure;
        if (k && buckets[k]) buckets[k].push(q.id);
      }
      // Approximate score: use the info-boundary aggregate from the last
      // range's categoryScores (i.e., the score at the full corpus).
      const lastRange = personas[0].rangeResults[personas[0].rangeResults.length - 1];
      const bcat = lastRange?.categoryScores?.find((c) => c.category === 'information-boundary');
      const approxScore = bcat ? bcat.meanScore : 0;
      // Approximate hallucination: assume the run-wide info-boundary hallucination
      // pattern (we don't have per-disclosure question results).
      const approxHalluc = 100; // 0 score implies all answers hallucinated by score==0 rule
      // Evaluations across all ranges, scaled by pair count proportion.
      const totalInfoBoundaryEvals = personas[0].rangeResults.reduce((s, rr) => {
        const c = rr.categoryScores.find((c) => c.category === 'information-boundary');
        return s + (c ? c.questionCount : 0);
      }, 0);

      disclosureBreakdown = {};
      for (const key of ['refuse', 'partial', 'answer']) {
        const pairs = buckets[key];
        if (pairs.length === 0) continue;
        const fraction = pairs.length / boundary.length;
        disclosureBreakdown[key] = {
          evaluations: Math.round(totalInfoBoundaryEvals * fraction),
          uniquePairs: pairs.length,
          meanScore: approxScore,
          hallucinationRate: approxHalluc,
        };
      }
      if (Object.keys(disclosureBreakdown).length === 0) disclosureBreakdown = null;
    }
  } catch (err) {
    console.error(`Warning: failed to read QA file at ${qaFile}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Assemble the final BenchmarkResult.
// ---------------------------------------------------------------------------
const totalEvalsRun = personasOut.reduce((s, p) => s + p.totalEvalsRun, 0);
const uniqueQAPairCount = personasOut.reduce((s, p) => s + p.uniqueQAPairCount, 0);

const metadata = {
  durationMs: durationMs ?? 0,
  totalEvalsRun,
  uniqueQAPairCount,
};
if (synthesisModel) metadata.synthesisModel = synthesisModel;
if (embeddingProvider) metadata.embeddingProvider = embeddingProvider;
if (embeddingModel) metadata.embeddingModel = embeddingModel;
if (judgeModel) metadata.judgeModel = judgeModel;

const result = {
  timestamp,
  adapterName,
  ranges,
  personas: personasOut,
  heatmap: aggregateHeatmap(personasOut),
  metadata,
};
if (disclosureBreakdown) result.disclosureBreakdown = disclosureBreakdown;

writeFileSync(resolve(outputPath), JSON.stringify(result, null, 2), 'utf-8');
console.log(`Wrote ${outputPath}`);
console.log(`  adapter=${adapterName}  ranges=${rangeLabels.length}  personas=${personas.length}`);
console.log(`  total evals=${totalEvalsRun}  unique pairs=${uniqueQAPairCount}`);
if (disclosureBreakdown) {
  console.log(`  disclosure buckets: ${Object.keys(disclosureBreakdown).join(', ')}  (scores approximated)`);
}
