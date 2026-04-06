/**
 * Report generation — text summaries and heatmap-ready data structures.
 */

import type {
    BenchmarkResult,
    Category,
    HeatmapCell,
    PersonaResult,
    TimeRangeKey,
    TimeRangeResult,
} from './types.js';
import { CATEGORIES } from './types.js';

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

export function formatTextReport(result: BenchmarkResult): string {
    const lines: string[] = [];

    lines.push(`Recall Bench Report — ${result.adapterName}`);
    lines.push(`Timestamp: ${result.timestamp}`);
    lines.push(`Ranges: ${result.ranges.join(', ')}`);
    lines.push(`Personas: ${result.personas.length}`);
    lines.push('');

    for (const pr of result.personas) {
        lines.push(formatPersonaReport(pr));
        lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('AGGREGATE HEATMAP (category × time range)');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(formatHeatmapText(result.heatmap, result.ranges));

    return lines.join('\n');
}

function formatPersonaReport(pr: PersonaResult): string {
    const lines: string[] = [];

    lines.push(`───────────────────────────────────────────────────────────`);
    lines.push(`Persona: ${pr.personaId}`);
    lines.push(`───────────────────────────────────────────────────────────`);

    for (const rr of pr.rangeResults) {
        lines.push(formatRangeReport(rr));
    }

    lines.push('');
    lines.push('Heatmap (category × time range):');
    lines.push(formatHeatmapText(pr.heatmap, pr.rangeResults.map(r => r.range)));

    return lines.join('\n');
}

function formatRangeReport(rr: TimeRangeResult): string {
    const lines: string[] = [];
    const pct = (rr.overallScore / 6 * 100).toFixed(1);

    lines.push(`  [${rr.range}] Days: ${rr.daysIngested} | Questions: ${rr.questionsEvaluated} | Score: ${rr.overallScore.toFixed(2)}/6.0 (${pct}%) | Hallucination: ${rr.hallucinationRate.toFixed(1)}%`);

    // Category breakdown
    for (const cs of rr.categoryScores) {
        if (cs.questionCount === 0) continue;
        const catPct = (cs.meanScore / 6 * 100).toFixed(1);
        const label = cs.category.padEnd(28);
        lines.push(`    ${label} ${cs.meanScore.toFixed(2)}/6.0 (${catPct}%) [n=${cs.questionCount}]`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Heatmap (text)
// ---------------------------------------------------------------------------

function formatHeatmapText(cells: HeatmapCell[], ranges: TimeRangeKey[]): string {
    // Build a lookup: category → range → score
    const lookup = new Map<string, Map<string, { score: number; count: number }>>();
    for (const cell of cells) {
        if (!lookup.has(cell.category)) lookup.set(cell.category, new Map());
        lookup.get(cell.category)!.set(cell.range, { score: cell.score, count: cell.questionCount });
    }

    const rangeHeaders = ranges.map(r => r.padStart(8)).join('');
    const lines: string[] = [];
    lines.push(`${''.padEnd(30)}${rangeHeaders}`);
    lines.push(`${''.padEnd(30)}${'────────'.repeat(ranges.length)}`);

    for (const cat of CATEGORIES) {
        const catLookup = lookup.get(cat);
        const values = ranges.map(r => {
            const entry = catLookup?.get(r);
            if (!entry || entry.count === 0) return '   --   ';
            return `  ${entry.score.toFixed(1)}   `;
        }).join('');
        lines.push(`${cat.padEnd(30)}${values}`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Heatmap (structured for visualization)
// ---------------------------------------------------------------------------

export interface HeatmapGrid {
    /** Row labels (categories) */
    categories: Category[];
    /** Column labels (time ranges) */
    ranges: TimeRangeKey[];
    /** Row-major grid of scores. grid[catIdx][rangeIdx] */
    scores: (number | null)[][];
    /** Row-major grid of question counts */
    counts: (number | null)[][];
}

/**
 * Convert flat heatmap cells to a structured grid suitable for
 * chart libraries or terminal heatmap renderers.
 */
export function toHeatmapGrid(cells: HeatmapCell[], ranges: TimeRangeKey[]): HeatmapGrid {
    const lookup = new Map<string, { score: number; count: number }>();
    for (const cell of cells) {
        lookup.set(`${cell.category}::${cell.range}`, { score: cell.score, count: cell.questionCount });
    }

    const categories = [...CATEGORIES];
    const scores: (number | null)[][] = [];
    const counts: (number | null)[][] = [];

    for (const cat of categories) {
        const row: (number | null)[] = [];
        const countRow: (number | null)[] = [];
        for (const range of ranges) {
            const entry = lookup.get(`${cat}::${range}`);
            row.push(entry && entry.count > 0 ? entry.score : null);
            countRow.push(entry?.count ?? null);
        }
        scores.push(row);
        counts.push(countRow);
    }

    return { categories, ranges, scores, counts };
}

// ---------------------------------------------------------------------------
// JSON report
// ---------------------------------------------------------------------------

export function formatJsonReport(result: BenchmarkResult): string {
    return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Summary table (for quick comparison across adapters)
// ---------------------------------------------------------------------------

export interface SummaryRow {
    adapter: string;
    persona: string;
    range: TimeRangeKey;
    score: number;
    questions: number;
    hallucinationRate: number;
}

export function toSummaryTable(result: BenchmarkResult): SummaryRow[] {
    const rows: SummaryRow[] = [];
    for (const pr of result.personas) {
        for (const rr of pr.rangeResults) {
            rows.push({
                adapter: result.adapterName,
                persona: pr.personaId,
                range: rr.range,
                score: rr.overallScore,
                questions: rr.questionsEvaluated,
                hallucinationRate: rr.hallucinationRate,
            });
        }
    }
    return rows;
}
