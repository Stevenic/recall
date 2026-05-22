#!/usr/bin/env node
/**
 * generate-heatmap.mjs
 *
 * Generates a recall-bench heatmap PNG. Two modes:
 *
 *   1. Real data (preferred):
 *        node scripts/generate-heatmap.mjs --input <bench-result.json> [--output <png>]
 *      Reads a BenchmarkResult JSON produced by `recall-bench run --json-out <path>`
 *      (or `--json > path`). Renders the category × range heatmap, the OVERALL row,
 *      the hallucination-rate row, and (when present) the information-disclosure
 *      breakdown. Header annotates the memory system, models, run time, and Q&A counts.
 *
 *   2. Synthetic preview (fallback for demos / screenshots when no run is available):
 *        node scripts/generate-heatmap.mjs --interval 7 --days 1000
 *
 * CLI args (real-data mode):
 *   --input <path>            Path to a BenchmarkResult JSON file
 *   --output <path>           PNG output path (default: docs/recall-bench-heatmap.png)
 *
 * CLI args (metadata overrides; useful if the JSON predates the metadata fields):
 *   --memory <name>           Override adapter name
 *   --synthesis-model <id>
 *   --embedding-model <id>
 *   --embedding-provider <id>
 *   --judge-model <id>
 *   --duration <text>         Free-form duration string (e.g. "9h 20m")
 *   --base-pairs <n>          Unique Q&A pair count
 *   --total-evals <n>         Total (question × range) evaluation count
 *
 * Synthetic-mode args (only when --input is absent):
 *   --interval <days>         Evaluation period in days (default: 7)
 *   --days <total>            Total corpus days (default: 1000)
 *
 * Requires: npm install canvas
 */

import { createCanvas } from 'canvas';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArg(name, defaultVal) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return defaultVal;
}

const inputPath = parseArg('input', null);
const qaFileArg = parseArg('qa-file', null); // Optional: questions.yaml path for eligibility fallback
const outputPath = parseArg('output', null)
  ? resolve(parseArg('output', null))
  : resolve(__dirname, '..', 'docs', 'recall-bench-heatmap.png');

// Synthetic-mode args (used only if --input is absent)
const intervalDays = parseInt(parseArg('interval', '7'), 10);
const totalDays = parseInt(parseArg('days', '1000'), 10);

// Metadata override args (apply on top of JSON in real-data mode)
const overrides = {
  memory: parseArg('memory', null),
  synthesisModel: parseArg('synthesis-model', null),
  embeddingModel: parseArg('embedding-model', null),
  embeddingProvider: parseArg('embedding-provider', null),
  judgeModel: parseArg('judge-model', null),
  duration: parseArg('duration', null),
  basePairs: parseArg('base-pairs', null) ? parseInt(parseArg('base-pairs', null), 10) : null,
  totalEvals: parseArg('total-evals', null) ? parseInt(parseArg('total-evals', null), 10) : null,
};

// ---------------------------------------------------------------------------
// Category definitions (must match recall-bench's CATEGORIES order)
// ---------------------------------------------------------------------------
const CATEGORIES = [
  'factual-recall',
  'temporal-reasoning',
  'decision-tracking',
  'contradiction-resolution',
  'cross-reference',
  'recency-bias-resistance',
  'synthesis',
  'negative-recall',
  'group-session-attribution',
  'information-boundary',
];

/** Categories that are gated by the run's groupsEnabled flag. */
const GROUP_GATED_CATEGORIES = new Set(['group-session-attribution', 'information-boundary']);

// Sentinel meaning "no eligible data yet (corpus too small)" — drives the
// black cell render so it's visually distinct from "no data" (gray).
const INELIGIBLE = Symbol('ineligible');

/**
 * Optional fallback for legacy runs (or in-flight runs that started before
 * the harness learned to emit `eligibleCount`): read the persona's
 * questions.yaml and compute eligibility per (category, range.days) directly
 * from the QA pairs. Returns a Map<`category::rangeLabel`, eligibleCount>
 * or null when no qa-file was provided.
 */
