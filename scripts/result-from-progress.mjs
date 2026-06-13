#!/usr/bin/env node
// Reconstruct a (partial) result.json for a bench run that finished its
// checkpoints but never wrote the final BenchmarkResult (crash/kill before the
// summary step). Mirrors BenchmarkHarness's checkpoint -> TimeRangeResult
// mapping (see loadResumeCheckpoints in harness.ts) and additionally rehydrates
// questionResults (and categoryScores[].scores) from questions.jsonl — so the
// output is higher-fidelity than a --resume reload, which drops per-question
// detail.
//
// "Partial" means: it covers exactly the checkpoints that actually ran. An
// interrupted run yields a result.json with fewer range columns; everything
// present is real harness output, nothing is invented.
//
// Usage:
//   node scripts/result-from-progress.mjs <run-dir> [--out <path>]
//   node scripts/result-from-progress.mjs <run-dir> --validate   # rebuild & diff vs existing result.json
//
// Reads <run-dir>/progress.jsonl (required) and <run-dir>/questions.jsonl
// (optional — without it, questionResults are empty, aggregates only).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function reconstruct(runDir, opts = {}) {
  const progress = readJsonl(join(runDir, 'progress.jsonl'));
  const questions = readJsonl(join(runDir, 'questions.jsonl'));

  const header = progress.find((r) => r.type === 'header');
  const summary = progress.find((r) => r.type === 'summary');
  const checkpoints = progress.filter((r) => r.type === 'checkpoint');
  if (!header) throw new Error('no header record in progress.jsonl');
  if (checkpoints.length === 0) throw new Error('no checkpoint records in progress.jsonl');

  // Group checkpoints by persona, preserving file order (= evaluation order).
  const byPersona = new Map();
  for (const ck of checkpoints) {
    if (!byPersona.has(ck.personaId)) byPersona.set(ck.personaId, []);
    byPersona.get(ck.personaId).push(ck);
  }

  // Per-persona question records, in file order (= evaluation order).
  const qByPersona = new Map();
  for (const q of questions) {
    if (!qByPersona.has(q.personaId)) qByPersona.set(q.personaId, []);
    qByPersona.get(q.personaId).push(q);
  }

  // uniqueQAPairCount is the full Q&A corpus size (dataset.qaPairs.length in
  // harness.ts), not the number evaluated. It lives in the summary record; a
  // truly-partial run (no summary) can't recover it from the jsonl, so allow a
  // --qa-total override and otherwise fall back to the distinct-evaluated count.
  const singlePersona = byPersona.size === 1;
  const resolveCorpus = (evaluatedDistinct) => {
    if (opts.qaTotal != null) return opts.qaTotal;
    if (summary && singlePersona && typeof summary.uniqueQAPairCount === 'number') return summary.uniqueQAPairCount;
    return evaluatedDistinct;
  };

  const personas = [];
  for (const [personaId, cks] of byPersona) {
    const qs = qByPersona.get(personaId) || [];
    // Bucket questions into checkpoints sequentially by questionsEvaluated.
    // questions.jsonl is appended in evaluation order and checkpoints run in
    // order, so checkpoint i owns the next questionsEvaluated[i] records. Fall
    // back to no buckets if the counts don't line up (e.g. question log was
    // truncated) so we never mis-assign.
    // Bucket question records into checkpoints by timestamp. Each checkpoint
    // record is written AFTER its questions are evaluated, so a question
    // belongs to the first checkpoint whose timestamp is >= the question's.
    // Questions after the last checkpoint's timestamp are orphans from a
    // checkpoint that was killed before writing its aggregate — dropped (and
    // reported), never mis-attached. Falls back to sequential slicing by
    // questionsEvaluated only if a record lacks a timestamp.
    const haveTimes = qs.every((q) => typeof q.timestamp === 'string') && cks.every((c) => typeof c.timestamp === 'string');
    const buckets = cks.map(() => []);
    let orphaned = 0;
    if (haveTimes) {
      for (const q of qs) {
        let idx = -1;
        for (let i = 0; i < cks.length; i++) {
          if (q.timestamp <= cks[i].timestamp) { idx = i; break; }
        }
        if (idx === -1) { orphaned++; continue; }
        buckets[idx].push(q);
      }
    } else {
      let cursor = 0;
      for (let i = 0; i < cks.length; i++) {
        const n = cks[i].questionsEvaluated || 0;
        buckets[i] = qs.slice(cursor, cursor + n);
        cursor += n;
      }
    }
    if (orphaned > 0) {
      process.stderr.write(
        `  [warn] ${personaId}: dropped ${orphaned} question record(s) logged after the last completed ` +
          `checkpoint (run killed mid-checkpoint) — no aggregate exists to attach them to.\n`,
      );
    }

    const rangeResults = cks.map((ck, ckIdx) => {
      const bucket = buckets[ckIdx];
      if (bucket.length !== (ck.questionsEvaluated || 0)) {
        process.stderr.write(
          `  [warn] ${personaId} ${ck.range?.label}: bucketed ${bucket.length} questions but checkpoint ` +
            `reports ${ck.questionsEvaluated} evaluated.\n`,
        );
      }

      // Per-category raw composite scores, in evaluation order.
      const scoresByCat = new Map();
      for (const q of bucket) {
        const cat = q.qa?.category;
        if (!scoresByCat.has(cat)) scoresByCat.set(cat, []);
        scoresByCat.get(cat).push(q.composite);
      }

      const categoryScores = (ck.categoryScores || []).map((c) => ({
        category: c.category,
        meanScore: c.meanScore ?? 0,
        questionCount: c.questionCount ?? 0,
        scores: scoresByCat.get(c.category) ?? [],
        eligibleCount: c.eligibleCount ?? 0,
      }));

      const questionResults = bucket.map((q) => ({
        qa: q.qa,
        systemAnswer: q.systemAnswer,
        score: q.score,
        compositeScore: q.composite,
        latencyMs: q.latencyMs,
      }));

      return {
        range: ck.range,
        daysIngested: ck.daysIngested,
        questionsEvaluated: ck.questionsEvaluated,
        overallScore: ck.overallScore,
        categoryScores,
        difficultyScores: ck.difficultyScores,
        hallucinationRate: ck.hallucinationRate,
        questionResults,
      };
    });

    const heatmap = buildHeatmap(rangeResults);
    const uniqueIds = new Set(qs.map((q) => q.qa?.id).filter(Boolean));
    personas.push({
      personaId,
      adapterName: header.adapterName,
      rangeResults,
      heatmap,
      totalIngestionMs: cks.reduce((s, c) => s + (c.ingestMs || 0), 0),
      totalQueryMs: cks.reduce((s, c) => s + (c.queryMs || 0), 0),
      uniqueQAPairCount: resolveCorpus(uniqueIds.size),
      totalEvalsRun: cks.reduce((s, c) => s + (c.questionsEvaluated || 0), 0),
    });
  }

  const aggregateHeatmap = aggregateHeatmaps(personas.map((p) => p.heatmap));
  const totalEvalsRun = personas.reduce((s, p) => s + p.totalEvalsRun, 0);
  const uniqueQAPairCount = personas.reduce((s, p) => s + p.uniqueQAPairCount, 0);
  const appellateInvocations = questions.filter((q) => q.usedAppellate).length;

  return {
    timestamp: header.timestamp,
    adapterName: header.adapterName,
    ranges: header.ranges,
    personas,
    heatmap: aggregateHeatmap,
    metadata: {
      durationMs: summary?.durationMs ?? null,
      totalEvalsRun: summary?.totalEvalsRun ?? totalEvalsRun,
      uniqueQAPairCount: summary?.uniqueQAPairCount ?? uniqueQAPairCount,
      sample: header.sample ?? null,
      judgeMemoryWindow: header.judgeMemoryWindow ?? 0,
      groupsEnabled: header.groupsEnabled ?? false,
      judgeModel: header.judgeModel ?? null,
      appellateJudgeModel: header.appellateJudgeModel ?? null,
      appellateInvocations: summary?.appellateInvocations ?? appellateInvocations,
      // Honesty marker: this file was rebuilt from progress.jsonl + questions.jsonl,
      // not written by a clean run. Remove if you need a byte-identical schema.
      reconstructed: true,
      reconstructedCheckpoints: checkpoints.length,
      reconstructedComplete: Boolean(summary),
    },
  };
}

