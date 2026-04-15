#!/usr/bin/env node
/**
 * generate-heatmap.mjs
 *
 * Generates a recall-bench heatmap PNG with variable evaluation periods.
 *
 * Usage:
 *   node scripts/generate-heatmap.mjs [options]
 *
 * Options:
 *   --interval <days>   Evaluation period in days (default: 7)
 *   --days <total>      Total corpus days (default: 1000)
 *   --output <path>     Output file path (default: docs/recall-bench-heatmap.png)
 *
 * Requires: npm install canvas
 */

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
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

const intervalDays = parseInt(parseArg('interval', '7'), 10);
const totalDays = parseInt(parseArg('days', '1000'), 10);
const outputPath = parseArg('output', null)
  ? resolve(parseArg('output', null))
  : resolve(__dirname, '..', 'docs', 'recall-bench-heatmap.png');

// ---------------------------------------------------------------------------
// Generate evaluation periods
// ---------------------------------------------------------------------------
const periods = [];
for (let end = intervalDays; end <= totalDays; end += intervalDays) {
  periods.push(end);
}
// Include the final partial period if it doesn't land exactly
if (periods[periods.length - 1] < totalDays) {
  periods.push(totalDays);
}

const numPeriods = periods.length;

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------
const categories = [
  'factual-recall',
  'temporal-reasoning',
  'decision-tracking',
  'contradiction-resolution',
  'cross-reference',
  'recency-bias-resistance',
  'synthesis',
  'negative-recall',
];

// ---------------------------------------------------------------------------
// Sample data generator — simulates realistic score degradation curves
// ---------------------------------------------------------------------------

// Each category has a start score (at period 1) and an end score (at final period)
// plus a decay curve shape
const categoryProfiles = {
  'factual-recall':           { start: 5.5, end: 3.8, curve: 'linear' },
  'temporal-reasoning':       { start: 4.7, end: 2.9, curve: 'concave' },
  'decision-tracking':        { start: 5.3, end: 3.7, curve: 'linear' },
  'contradiction-resolution': { start: null, end: 2.4, curve: 'linear', availableAfterFraction: 0.15 },
  'cross-reference':          { start: 4.9, end: 3.1, curve: 'convex' },
  'recency-bias-resistance':  { start: 5.1, end: 2.6, curve: 'concave' },
  'synthesis':                { start: 4.3, end: 2.7, curve: 'linear' },
  'negative-recall':          { start: 5.6, end: 4.1, curve: 'convex' },
};

function interpolate(t, curve) {
  // t is 0..1 (fraction through the corpus)
  switch (curve) {
    case 'concave':  return t * t;           // slow start, fast drop later
    case 'convex':   return 1 - (1 - t) ** 2; // fast drop early, stabilizes
    case 'linear':
    default:         return t;
  }
}

function generateScores() {
  const scores = [];
  for (const cat of categories) {
    const profile = categoryProfiles[cat];
    const row = [];
    for (let i = 0; i < numPeriods; i++) {
      const t = numPeriods > 1 ? i / (numPeriods - 1) : 0;
      if (profile.start === null) {
        // Category becomes available after a fraction of the corpus
        if (t < profile.availableAfterFraction) {
          row.push(null);
          continue;
        }
        // Remap t for the available portion
        const availT = (t - profile.availableAfterFraction) / (1 - profile.availableAfterFraction);
        const startScore = 3.5; // score when first available
        const decay = interpolate(availT, profile.curve);
        row.push(startScore - (startScore - profile.end) * decay);
      } else {
        const decay = interpolate(t, profile.curve);
        row.push(profile.start - (profile.start - profile.end) * decay);
      }
    }
    scores.push(row);
  }
  return scores;
}

function generateOverallScores(scores) {
  const overall = [];
  for (let c = 0; c < numPeriods; c++) {
    let sum = 0, count = 0;
    for (let r = 0; r < scores.length; r++) {
      if (scores[r][c] !== null) { sum += scores[r][c]; count++; }
    }
    overall.push(count > 0 ? sum / count : null);
  }
  return overall;
}