async function loadEligibilityFromQa(qaPath, rangeLabels, rangeDays) {
  if (!qaPath) return null;
  const absPath = resolve(qaPath);
  if (!existsSync(absPath)) {
    console.error(`--qa-file: not found at ${absPath}`);
    return null;
  }
  let YAML;
  try {
    YAML = (await import('yaml')).default;
  } catch (e) {
    console.error(`--qa-file: yaml package not resolvable from heatmap script: ${e.message}`);
    return null;
  }
  const raw = readFileSync(absPath, 'utf-8');
  const pairs = YAML.parse(raw);
  if (!Array.isArray(pairs)) return null;
  const out = new Map();
  for (let i = 0; i < rangeLabels.length; i++) {
    const label = rangeLabels[i];
    const cutoff = rangeDays[i];
    for (const cat of CATEGORIES) {
      const n = pairs.filter((p) => p.category === cat && Math.max(...p.relevant_days) <= cutoff).length;
      out.set(`${cat}::${label}`, n);
    }
  }
  return out;
}

/**
 * When groups are off, the two gated categories simply don't apply — drop
 * their rows entirely so the heatmap focuses on what's actually being
 * measured. Header metadata still calls out that groups are off.
 */
function applyGroupGating(data) {
  if (data.metadata?.groupsEnabled === false) {
    const keepIdx = data.categories
      .map((cat, i) => (GROUP_GATED_CATEGORIES.has(cat) ? -1 : i))
      .filter((i) => i >= 0);
    return {
      ...data,
      categories: keepIdx.map((i) => data.categories[i]),
      scores: keepIdx.map((i) => data.scores[i]),
    };
  }
  return data;
}

// ---------------------------------------------------------------------------
// Data loading: real (from BenchmarkResult JSON) or synthetic (legacy preview)
// ---------------------------------------------------------------------------

/**
 * Rehydrate the BenchmarkResult-ish shape from streaming JSONL produced by
 * the harness during a run. Each line is either `header`, `checkpoint`, or
 * `summary`. Missing pieces (e.g., when reading mid-run) leave reasonable
 * defaults; the heatmap will render whatever checkpoints have landed so far
 * with `(INTERIM — N/M)` marked on the adapter name when summary is absent.
 */
function rehydrateFromJsonl(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let header = null;
  let summary = null;
  const checkpoints = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'header') header = rec;
    else if (rec.type === 'summary') summary = rec;
    else if (rec.type === 'checkpoint') checkpoints.push(rec);
  }
  // Build a BenchmarkResult-shaped object the rest of loadRealData consumes.
  const ranges = header?.ranges ?? checkpoints.map((c) => c.range);
  const personaId = checkpoints[0]?.personaId ?? 'unknown';
  const rangeResults = checkpoints.map((c) => ({
    range: c.range,
    daysIngested: c.daysIngested,
    questionsEvaluated: c.questionsEvaluated,
    overallScore: c.overallScore,
    hallucinationRate: c.hallucinationRate,
    categoryScores: c.categoryScores ?? [],
  }));
  // Build flat heatmap cells from per-checkpoint categoryScores.
  const heatmap = [];
  for (const c of checkpoints) {
    for (const cs of c.categoryScores ?? []) {
      const cell = {
        range: c.range.label,
        category: cs.category,
        score: cs.meanScore,
        questionCount: cs.questionCount,
      };
      if (cs.eligibleCount !== undefined) cell.eligibleCount = cs.eligibleCount;
      heatmap.push(cell);
    }
  }
  const completed = checkpoints.length;
  const total = checkpoints[0]?.totalCheckpoints ?? ranges.length;
  const adapterName = (header?.adapterName ?? 'unknown') + (summary ? '' : `  (INTERIM — ${completed}/${total} ckpts)`);
  return {
    timestamp: header?.timestamp ?? new Date().toISOString(),
    adapterName,
    ranges,
    personas: [{ personaId, adapterName, rangeResults, heatmap, uniqueQAPairCount: summary?.uniqueQAPairCount ?? 0, totalEvalsRun: summary?.totalEvalsRun ?? 0 }],
    heatmap,
    metadata: {
      durationMs: summary?.durationMs ?? 0,
      synthesisModel: header?.synthesisModel,
      embeddingProvider: header?.embeddingProvider,
      embeddingModel: header?.embeddingModel,
      judgeModel: header?.judgeModel,
      appellateJudgeModel: header?.appellateJudgeModel,
      appellateInvocations: summary?.appellateInvocations,
      sample: header?.sample,
      judgeMemoryWindow: header?.judgeMemoryWindow,
      groupsEnabled: header?.groupsEnabled,
      totalEvalsRun: summary?.totalEvalsRun ?? checkpoints.reduce((s, c) => s + (c.questionsEvaluated ?? 0), 0),
      uniqueQAPairCount: summary?.uniqueQAPairCount ?? 0,
    },
  };
}