function buildHeatmap(rangeResults) {
  const cells = [];
  for (const rr of rangeResults) {
    for (const c of rr.categoryScores) {
      cells.push({
        range: rr.range.label,
        category: c.category,
        score: c.meanScore,
        questionCount: c.questionCount,
        eligibleCount: c.eligibleCount,
      });
    }
  }
  return cells;
}

function aggregateHeatmaps(heatmaps) {
  if (heatmaps.length === 1) return heatmaps[0];
  const acc = new Map();
  for (const hm of heatmaps) {
    for (const cell of hm) {
      const key = `${cell.range} ${cell.category}`;
      const prev = acc.get(key) || { range: cell.range, category: cell.category, score: 0, questionCount: 0, eligibleCount: 0, _w: 0 };
      prev.score += cell.score * (cell.questionCount || 0);
      prev.questionCount += cell.questionCount || 0;
      prev.eligibleCount += cell.eligibleCount || 0;
      prev._w += cell.questionCount || 0;
      acc.set(key, prev);
    }
  }
  return [...acc.values()].map((c) => ({
    range: c.range,
    category: c.category,
    score: c._w > 0 ? c.score / c._w : 0,
    questionCount: c.questionCount,
    eligibleCount: c.eligibleCount,
  }));
}

// --- validation: rebuild a complete run and diff against its real result.json ---
function validate(runDir, opts = {}) {
  const realPath = join(runDir, 'result.json');
  if (!existsSync(realPath)) throw new Error(`no result.json in ${runDir} to validate against`);
  const real = JSON.parse(readFileSync(realPath, 'utf8'));
  const rebuilt = reconstruct(runDir, opts);
  const diffs = [];

  const rp = real.personas[0], bp = rebuilt.personas[0];
  const cmp = (label, a, b) => { if (a !== b) diffs.push(`${label}: real=${a} rebuilt=${b}`); };
  cmp('persona.rangeResults.length', rp.rangeResults.length, bp.rangeResults.length);
  cmp('persona.totalIngestionMs', rp.totalIngestionMs, bp.totalIngestionMs);
  cmp('persona.totalQueryMs', rp.totalQueryMs, bp.totalQueryMs);
  cmp('persona.uniqueQAPairCount', rp.uniqueQAPairCount, bp.uniqueQAPairCount);
  cmp('heatmap.length', real.heatmap.length, rebuilt.heatmap.length);

  const n = Math.min(rp.rangeResults.length, bp.rangeResults.length);
  for (let i = 0; i < n; i++) {
    const a = rp.rangeResults[i], b = bp.rangeResults[i];
    cmp(`rr[${i}].range.label`, a.range.label, b.range.label);
    cmp(`rr[${i}].overallScore`, a.overallScore, b.overallScore);
    cmp(`rr[${i}].hallucinationRate`, a.hallucinationRate, b.hallucinationRate);
    cmp(`rr[${i}].questionsEvaluated`, a.questionsEvaluated, b.questionsEvaluated);
    cmp(`rr[${i}].questionResults.length`, a.questionResults.length, b.questionResults.length);
    // category mean scores
    for (let j = 0; j < a.categoryScores.length; j++) {
      const ca = a.categoryScores[j], cb = b.categoryScores[j];
      cmp(`rr[${i}].cat[${ca.category}].meanScore`, ca.meanScore, cb?.meanScore);
      // raw scores as sorted multisets (order differs under parallelism)
      const sa = [...(ca.scores || [])].sort().join(','), sb = [...(cb?.scores || [])].sort().join(',');
      if (sa !== sb) diffs.push(`rr[${i}].cat[${ca.category}].scores: real=[${sa}] rebuilt=[${sb}]`);
    }
  }
  return { diffs, realCheckpoints: rp.rangeResults.length };
}

