#!/usr/bin/env node

/**
 * recall-bench CLI — run benchmarks from the command line.
 */

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { BenchmarkHarness } from './harness.js';
import { formatTextReport, formatJsonReport, toHeatmapGrid } from './report.js';
import { listPersonas } from './dataset.js';
import type { HarnessConfig, TimeRangeKey, JudgeModel, MemorySystemAdapter } from './types.js';
import { TIME_RANGES } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
    .name('recall-bench')
    .description('Recall Bench — benchmark harness for agent memory systems')
    .version('0.1.0');

program
    .command('run')
    .description('Run a benchmark against a memory system adapter')
    .requiredOption('--adapter <path>', 'Path to adapter module (must export default MemorySystemAdapter)')
    .requiredOption('--data <dir>', 'Path to dataset directory containing persona folders')
    .option('--judge <path>', 'Path to judge module (must export default JudgeModel)')
    .option('--personas <ids...>', 'Persona IDs to benchmark (default: all)')
    .option('--ranges <ranges...>', 'Time ranges to evaluate (30d, 90d, 6mo, 1y, full)', parseRanges)
    .option('--seed <n>', 'Shuffle seed (0 = no shuffle)', parseInt, 42)
    .option('--timeout <ms>', 'Per-question timeout', parseInt, 30000)
    .option('--parallelism <n>', 'Max concurrent queries', parseInt, 1)
    .option('--json', 'Output JSON instead of text')
    .option('--heatmap', 'Output only the heatmap grid as JSON')
    .action(async (opts) => {
        const adapter = await loadModule<MemorySystemAdapter>(opts.adapter);
        const judge = opts.judge
            ? await loadModule<JudgeModel>(opts.judge)
            : createStubJudge();

        const config: HarnessConfig = {
            personas: opts.personas,
            ranges: opts.ranges,
            shuffleSeed: opts.seed,
            questionTimeoutMs: opts.timeout,
            parallelism: opts.parallelism,
        };

        const harness = new BenchmarkHarness(adapter, judge, opts.data, config);
        const result = await harness.run();

        if (opts.heatmap) {
            const grid = toHeatmapGrid(result.heatmap, result.ranges);
            console.log(JSON.stringify(grid, null, 2));
        } else if (opts.json) {
            console.log(formatJsonReport(result));
        } else {
            console.log(formatTextReport(result));
        }
    });

program
    .command('list')
    .description('List available personas in a dataset directory')
    .requiredOption('--data <dir>', 'Path to dataset directory')
    .option('--json', 'Output JSON')
    .action(async (opts) => {
        const personas = await listPersonas(opts.data);
        if (opts.json) {
            console.log(JSON.stringify(personas, null, 2));
        } else {
            console.log('Available personas:');
            for (const p of personas) {
                console.log(`  - ${p}`);
            }
        }
    });

program
    .command('ranges')
    .description('Show available time ranges and their day cutoffs')
    .option('--json', 'Output JSON')
    .action((opts) => {
        if (opts.json) {
            console.log(JSON.stringify(TIME_RANGES, null, 2));
        } else {
            console.log('Available time ranges:');
            for (const [key, days] of Object.entries(TIME_RANGES)) {
                console.log(`  ${key.padEnd(6)} → ${days} days`);
            }
        }
    });

program.parse();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRanges(value: string): TimeRangeKey[] {
    return value.split(',').map(s => {
        const trimmed = s.trim() as TimeRangeKey;
        if (!(trimmed in TIME_RANGES)) {
            throw new Error(`Invalid range: ${trimmed}. Valid: ${Object.keys(TIME_RANGES).join(', ')}`);
        }
        return trimmed;
    });
}

async function loadModule<T>(modulePath: string): Promise<T> {
    const abs = resolve(modulePath);
    const mod = await import(abs);
    return mod.default as T;
}

/** Stub judge for dry runs — returns max scores. */
function createStubJudge(): JudgeModel {
    return {
        async score() {
            return { correctness: 0, completeness: 0, hallucination: 0, reasoning: 'No judge configured — stub scores.' };
        },
    };
}