/** Returns { periods: number[], rangeLabels: string[], scores: (number|null)[][],
 *            hallucinationRates: number[], categories: string[], metadata: {...},
 *            disclosure: { refuse?, partial?, answer? } | null } */
function loadRealData(jsonPath) {
  const raw = readFileSync(resolve(jsonPath), 'utf-8');
  // Sniff: .jsonl (streaming progress) vs .json (final aggregate).
  const isJsonl = jsonPath.toLowerCase().endsWith('.jsonl') || /^\s*\{[^}]*"type"\s*:\s*"(header|checkpoint|summary)"/.test(raw);
  const result = isJsonl ? rehydrateFromJsonl(raw) : JSON.parse(raw);

  // Periods come from the bench's ranges, in declared (sorted) order.
  const rangeLabels = result.ranges.map((r) => r.label);
  const periods = result.ranges.map((r) => r.days);

  // Score grid: categories × ranges. We track three states per cell:
  //   - "ineligible" (eligibleCount === 0): not-yet-possible — render BLACK
  //   - null: eligible but no data (sampled out, etc.) — render gray "no data"
  //   - number: actual score — render with color scale
  const cellLookup = new Map(); // `${category}::${rangeLabel}` -> { score, count, eligible }
  for (const cell of result.heatmap ?? []) {
    cellLookup.set(`${cell.category}::${cell.range}`, {
      score: cell.score,
      count: cell.questionCount,
      eligible: cell.eligibleCount,
    });
  }
  const scores = CATEGORIES.map((cat) =>
    rangeLabels.map((rangeLabel) => {
      const cell = cellLookup.get(`${cat}::${rangeLabel}`);
      if (cell && cell.count > 0) return cell.score;
      if (cell && cell.eligible === 0) return INELIGIBLE; // sentinel for not-yet-possible
      return null;
    }),
  );

  // Hallucination rate per range = mean of personaResult.rangeResults[i].hallucinationRate.
  const hallucinationRates = rangeLabels.map((_, i) => {
    const vals = [];
    for (const pr of result.personas ?? []) {
      const rr = pr.rangeResults?.[i];
      if (rr && typeof rr.hallucinationRate === 'number') vals.push(rr.hallucinationRate);
    }
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

  // Authoritative overall scores per range from rangeResults[].overallScore.
  // Used directly when present (more accurate than averaging category cells,
  // and the only source available for in-flight / interim renders where the
  // category breakdown isn't computed until the final aggregate).
  const overallScoresFromResults = rangeLabels.map((_, i) => {
    const vals = [];
    for (const pr of result.personas ?? []) {
      const rr = pr.rangeResults?.[i];
      if (rr && typeof rr.overallScore === 'number') vals.push(rr.overallScore);
    }
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

  const metadata = {
    memory: overrides.memory ?? result.adapterName,
    synthesisModel: overrides.synthesisModel ?? result.metadata?.synthesisModel ?? null,
    embeddingModel: overrides.embeddingModel ?? result.metadata?.embeddingModel ?? null,
    embeddingProvider: overrides.embeddingProvider ?? result.metadata?.embeddingProvider ?? null,
    judgeModel: overrides.judgeModel ?? result.metadata?.judgeModel ?? null,
    judgeMemoryWindow: result.metadata?.judgeMemoryWindow ?? null,
    appellateJudge: result.metadata?.appellateJudgeModel ?? null,
    appellateInvocations: result.metadata?.appellateInvocations ?? null,
    groupsEnabled: result.metadata?.groupsEnabled ?? null,
    sample: result.metadata?.sample ?? null,
    duration: overrides.duration ?? (typeof result.metadata?.durationMs === 'number' ? formatDuration(result.metadata.durationMs) : null),
    basePairs: overrides.basePairs ?? result.metadata?.uniqueQAPairCount ?? null,
    totalEvals: overrides.totalEvals ?? result.metadata?.totalEvalsRun ?? null,
    timestamp: result.timestamp ?? null,
  };

  const disclosure = result.disclosureBreakdown ?? null;

  return {
    mode: 'real',
    periods,
    rangeLabels,
    scores,
    hallucinationRates,
    overallScoresFromResults,
    categories: CATEGORIES,
    metadata,
    disclosure,
  };
}

function loadSyntheticData() {
  // The previous "preview" mode. Kept so the script still works without a JSON input.
  const periods = [];
  for (let end = intervalDays; end <= totalDays; end += intervalDays) periods.push(end);
  if (periods[periods.length - 1] < totalDays) periods.push(totalDays);
  const numPeriods = periods.length;
  const rangeLabels = periods.map((d) => (d <= 90 ? `${d}d` : d < 365 ? `${Math.round(d / 30)}mo` : `${(d / 365).toFixed(1)}y`));

  const categoryProfiles = {
    'factual-recall':           { start: 5.5, end: 3.8, curve: 'linear' },
    'temporal-reasoning':       { start: 4.7, end: 2.9, curve: 'concave' },
    'decision-tracking':        { start: 5.3, end: 3.7, curve: 'linear' },
    'contradiction-resolution': { start: null, end: 2.4, curve: 'linear', availableAfterFraction: 0.15 },
    'cross-reference':          { start: 4.9, end: 3.1, curve: 'convex' },
    'recency-bias-resistance':  { start: 5.1, end: 2.6, curve: 'concave' },
    'synthesis':                { start: 4.3, end: 2.7, curve: 'linear' },
    'negative-recall':          { start: 5.6, end: 4.1, curve: 'convex' },
    'group-session-attribution':{ start: null, end: 0,   curve: 'linear', availableAfterFraction: 1.0 }, // never present
    'information-boundary':     { start: null, end: 0,   curve: 'linear', availableAfterFraction: 1.0 }, // never present
  };
  const interpolate = (t, curve) => curve === 'concave' ? t * t : curve === 'convex' ? 1 - (1 - t) ** 2 : t;
  const scores = CATEGORIES.map((cat) => {
    const profile = categoryProfiles[cat];
    const row = [];
    for (let i = 0; i < numPeriods; i++) {
      const t = numPeriods > 1 ? i / (numPeriods - 1) : 0;
      if (profile.start === null) {
        if (t < profile.availableAfterFraction) { row.push(null); continue; }
        const availT = (t - profile.availableAfterFraction) / (1 - profile.availableAfterFraction);
        const startScore = 3.5;
        const decay = interpolate(availT, profile.curve);
        row.push(startScore - (startScore - profile.end) * decay);
      } else {
        const decay = interpolate(t, profile.curve);
        row.push(profile.start - (profile.start - profile.end) * decay);
      }
    }
    return row;
  });
  const hallucinationRates = periods.map((_, i) => {
    const t = numPeriods > 1 ? i / (numPeriods - 1) : 0;
    return 1.0 + 9.3 * (t ** 1.4);
  });

  return {
    mode: 'synthetic',
    periods,
    rangeLabels,
    scores,
    hallucinationRates,
    categories: CATEGORIES,
    metadata: {
      memory: overrides.memory ?? '(synthetic preview)',
      synthesisModel: overrides.synthesisModel,
      embeddingModel: overrides.embeddingModel,
      embeddingProvider: overrides.embeddingProvider,
      judgeModel: overrides.judgeModel,
      duration: overrides.duration,
      basePairs: overrides.basePairs,
      totalEvals: overrides.totalEvals,
      timestamp: null,
    },
    disclosure: null,
  };
}

let data = applyGroupGating(inputPath ? loadRealData(inputPath) : loadSyntheticData());

/**
 * Forward-fill sampling gaps. When a cell is null (gray "no data") inside the
 * range of completed checkpoints — and the category has shown a real score
 * earlier in the row — carry the previous score forward visually. This
 * smooths the noise from small-N categories like temporal-reasoning or
 * recency-bias-resistance where the 50-historical sample sometimes draws
 * none of the few eligible pairs.
 *
 * INELIGIBLE (black) cells are left alone. Future-checkpoint cells (those
 * after the last column with any data) stay gray.
 */
function smoothSamplingGaps(d) {
  const cols = d.rangeLabels.length;
  // Find the last completed column (any row has a non-null, non-INELIGIBLE value).
  let lastCompletedCol = -1;
  for (let c = cols - 1; c >= 0; c--) {
    let hasData = false;
    for (let r = 0; r < d.scores.length; r++) {
      const v = d.scores[r][c];
      if (v !== null && v !== undefined && v !== INELIGIBLE) { hasData = true; break; }
    }
    if (hasData) { lastCompletedCol = c; break; }
  }
  if (lastCompletedCol < 0) return d;
  for (let r = 0; r < d.scores.length; r++) {
    let lastVal = null;
    for (let c = 0; c <= lastCompletedCol; c++) {
      const v = d.scores[r][c];
      if (v === INELIGIBLE) continue; // black; don't carry across
      if (v !== null && v !== undefined) { lastVal = v; continue; }
      // Null cell inside completed range — carry forward when we have history.
      if (lastVal !== null) d.scores[r][c] = lastVal;
    }
  }
  return d;
}
data = smoothSamplingGaps(data);

// If the input JSON didn't carry per-cell eligibility (legacy / in-flight
// runs) but a --qa-file was provided, derive eligibility from the QA dataset
// and patch the score grid: turn null cells into INELIGIBLE wherever no
// eligible pair exists for that (category, range).
if (qaFileArg) {
  const eligibilityMap = await loadEligibilityFromQa(qaFileArg, data.rangeLabels, data.periods);
  if (eligibilityMap) {
    for (let r = 0; r < data.categories.length; r++) {
      for (let c = 0; c < data.rangeLabels.length; c++) {
        const cur = data.scores[r][c];
        if (cur !== null && cur !== undefined) continue; // already has a real score
        const n = eligibilityMap.get(`${data.categories[r]}::${data.rangeLabels[c]}`);
        if (n === 0) data.scores[r][c] = INELIGIBLE;
      }
    }
  }
}

const numPeriods = data.periods.length;

// OVERALL row. Prefer rangeResults[].overallScore (authoritative, captured by
// the bench harness) when available. Fall back to averaging category cells —
// the synthetic-mode preview only has category data. INELIGIBLE cells are
// skipped (not a missing data point, just "category doesn't apply yet").
const overallScores = data.rangeLabels.map((_, c) => {
  const direct = data.overallScoresFromResults?.[c];
  if (direct !== null && direct !== undefined) return direct;
  let sum = 0, count = 0;
  for (let r = 0; r < data.scores.length; r++) {
    const v = data.scores[r][c];
    if (v === INELIGIBLE || v === null || v === undefined) continue;
    sum += v; count++;
  }
  return count > 0 ? sum / count : null;
});

// ---------------------------------------------------------------------------
// Color scale — green (6.0) → amber (3.0) → red (0.0)
// ---------------------------------------------------------------------------
function scoreToColor(score) {
  if (score === INELIGIBLE) return { r: 15, g: 15, b: 20 }; // black: not yet possible
  if (score === null || score === undefined) return { r: 60, g: 60, b: 68 };
  const t = Math.max(0, Math.min(1, score / 6.0));
  let r, g, b;
  if (t < 0.5) {
    const u = t / 0.5;
    r = 220 + (245 - 220) * u;
    g = 60 + (180 - 60) * u;
    b = 60 + (50 - 60) * u;
  } else {
    const u = (t - 0.5) / 0.5;
    r = 245 + (56 - 245) * u;
    g = 180 + (195 - 180) * u;
    b = 50 + (100 - 50) * u;
  }
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}
const colorStr = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const CELL_W = Math.max(4, Math.min(16, Math.floor(900 / numPeriods)));
const CELL_H = 32;
const LABEL_W = 240;
const PADDING = 32;
const TITLE_H = 60;
const META_LINE_H = 18;
const metaLines = buildMetaLines(data.metadata);
const META_BLOCK_H = metaLines.length > 0 ? metaLines.length * META_LINE_H + 12 : 0;
const LEGEND_H = 70;
const SEPARATOR_H = 16;
const FOOTER_H = 50;
const AXIS_H = 40;
const DISCLOSURE_PANEL_H = data.disclosure ? 120 : 0;

const gridW = numPeriods * CELL_W;
const gridRows = data.categories.length;
const totalW = LABEL_W + Math.max(gridW, 720) + PADDING * 2;
const totalH =
  PADDING + TITLE_H + META_BLOCK_H +
  gridRows * CELL_H +
  SEPARATOR_H +
  CELL_H /* overall */ +
  CELL_H /* hallucination */ +
  AXIS_H +
  DISCLOSURE_PANEL_H +
  SEPARATOR_H + LEGEND_H + FOOTER_H + PADDING;

function buildMetaLines(m) {
  if (!m) return [];
  const lines = [];
  if (m.memory) lines.push(['memory', m.memory]);
  const embedParts = [];
  if (m.embeddingProvider) embedParts.push(m.embeddingProvider);
  if (m.embeddingModel) embedParts.push(m.embeddingModel);
  if (embedParts.length > 0) lines.push(['embeddings', embedParts.join(' / ')]);
  if (m.synthesisModel) lines.push(['synthesis model', m.synthesisModel]);
  if (m.judgeModel) {
    const groundedTail = m.judgeMemoryWindow ? `  (grounded, ±${m.judgeMemoryWindow}d window)` : '';
    lines.push(['judge model', m.judgeModel + groundedTail]);
  }
  if (m.appellateJudge) {
    const calls = m.appellateInvocations != null ? `  · ${m.appellateInvocations} reviews` : '';
    lines.push(['appellate judge', m.appellateJudge + calls]);
  }
  // Group-support flag — pull it out of the tail line into its own labeled
  // row so it's clearly readable. The two group-gated category rows are also
  // annotated separately when off (see drawRow logic).
  if (m.groupsEnabled === true) {
    lines.push(['group support', 'ON — group-session-attribution + information-boundary evaluated']);
  } else if (m.groupsEnabled === false) {
    lines.push(['group support', 'OFF — group-session-attribution + information-boundary NOT TESTED']);
  }
  const tail = [];
  if (m.duration) tail.push(`runtime ${m.duration}`);
  if (m.basePairs != null && m.totalEvals != null) {
    const sampleTag = m.sample != null ? ` · sample=${m.sample}` : '';
    tail.push(`Q&A: ${m.basePairs} unique · ${m.totalEvals} total evals${sampleTag}`);
  } else if (m.basePairs != null) tail.push(`Q&A pairs: ${m.basePairs}`);
  if (tail.length > 0) lines.push(['', tail.join('  ·  ')]);
  return lines;
}


// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const canvas = createCanvas(totalW, totalH);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#13131f';
ctx.fillRect(0, 0, totalW, totalH);

// Title
ctx.fillStyle = '#e8e8f0';
ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
ctx.textAlign = 'center';
ctx.fillText('Recall Bench — Aggregate Heatmap', totalW / 2, PADDING + 32);

ctx.font = '13px "Segoe UI", Arial, sans-serif';
ctx.fillStyle = '#8888aa';
const subtitleParts = [`${data.periods[data.periods.length - 1]} days`];
if (data.mode === 'synthetic') {
  const intervalLabel = intervalDays === 1 ? '1 day' :
    intervalDays === 7 ? '1 week' :
    intervalDays === 14 ? '2 weeks' :
    intervalDays === 30 ? '1 month' :
    `${intervalDays} days`;
  subtitleParts.push(`${intervalLabel} intervals`);
}
subtitleParts.push(`${numPeriods} checkpoints`);
subtitleParts.push('composite score (0–6)');
if (data.mode === 'synthetic') subtitleParts.push('SYNTHETIC PREVIEW');
ctx.fillText(subtitleParts.join('  ·  '), totalW / 2, PADDING + 52);

// Metadata block
let cursorY = PADDING + TITLE_H;
if (metaLines.length > 0) {
  ctx.textAlign = 'left';
  ctx.font = '12px "Segoe UI", Arial, sans-serif';
  for (const [key, val] of metaLines) {
    if (key) {
      ctx.fillStyle = '#6c6c92';
      ctx.fillText(`${key}:`, PADDING + LABEL_W - 124, cursorY + 12);
    }
    ctx.fillStyle = '#c4c4dc';
    ctx.fillText(val, PADDING + LABEL_W - 14, cursorY + 12);
    cursorY += META_LINE_H;
  }
  cursorY += 12;
}

const originX = PADDING + LABEL_W;
const originY = cursorY;

function drawRow(label, values, yOffset, opts = {}) {
  const y = originY + yOffset;
  ctx.font = opts.bold ? 'bold 14px "Segoe UI", sans-serif' : '14px "Segoe UI", sans-serif';
  ctx.fillStyle = opts.labelColor || '#d0d0e8';
  ctx.textAlign = 'right';
  ctx.fillText(label, originX - 14, y + CELL_H / 2 + 5);
  for (let c = 0; c < values.length; c++) {
    const val = values[c];
    const cx = originX + c * CELL_W;
    const color = opts.colorFn ? opts.colorFn(val) : scoreToColor(val);
    ctx.fillStyle = colorStr(color);
    ctx.fillRect(cx, y + 2, CELL_W, CELL_H - 4);
  }
}

for (let i = 0; i < data.categories.length; i++) {
  drawRow(data.categories[i], data.scores[i], i * CELL_H);
}

const sepY = originY + gridRows * CELL_H + SEPARATOR_H / 2;
ctx.strokeStyle = '#3a3a50';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(originX - LABEL_W + 20, sepY);
ctx.lineTo(originX + gridW - 10, sepY);
ctx.stroke();

drawRow('OVERALL', overallScores, gridRows * CELL_H + SEPARATOR_H, {
  bold: true,
  labelColor: '#f0f0ff',
});

const hallucColorFn = (val) => {
  if (val === null || val === undefined) return { r: 60, g: 60, b: 68 };
  // val is a percent (0..100). Higher = worse → red.
  const t = 1 - Math.min(val / 100, 1);
  let r, g, b;
  if (t < 0.5) {
    const u = t / 0.5;
    r = 220 + (245 - 220) * u;
    g = 60 + (180 - 60) * u;
    b = 60 + (50 - 60) * u;
  } else {
    const u = (t - 0.5) / 0.5;
    r = 245 + (56 - 245) * u;
    g = 180 + (195 - 180) * u;
    b = 50 + (100 - 50) * u;
  }
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
};

drawRow('hallucination rate', data.hallucinationRates,
  gridRows * CELL_H + SEPARATOR_H + CELL_H, {
    bold: true,
    labelColor: '#cc8888',
    colorFn: hallucColorFn,
  });

// Time axis labels
const axisY = originY + gridRows * CELL_H + SEPARATOR_H + CELL_H * 2 + 4;
ctx.font = '11px "Segoe UI Mono", Consolas, monospace';
ctx.fillStyle = '#8888aa';
ctx.textAlign = 'center';

const minLabelSpacing = 50;
const labelEvery = Math.max(1, Math.ceil(minLabelSpacing / CELL_W));

for (let i = 0; i < numPeriods; i += labelEvery) {
  const px = originX + i * CELL_W + CELL_W / 2;
  ctx.fillText(data.rangeLabels[i], px, axisY + 16);
  ctx.strokeStyle = '#3a3a50';
  ctx.beginPath();
  ctx.moveTo(px, axisY);
  ctx.lineTo(px, axisY + 6);
  ctx.stroke();
}
// Always label the last period
const lastPx = originX + (numPeriods - 1) * CELL_W + CELL_W / 2;
const prevLabelPx = originX + (numPeriods - 1 - ((numPeriods - 1) % labelEvery)) * CELL_W + CELL_W / 2;
if (lastPx - prevLabelPx > minLabelSpacing * 0.6 || numPeriods - 1 === 0) {
  ctx.fillStyle = '#b0b0cc';
  ctx.fillText(data.rangeLabels[numPeriods - 1], lastPx, axisY + 16);
  ctx.strokeStyle = '#5a5a70';
  ctx.beginPath();
  ctx.moveTo(lastPx, axisY);
  ctx.lineTo(lastPx, axisY + 6);
  ctx.stroke();
}

// Information-disclosure panel
let disclosureY = axisY + AXIS_H;
if (data.disclosure) {
  ctx.fillStyle = '#8888aa';
  ctx.font = '13px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Information-disclosure breakdown (information-boundary pairs)', PADDING, disclosureY + 16);

  const panelW = Math.min(gridW + 40, 720);
  const barH = 18;
  const barRowY = disclosureY + 36;
  const keys = ['refuse', 'partial', 'answer'];
  const labelColX = PADDING + 80;
  const barX = labelColX + 90;
  const barW = panelW - (barX - PADDING);

  ctx.font = '12px "Segoe UI Mono", Consolas, monospace';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const stats = data.disclosure[key];
    const y = barRowY + i * (barH + 12);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#a0a0c0';
    ctx.fillText(key, labelColX, y + barH - 4);

    // Background bar
    ctx.fillStyle = '#23233a';
    ctx.fillRect(barX, y, barW, barH);

    if (stats) {
      const w = Math.max(2, Math.round(barW * (stats.meanScore / 6)));
      const color = scoreToColor(stats.meanScore);
      ctx.fillStyle = colorStr(color);
      ctx.fillRect(barX, y, w, barH);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#d0d0e8';
      const pct = ((stats.meanScore / 6) * 100).toFixed(1);
      ctx.fillText(
        `${stats.meanScore.toFixed(2)}/6.0 (${pct}%) · n=${stats.evaluations}/${stats.uniquePairs} pairs · halluc ${stats.hallucinationRate.toFixed(0)}%`,
        barX + barW + 10, y + barH - 4,
      );
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = '#555570';
      ctx.fillText('(no data)', barX + barW + 10, y + barH - 4);
    }
  }
}

// Legend
const legendY = disclosureY + (data.disclosure ? DISCLOSURE_PANEL_H : 0) + SEPARATOR_H;
const barX = originX - 20;
const barW = Math.min(gridW, 400);
const barH = 16;
for (let px = 0; px < barW; px++) {
  const score = 6.0 * (1 - px / barW);
  const c = scoreToColor(score);
  ctx.fillStyle = colorStr(c);
  ctx.fillRect(barX + px, legendY, 1, barH);
}
const legendStops = [6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.0];
ctx.font = '12px "Segoe UI Mono", Consolas, monospace';
ctx.fillStyle = '#8888aa';
ctx.textAlign = 'center';
for (const score of legendStops) {
  const px = barX + barW * (1 - score / 6.0);
  ctx.fillText(score.toFixed(1), px, legendY + barH + 16);
}
ctx.textAlign = 'right';
ctx.font = '12px "Segoe UI", sans-serif';
ctx.fillStyle = '#8888aa';
ctx.fillText('composite score', barX - 10, legendY + 12);
ctx.fillStyle = colorStr({ r: 60, g: 60, b: 68 });
ctx.beginPath();
ctx.roundRect(barX + barW + 20, legendY, 24, barH, 4);
ctx.fill();
ctx.textAlign = 'left';
ctx.fillStyle = '#8888aa';
ctx.font = '12px "Segoe UI", sans-serif';
ctx.fillText('= no data', barX + barW + 50, legendY + 12);

// Footer
ctx.textAlign = 'center';
ctx.fillStyle = '#555570';
ctx.font = '11px "Segoe UI", sans-serif';
ctx.fillText(
  'Generated by recall-bench  ·  github.com/Stevenic/recall',
  totalW / 2,
  totalH - PADDING + 4,
);

const buf = canvas.toBuffer('image/png');
writeFileSync(outputPath, buf);
console.log(`Heatmap saved to ${outputPath} (${buf.length} bytes)`);
console.log(`  mode=${data.mode}  ${numPeriods} periods × ${data.categories.length + 2} rows`);
if (data.metadata.memory) console.log(`  memory=${data.metadata.memory}`);
if (data.metadata.synthesisModel) console.log(`  synthesis=${data.metadata.synthesisModel}`);
if (data.disclosure) console.log(`  disclosure rows rendered`);
