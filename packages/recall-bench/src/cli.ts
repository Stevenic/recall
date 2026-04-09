#!/usr/bin/env node

/**
 * recall-bench CLI — run benchmarks from the command line.
 */

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { BenchmarkHarness } from './harness.js';
import { formatTextReport, formatJsonReport, toHeatmapGrid } from './report.js';
import { listPersonas } from './dataset.js';
import { DayGenerator, loadPersonaDefinition, loadArcs } from './generator.js';
import { PersonaCreator, serializePersonaYaml, serializeArcsYaml } from './persona-creator.js';
import { ConversationGenerator, serializeConversation, serializeConversationJson } from './conversation-generator.js';
import { CliGeneratorModel, isCliAgentName, CLI_AGENT_NAMES } from './cli-generator-model.js';
import { GrpcMemoryAdapter } from './grpc-memory-adapter.js';
import type { GeneratorModel } from './generator-types.js';
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
    .requiredOption('--adapter <url|path>', 'gRPC URL (grpc://host:port) or path to adapter module')
    .requiredOption('--data <dir>', 'Path to dataset directory containing persona folders')
    .option('--judge <path>', 'Path to judge module (must export default JudgeModel)')
    .option('--personas <ids...>', 'Persona IDs to benchmark (default: all)')
    .option('--ranges <ranges...>', 'Time ranges to evaluate (30d, 90d, 6mo, 1y, full)', parseRanges)
    .option('--seed <n>', 'Shuffle seed (0 = no shuffle)', parseInt, 42)
    .option('--timeout <ms>', 'Per-question timeout', parseInt, 30000)
    .option('--grpc-timeout <ms>', 'Per-RPC timeout for gRPC adapter', parseInt, 120000)
    .option('--parallelism <n>', 'Max concurrent queries', parseInt, 1)
    .option('--json', 'Output JSON instead of text')
    .option('--heatmap', 'Output only the heatmap grid as JSON')
    .action(async (opts) => {
        const adapter = await resolveAdapter(opts.adapter, opts.grpcTimeout);
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

program
    .command('generate')
    .description('Generate daily memory logs for a persona using an LLM')
    .requiredOption('--persona <dir>', 'Path to persona directory (contains persona.yaml + arcs.yaml)')
    .requiredOption('--model <name|path>', `Agent name (${CLI_AGENT_NAMES.join(', ')}) or path to model module`)
    .option('--start <n>', 'Starting day number', parseInt, 1)
    .option('--end <n>', 'Ending day number', parseInt, 1000)
    .option('--temperature <n>', 'Generation temperature', parseFloat, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per day', parseInt, 2000)
    .option('--history-window <n>', 'Number of recent days for context', parseInt, 3)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseInt, 120000)
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const personaDir = resolve(opts.persona);
        const persona = await loadPersonaDefinition(personaDir);
        const arcs = await loadArcs(personaDir);
        const model = await resolveModel(opts.model, opts.timeout);

        const memoriesDir = join(personaDir, 'memories');
        await mkdir(memoriesDir, { recursive: true });

        let dayCount = 0;
        const generator = new DayGenerator(persona, arcs, model, {
            startDay: opts.start,
            endDay: opts.end,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            historyWindow: opts.historyWindow,
            onDay: async (dayNumber, content) => {
                const padded = String(dayNumber).padStart(4, '0');
                await writeFile(join(memoriesDir, `day-${padded}.md`), content, 'utf-8');
                dayCount++;
                if (!opts.json) {
                    process.stdout.write(`\r  Generated day ${dayNumber}/${opts.end}`);
                }
            },
        });

        const result = await generator.generateAll();

        if (!opts.json) {
            console.log(''); // newline after progress
            console.log(`Done. Generated ${dayCount} days for persona "${persona.name}" (${persona.id}).`);
            console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
            console.log(`  Output: ${memoriesDir}`);
        } else {
            console.log(JSON.stringify({
                personaId: result.personaId,
                daysGenerated: result.days.length,
                totalInputTokens: result.totalInputTokens,
                totalOutputTokens: result.totalOutputTokens,
                outputDir: memoriesDir,
            }, null, 2));
        }
    });