// --- main ---
const args = process.argv.slice(2);
const runDir = args[0];
if (!runDir) { console.error('usage: result-from-progress.mjs <run-dir> [--out <path>] [--qa-total <n>] | --validate'); process.exit(1); }

const qaTotalIdx = args.indexOf('--qa-total');
const opts = qaTotalIdx >= 0 ? { qaTotal: Number(args[qaTotalIdx + 1]) } : {};

if (args.includes('--validate')) {
  const { diffs, realCheckpoints } = validate(runDir, opts);
  if (diffs.length === 0) {
    console.log(`✓ VALIDATED: rebuilt result.json matches real one across ${realCheckpoints} checkpoints (ignoring score-array order + reconstruction marker).`);
  } else {
    console.log(`✗ ${diffs.length} mismatch(es):`);
    for (const d of diffs.slice(0, 40)) console.log('   ' + d);
  }
} else {
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : join(runDir, 'result.json');
  const result = reconstruct(runDir, opts);
  writeFileSync(out, JSON.stringify(result, null, 2));
  const p = result.personas[0];
  console.log(`Wrote ${out}`);
  console.log(`  persona=${p.personaId} checkpoints=${p.rangeResults.length} evals=${p.totalEvalsRun} complete=${result.metadata.reconstructedComplete}`);
}