function generateHallucinationRates() {
  // Hallucination rises from ~1% to ~10% across the corpus
  return periods.map((_, i) => {
    const t = numPeriods > 1 ? i / (numPeriods - 1) : 0;
    return 1.0 + 9.3 * (t ** 1.4);
  });
}

const scores = generateScores();
const overallScores = generateOverallScores(scores);
const hallucinationRates = generateHallucinationRates();

// ---------------------------------------------------------------------------
// Color scale — green (6.0) → amber (3.0) → red (0.0)
// ---------------------------------------------------------------------------
function scoreToColor(score) {
  if (score === null) return { r: 60, g: 60, b: 68 }; // dark gray for N/A

  const t = Math.max(0, Math.min(1, score / 6.0)); // 0..1

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

function colorStr(c) {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

// ---------------------------------------------------------------------------
// Layout constants — cells are narrow since we don't show text in them
// ---------------------------------------------------------------------------
const CELL_W = Math.max(4, Math.min(16, Math.floor(900 / numPeriods)));
const CELL_H = 32;
const LABEL_W = 240;
const PADDING = 32;
const TITLE_H = 60;
const LEGEND_H = 70;
const SEPARATOR_H = 16;
const FOOTER_H = 50;
const AXIS_H = 40; // space for time axis labels

const gridW = numPeriods * CELL_W;
const gridRows = categories.length;
const totalW = LABEL_W + gridW + PADDING * 2;
const totalH =
  PADDING + TITLE_H +
  gridRows * CELL_H +
  SEPARATOR_H +
  CELL_H /* overall */ +
  CELL_H /* hallucination */ +
  AXIS_H +
  SEPARATOR_H + LEGEND_H + FOOTER_H + PADDING;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const canvas = createCanvas(totalW, totalH);
const ctx = canvas.getContext('2d');

// Background
ctx.fillStyle = '#13131f';
ctx.fillRect(0, 0, totalW, totalH);

// Title
ctx.fillStyle = '#e8e8f0';
ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
ctx.textAlign = 'center';
ctx.fillText('Recall Bench — Aggregate Heatmap', totalW / 2, PADDING + 32);

const intervalLabel = intervalDays === 1 ? '1 day' :
  intervalDays === 7 ? '1 week' :
  intervalDays === 14 ? '2 weeks' :
  intervalDays === 30 ? '1 month' :
  `${intervalDays} days`;

ctx.font = '13px "Segoe UI", Arial, sans-serif';
ctx.fillStyle = '#8888aa';
ctx.fillText(
  `${totalDays} days  ·  ${intervalLabel} intervals  ·  ${numPeriods} evaluation points  ·  composite score (0–6)`,
  totalW / 2, PADDING + 52
);

const originX = PADDING + LABEL_W;
const originY = PADDING + TITLE_H;

// ---------------------------------------------------------------------------
// Draw rows (no score text — just colored cells)
// ---------------------------------------------------------------------------

function drawRow(label, values, yOffset, opts = {}) {
  const y = originY + yOffset;

  // Label
  ctx.font = opts.bold ? 'bold 14px "Segoe UI", sans-serif' : '14px "Segoe UI", sans-serif';
  ctx.fillStyle = opts.labelColor || '#d0d0e8';
  ctx.textAlign = 'right';
  ctx.fillText(label, originX - 14, y + CELL_H / 2 + 5);

  // Cells — color blocks only
  for (let c = 0; c < values.length; c++) {
    const val = values[c];
    const cx = originX + c * CELL_W;
    const color = opts.colorFn ? opts.colorFn(val) : scoreToColor(val);

    ctx.fillStyle = colorStr(color);
    ctx.fillRect(cx, y + 2, CELL_W, CELL_H - 4);
  }
}

// Category rows
for (let i = 0; i < categories.length; i++) {
  drawRow(categories[i], scores[i], i * CELL_H);
}

// Separator
const sepY = originY + gridRows * CELL_H + SEPARATOR_H / 2;
ctx.strokeStyle = '#3a3a50';
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(originX - LABEL_W + 20, sepY);
ctx.lineTo(originX + gridW - 10, sepY);
ctx.stroke();

// Overall row
drawRow('OVERALL', overallScores, gridRows * CELL_H + SEPARATOR_H, {
  bold: true,
  labelColor: '#f0f0ff',
});

// Hallucination rate row
const hallucColorFn = (val) => {
  if (val === null) return { r: 60, g: 60, b: 68 };
  const t = 1 - Math.min(val / 15, 1);
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

drawRow('hallucination rate', hallucinationRates,
  gridRows * CELL_H + SEPARATOR_H + CELL_H, {
    bold: true,
    labelColor: '#cc8888',
    colorFn: hallucColorFn,
  });

// ---------------------------------------------------------------------------
// Time axis labels
// ---------------------------------------------------------------------------
const axisY = originY + gridRows * CELL_H + SEPARATOR_H + CELL_H * 2 + 4;
ctx.font = '11px "Segoe UI Mono", Consolas, monospace';
ctx.fillStyle = '#8888aa';
ctx.textAlign = 'center';

// Determine which periods to label (don't overcrowd)
const minLabelSpacing = 50; // pixels between labels
const labelEvery = Math.max(1, Math.ceil(minLabelSpacing / CELL_W));

for (let i = 0; i < numPeriods; i += labelEvery) {
  const px = originX + i * CELL_W + CELL_W / 2;
  const dayNum = periods[i];
  let label;
  if (dayNum <= 90) label = `${dayNum}d`;
  else if (dayNum < 365) label = `${Math.round(dayNum / 30)}mo`;
  else label = `${(dayNum / 365).toFixed(1)}y`;

  ctx.fillText(label, px, axisY + 16);

  // Tick mark
  ctx.strokeStyle = '#3a3a50';
  ctx.beginPath();
  ctx.moveTo(px, axisY);
  ctx.lineTo(px, axisY + 6);
  ctx.stroke();
}

// Always label the last period
const lastPx = originX + (numPeriods - 1) * CELL_W + CELL_W / 2;
const lastDay = periods[numPeriods - 1];
let lastLabel;
if (lastDay <= 90) lastLabel = `${lastDay}d`;
else if (lastDay < 365) lastLabel = `${Math.round(lastDay / 30)}mo`;
else lastLabel = `${(lastDay / 365).toFixed(1)}y`;

// Only draw if it wouldn't overlap the previous label
const prevLabelPx = originX + (numPeriods - 1 - ((numPeriods - 1) % labelEvery)) * CELL_W + CELL_W / 2;
if (lastPx - prevLabelPx > minLabelSpacing * 0.6 || numPeriods - 1 === 0) {
  ctx.fillStyle = '#b0b0cc';
  ctx.fillText(lastLabel, lastPx, axisY + 16);
  ctx.strokeStyle = '#5a5a70';
  ctx.beginPath();
  ctx.moveTo(lastPx, axisY);
  ctx.lineTo(lastPx, axisY + 6);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Legend — continuous gradient bar
// ---------------------------------------------------------------------------
const legendY = axisY + AXIS_H + SEPARATOR_H;

// Draw gradient bar
const barX = originX - 20;
const barW = Math.min(gridW, 400);
const barH = 16;
for (let px = 0; px < barW; px++) {
  const score = 6.0 * (1 - px / barW);
  const c = scoreToColor(score);
  ctx.fillStyle = colorStr(c);
  ctx.fillRect(barX + px, legendY, 1, barH);
}

// Tick labels
const legendStops = [6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 0.0];
ctx.font = '12px "Segoe UI Mono", Consolas, monospace';
ctx.fillStyle = '#8888aa';
ctx.textAlign = 'center';
for (const score of legendStops) {
  const px = barX + barW * (1 - score / 6.0);
  ctx.fillText(score.toFixed(1), px, legendY + barH + 16);
}

// Legend title
ctx.textAlign = 'right';
ctx.font = '12px "Segoe UI", sans-serif';
ctx.fillStyle = '#8888aa';
ctx.fillText('composite score', barX - 10, legendY + 12);

// N/A swatch
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
  totalH - PADDING + 4
);

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
const buf = canvas.toBuffer('image/png');
writeFileSync(outputPath, buf);
console.log(`Heatmap saved to ${outputPath} (${buf.length} bytes)`);
console.log(`  ${numPeriods} periods × ${categories.length + 2} rows, cell width: ${CELL_W}px, image: ${totalW}×${totalH}`);