program
    .command('create-persona')
    .description('Create a new persona and story arcs from a text prompt using an LLM')
    .requiredOption('--prompt <text>', 'Description of the persona to create')
    .requiredOption('--model <name|path>', `Agent name (${CLI_AGENT_NAMES.join(', ')}) or path to model module`)
    .requiredOption('--persona <dir>', 'Persona directory to write persona.yaml and arcs.yaml into')
    .option('--epoch <date>', 'Epoch date for the persona timeline', '2024-01-01')
    .option('--temperature <n>', 'Generation temperature', parseFloat, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per LLM call', parseInt, 4000)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseInt, 120000)
    .option('--arcs-only', 'Only generate arcs for an existing persona (reads persona.yaml from --persona)')
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const model = await resolveModel(opts.model, opts.timeout);
        const personaDir = resolve(opts.persona);
        await mkdir(personaDir, { recursive: true });

        const creator = new PersonaCreator(model, {
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            epoch: opts.epoch,
        });

        if (opts.arcsOnly) {
            // Generate arcs for an existing persona
            const persona = await loadPersonaDefinition(personaDir);
            if (!opts.json) {
                process.stdout.write('  Generating arcs...');
            }
            const result = await creator.createArcs(persona);
            await writeFile(join(personaDir, 'arcs.yaml'), serializeArcsYaml(result.arcs), 'utf-8');

            if (!opts.json) {
                console.log(' done.');
                console.log(`  Created ${result.arcs.length} arcs for "${persona.name}" (${persona.id}).`);
                console.log(`  Tokens — input: ${result.inputTokens}, output: ${result.outputTokens}`);
                console.log(`  Output: ${personaDir}/arcs.yaml`);
            } else {
                console.log(JSON.stringify({
                    personaId: persona.id,
                    arcsCreated: result.arcs.length,
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                    outputDir: personaDir,
                }, null, 2));
            }
        } else {
            // Generate both persona and arcs
            if (!opts.json) {
                process.stdout.write('  Generating persona and arcs...');
            }
            const result = await creator.create(opts.prompt);
            await writeFile(join(personaDir, 'persona.yaml'), serializePersonaYaml(result.persona), 'utf-8');
            await writeFile(join(personaDir, 'arcs.yaml'), serializeArcsYaml(result.arcs), 'utf-8');

            if (!opts.json) {
                console.log(' done.');
                console.log(`  Persona: "${result.persona.name}" (${result.persona.id})`);
                console.log(`  Arcs: ${result.arcs.length}`);
                console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
                console.log(`  Output: ${personaDir}/persona.yaml, ${personaDir}/arcs.yaml`);
            } else {
                console.log(JSON.stringify({
                    personaId: result.persona.id,
                    personaName: result.persona.name,
                    arcsCreated: result.arcs.length,
                    totalInputTokens: result.totalInputTokens,
                    totalOutputTokens: result.totalOutputTokens,
                    outputDir: personaDir,
                }, null, 2));
            }
        }
    });

program
    .command('generate-conversations')
    .description('Generate conversation history for each day from existing daily logs (Pass 2)')
    .requiredOption('--persona <dir>', 'Path to persona directory (contains persona.yaml, memories/)')
    .requiredOption('--model <name|path>', `Agent name (${CLI_AGENT_NAMES.join(', ')}) or path to model module`)
    .option('--start <n>', 'Starting day number', parseInt, 1)
    .option('--end <n>', 'Ending day number', parseInt, 1000)
    .option('--temperature <n>', 'Generation temperature', parseFloat, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per conversation', parseInt, 4000)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseInt, 120000)
    .option('--format <fmt>', 'Output format: markdown or json', 'markdown')
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const personaDir = resolve(opts.persona);
        const persona = await loadPersonaDefinition(personaDir);
        const model = await resolveModel(opts.model, opts.timeout);

        const memoriesDir = join(personaDir, 'memories');
        const conversationsDir = join(personaDir, 'conversations');
        await mkdir(conversationsDir, { recursive: true });

        const format = opts.format as 'markdown' | 'json';
        let convCount = 0;

        const generator = new ConversationGenerator(persona, model, {
            startDay: opts.start,
            endDay: opts.end,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            onConversation: async (dayNumber, _content) => {
                // We re-serialize here to control the format
                convCount++;
                if (!opts.json) {
                    process.stdout.write(`\r  Generated conversation ${convCount} (day ${dayNumber}/${opts.end})`);
                }
            },
        });

        const result = await generator.generateAll(memoriesDir);

        // Write conversation files
        for (const conv of result.conversations) {
            const padded = String(conv.dayNumber).padStart(4, '0');
            const ext = format === 'json' ? 'json' : 'md';
            const content = format === 'json'
                ? serializeConversationJson(conv.turns)
                : serializeConversation(conv.turns);
            await writeFile(join(conversationsDir, `conv-${padded}.${ext}`), content, 'utf-8');
        }

        if (!opts.json) {
            console.log(''); // newline after progress
            console.log(`Done. Generated ${result.conversations.length} conversations for "${persona.name}" (${persona.id}).`);
            console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
            console.log(`  Output: ${conversationsDir}`);
        } else {
            console.log(JSON.stringify({
                personaId: result.personaId,
                conversationsGenerated: result.conversations.length,
                totalInputTokens: result.totalInputTokens,
                totalOutputTokens: result.totalOutputTokens,
                outputDir: conversationsDir,
            }, null, 2));
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

/**
 * Resolve a --model value to a GeneratorModel.
 * Accepts a CLI agent name (claude, codex, copilot) or a path to a JS module.
 */
async function resolveModel(nameOrPath: string, timeout?: number): Promise<GeneratorModel> {
    if (isCliAgentName(nameOrPath)) {
        return new CliGeneratorModel({ agent: nameOrPath, timeout });
    }
    const abs = resolve(nameOrPath);
    const mod = await import(abs);
    return mod.default as GeneratorModel;
}

/**
 * Resolve an --adapter value to a MemorySystemAdapter.
 * Accepts a gRPC URL (grpc://host:port) or a path to a JS module.
 */
async function resolveAdapter(urlOrPath: string, grpcTimeout?: number): Promise<MemorySystemAdapter> {
    if (GrpcMemoryAdapter.isGrpcUrl(urlOrPath)) {
        return GrpcMemoryAdapter.fromUrl(urlOrPath, { timeout: grpcTimeout });
    }
    return loadModule<MemorySystemAdapter>(urlOrPath);
}

/** Stub judge for dry runs — returns max scores. */
function createStubJudge(): JudgeModel {
    return {
        async score() {
            return { correctness: 0, completeness: 0, hallucination: 0, reasoning: 'No judge configured — stub scores.' };
        },
    };
}
