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
import { SessionDayGenerator, loadPersonaDefinition, loadArcs, deriveSiblingDir } from './generator.js';
import { PersonaCreator, serializePersonaYaml, serializeArcsYaml } from './persona-creator.js';
import { ConversationGenerator, serializeConversation, serializeConversationJson } from './conversation-generator.js';
import { generateQa, generateBoundaryQa } from './qa-generator.js';
import { CliGeneratorModel, isCliAgentName, CLI_AGENT_NAMES } from './cli-generator-model.js';
import { OpenAiGeneratorModel, isOpenAiSpec, parseOpenAiSpec } from './openai-generator-model.js';
import { LlmJudge } from './llm-judge.js';
import { GrpcMemoryAdapter } from './grpc-memory-adapter.js';
import type { GeneratorModel } from './generator-types.js';
import type { HarnessConfig, TimeRangeKey, JudgeModel, MemorySystemAdapter } from './types.js';
import { TIME_RANGES } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const parseIntArg = (v: string) => parseInt(v, 10);
const parseFloatArg = (v: string) => parseFloat(v);

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
    .option('--judge <spec>', `Judge selector: a model spec (${CLI_AGENT_NAMES.join(', ')}, openai, openai:<model-id>) wrapped in an LLM judge, or a path to a JS module exporting a JudgeModel. Default: stub judge that returns zeros.`)
    .option('--personas <ids...>', 'Persona IDs to benchmark (default: all)')
    .option('--ranges <ranges...>', 'Time ranges to evaluate (30d, 90d, 6mo, 1y, full)', parseRanges)
    .option('--seed <n>', 'Shuffle seed (0 = no shuffle)', parseIntArg, 42)
    .option('--timeout <ms>', 'Per-question timeout', parseIntArg, 30000)
    .option('--grpc-timeout <ms>', 'Per-RPC timeout for gRPC adapter', parseIntArg, 120000)
    .option('--parallelism <n>', 'Max concurrent queries', parseIntArg, 1)
    .option('--json', 'Output JSON instead of text')
    .option('--heatmap', 'Output only the heatmap grid as JSON')
    .action(async (opts) => {
        const adapter = await resolveAdapter(opts.adapter, opts.grpcTimeout);
        const judge = opts.judge
            ? await resolveJudge(opts.judge, opts.timeout)
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
    .requiredOption('--persona <dir>', 'Path to persona directory (contains persona.yaml + arcs file)')
    .requiredOption('--model <name|path>', `Model selector: a CLI agent name (${CLI_AGENT_NAMES.join(', ')}), an OpenAI spec ('openai' or 'openai:<model-id>'; reads OPENAI_API_KEY), or a path to a JS module exporting a GeneratorModel`)
    .option('--arcs <filename>', 'Arcs file within the persona dir; convention: arcs-<NNN>d.yaml labeled by intended corpus duration (default: arcs-1000d.yaml)', 'arcs-1000d.yaml')
    .option('--memories-dir <dirname>', 'Memory output dir name within the persona dir; defaults to "memories" or "memories-<suffix>" derived from --arcs')
    .option('--days <n>', 'Total days to generate; sets --start 1 --end <n>. Mutually exclusive with --start/--end.', parseIntArg)
    .option('--start <n>', 'Starting day number', parseIntArg, 1)
    .option('--end <n>', 'Ending day number', parseIntArg, 1000)
    .option('--temperature <n>', 'Generation temperature', parseFloatArg, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per day', parseIntArg, 2000)
    .option('--history-window <n>', 'Number of recent days for context', parseIntArg, 3)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseIntArg, 600000)
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const personaDir = resolve(opts.persona);
        const persona = await loadPersonaDefinition(personaDir);
        const story = await loadArcs(personaDir, opts.arcs);
        const model = await resolveModel(opts.model, opts.timeout);

        // Resolve --days shorthand. If supplied, it overrides --start/--end.
        let startDay = opts.start;
        let endDay = opts.end;
        if (opts.days !== undefined) {
            startDay = 1;
            endDay = opts.days;
        }

        const memoriesDirName = opts.memoriesDir ?? deriveSiblingDir(opts.arcs, 'memories');
        const memoriesDir = join(personaDir, memoriesDirName);
        await mkdir(memoriesDir, { recursive: true });

        const writtenDays = new Set<number>();
        const generator = new SessionDayGenerator(persona, story.arcs, model, {
            startDay,
            endDay,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            historyWindow: opts.historyWindow,
            epoch: story.epoch,
            sessionLifecycles: story.sessions,
            onDay: async (dayNumber, content, _kind) => {
                const padded = String(dayNumber).padStart(4, '0');
                const filename = `day-${padded}.md`;
                await writeFile(join(memoriesDir, filename), content, 'utf-8');
                writtenDays.add(dayNumber);
                if (!opts.json) {
                    const dayLabel = `day ${String(dayNumber).padStart(4, ' ')}/${endDay}`;
                    console.log(`  [day]  ${dayLabel}  ${filename}  (${writtenDays.size} unique)`);
                }
            },
        });

        const result = await generator.generateAll();

        if (!opts.json) {
            console.log(`Done. Generated ${result.days.length} days for persona "${persona.name}" (${persona.id}).`);
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
    .requiredOption('--model <name|path>', `Model selector: a CLI agent name (${CLI_AGENT_NAMES.join(', ')}), an OpenAI spec ('openai' or 'openai:<model-id>'; reads OPENAI_API_KEY), or a path to a JS module exporting a GeneratorModel`)
    .requiredOption('--persona <dir>', 'Persona directory to write persona.yaml and arcs-1000d.yaml into')
    .option('--epoch <date>', 'Epoch date for the persona timeline', '2024-01-01')
    .option('--temperature <n>', 'Generation temperature', parseFloatArg, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per LLM call', parseIntArg, 4000)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseIntArg, 120000)
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
            await writeFile(join(personaDir, 'arcs-1000d.yaml'), serializeArcsYaml(result.arcs), 'utf-8');

            if (!opts.json) {
                console.log(' done.');
                console.log(`  Created ${result.arcs.length} arcs for "${persona.name}" (${persona.id}).`);
                console.log(`  Tokens — input: ${result.inputTokens}, output: ${result.outputTokens}`);
                console.log(`  Output: ${personaDir}/arcs-1000d.yaml`);
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
            await writeFile(join(personaDir, 'arcs-1000d.yaml'), serializeArcsYaml(result.arcs), 'utf-8');

            if (!opts.json) {
                console.log(' done.');
                console.log(`  Persona: "${result.persona.name}" (${result.persona.id})`);
                console.log(`  Arcs: ${result.arcs.length}`);
                console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
                console.log(`  Output: ${personaDir}/persona.yaml, ${personaDir}/arcs-1000d.yaml`);
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
    .requiredOption('--persona <dir>', 'Path to persona directory (contains persona.yaml + memories dir)')
    .requiredOption('--model <name|path>', `Model selector: a CLI agent name (${CLI_AGENT_NAMES.join(', ')}), an OpenAI spec ('openai' or 'openai:<model-id>'; reads OPENAI_API_KEY), or a path to a JS module exporting a GeneratorModel`)
    .option('--memories-dir <dirname>', 'Memory input dir name within the persona dir (default: "memories-1000d"; pair with the suffix used at generate time, e.g., "memories-180d")', 'memories-1000d')
    .option('--conversations-dir <dirname>', 'Conversation output dir name within the persona dir (default: "conversations" or derived from --memories-dir suffix)')
    .option('--days <n>', 'Total days to generate; sets --start 1 --end <n>. Mutually exclusive with --start/--end.', parseIntArg)
    .option('--start <n>', 'Starting day number', parseIntArg, 1)
    .option('--end <n>', 'Ending day number', parseIntArg, 1000)
    .option('--temperature <n>', 'Generation temperature', parseFloatArg, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per conversation', parseIntArg, 4000)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseIntArg, 120000)
    .option('--format <fmt>', 'Output format: markdown or json', 'markdown')
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const personaDir = resolve(opts.persona);
        const persona = await loadPersonaDefinition(personaDir);
        const model = await resolveModel(opts.model, opts.timeout);

        // Resolve --days shorthand. If supplied, it overrides --start/--end.
        let startDay = opts.start;
        let endDay = opts.end;
        if (opts.days !== undefined) {
            startDay = 1;
            endDay = opts.days;
        }

        const memoriesDirName = opts.memoriesDir;
        // Mirror the suffix from --memories-dir onto --conversations-dir if not explicitly set.
        // 'memories-1000d' -> 'conversations-1000d'; 'memories-180d' -> 'conversations-180d'.
        const conversationsDirName = opts.conversationsDir ??
            memoriesDirName.replace(/^memories/, 'conversations');
        const memoriesDir = join(personaDir, memoriesDirName);
        const conversationsDir = join(personaDir, conversationsDirName);
        await mkdir(conversationsDir, { recursive: true });

        const format = opts.format as 'markdown' | 'json';
        let convCount = 0;

        const generator = new ConversationGenerator(persona, model, {
            startDay,
            endDay,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            onConversation: async (dayNumber, _content) => {
                // We re-serialize here to control the format
                convCount++;
                if (!opts.json) {
                    process.stdout.write(`\r  Generated conversation ${convCount} (day ${dayNumber}/${endDay})`);
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

program
    .command('generate-qa')
    .description('Generate Q&A pairs incrementally for an existing memory corpus, in checkpoint windows')
    .requiredOption('--persona <dir>', 'Path to persona directory (contains persona.yaml + arcs file + memories dir)')
    .requiredOption('--model <name|path>', `Model selector: a CLI agent name (${CLI_AGENT_NAMES.join(', ')}), an OpenAI spec ('openai' or 'openai:<model-id>'; reads OPENAI_API_KEY), or a path to a JS module exporting a GeneratorModel`)
    .option('--mode <mode>', 'standard (default) or boundary (probe questions for isolated sessions)', 'standard')
    .option('--arcs <filename>', 'Arcs file within the persona dir; convention: arcs-<NNN>d.yaml. Default: arcs-1000d.yaml.', 'arcs-1000d.yaml')
    .option('--memories-dir <dirname>', 'Memory input dir name; defaults to "memories" or "memories-<suffix>" derived from --arcs')
    .option('--qa-dir <dirname>', 'Q&A output dir name; defaults to "qa" or "qa-<suffix>" derived from --arcs')
    .option('--interval <n>', 'Days between checkpoints (default: 7 for standard, 30 for boundary)', parseIntArg)
    .option('--pairs-per-checkpoint <n>', 'Standard: pairs per checkpoint (default 12). Boundary: pairs per (isolated session × checkpoint) (default 2).', parseIntArg)
    .option('--query-session <id>', 'Boundary mode only: session the question is asked from. Default: principal.', 'principal')
    .option('--start <n>', 'First checkpoint day (defaults to --interval)', parseIntArg)
    .option('--end <n>', 'Last checkpoint day (inclusive); defaults to highest available memory day', parseIntArg)
    .option('--temperature <n>', 'Generation temperature', parseFloatArg, 0.7)
    .option('--max-tokens <n>', 'Max output tokens per checkpoint call', parseIntArg, 4000)
    .option('--timeout <ms>', 'Per-call timeout for CLI agents', parseIntArg, 600000)
    .option('--json', 'Output JSON summary instead of progress text')
    .action(async (opts) => {
        const personaDir = resolve(opts.persona);
        const persona = await loadPersonaDefinition(personaDir);
        const story = await loadArcs(personaDir, opts.arcs);
        const model = await resolveModel(opts.model, opts.timeout);

        const memoriesDirName = opts.memoriesDir ?? deriveSiblingDir(opts.arcs, 'memories');
        const qaDirName = opts.qaDir ?? deriveSiblingDir(opts.arcs, 'qa');
        const qaFile = join(personaDir, qaDirName, 'questions.yaml');

        const mode = opts.mode === 'boundary' ? 'boundary' : 'standard';

        if (mode === 'standard') {
            const config: Parameters<typeof generateQa>[0]['config'] = {
                interval: opts.interval ?? 7,
                pairsPerCheckpoint: opts.pairsPerCheckpoint ?? 12,
                temperature: opts.temperature,
                maxTokens: opts.maxTokens,
                epoch: story.epoch,
                onCheckpoint: async (checkpointDay, newPairs, totalPairs) => {
                    if (!opts.json) {
                        const dayLabel = `day ${String(checkpointDay).padStart(4, ' ')}`;
                        console.log(`  [qa]   ${dayLabel}  +${newPairs.length} pairs  (${totalPairs} total)`);
                    }
                },
            };
            if (opts.start !== undefined) config.startDay = opts.start;
            if (opts.end !== undefined) config.endDay = opts.end;

            const result = await generateQa({
                model,
                persona,
                story,
                personaDir,
                memoriesDirName,
                qaDirName,
                config,
            });

            if (!opts.json) {
                console.log(`Done. Generated ${result.pairs.length} total Q&A pairs for "${persona.name}" (${persona.id}).`);
                console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
                console.log(`  Output: ${qaFile}`);
            } else {
                console.log(JSON.stringify({
                    personaId: result.personaId,
                    totalPairs: result.pairs.length,
                    totalInputTokens: result.totalInputTokens,
                    totalOutputTokens: result.totalOutputTokens,
                    perCheckpointCounts: result.perCheckpointCounts,
                    outputFile: qaFile,
                }, null, 2));
            }
        } else {
            const boundaryConfig: Parameters<typeof generateBoundaryQa>[0]['config'] = {
                interval: opts.interval ?? 30,
                pairsPerSessionPerCheckpoint: opts.pairsPerCheckpoint ?? 2,
                temperature: opts.temperature,
                maxTokens: opts.maxTokens,
                epoch: story.epoch,
                defaultQuerySession: opts.querySession,
                onCheckpoint: async (sessionId, checkpointDay, newPairs, totalPairs) => {
                    if (!opts.json) {
                        const dayLabel = `day ${String(checkpointDay).padStart(4, ' ')}`;
                        console.log(`  [qa-b] ${dayLabel}  ${sessionId.padEnd(20)}  +${newPairs.length} pairs  (${totalPairs} total)`);
                    }
                },
            };
            if (opts.start !== undefined) boundaryConfig.startDay = opts.start;
            if (opts.end !== undefined) boundaryConfig.endDay = opts.end;

            const result = await generateBoundaryQa({
                model,
                persona,
                story,
                personaDir,
                memoriesDirName,
                qaDirName,
                config: boundaryConfig,
            });

            const boundaryCount = result.pairs.filter(p => p.category === 'information-boundary').length;
            if (!opts.json) {
                console.log(`Done. Total pairs: ${result.pairs.length} (boundary: ${boundaryCount}).`);
                console.log(`  Tokens — input: ${result.totalInputTokens}, output: ${result.totalOutputTokens}`);
                console.log(`  Output: ${qaFile}`);
            } else {
                console.log(JSON.stringify({
                    personaId: result.personaId,
                    totalPairs: result.pairs.length,
                    boundaryPairs: boundaryCount,
                    totalInputTokens: result.totalInputTokens,
                    totalOutputTokens: result.totalOutputTokens,
                    perCheckpointCounts: result.perCheckpointCounts,
                    outputFile: qaFile,
                }, null, 2));
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

/**
 * Resolve a --judge value to a JudgeModel.
 *
 * Accepts the same syntax as --model (CLI agent name, openai spec, or
 * JS module path). Model specs are wrapped in an LLM judge; module paths
 * load a custom JudgeModel directly.
 */
async function resolveJudge(spec: string, timeout?: number): Promise<JudgeModel> {
    if (isCliAgentName(spec) || isOpenAiSpec(spec)) {
        const model = await resolveModel(spec, timeout);
        return new LlmJudge(model);
    }
    return loadModule<JudgeModel>(spec);
}

/**
 * Resolve a --model value to a GeneratorModel.
 * Accepts:
 *   - CLI agent name: claude, codex, copilot (subprocess to local CLI)
 *   - OpenAI spec: `openai` (default model) or `openai:<model-id>` (e.g.
 *     `openai:gpt-4o`, `openai:gpt-5`, `openai:o3-mini`). Reads OPENAI_API_KEY
 *     from the environment.
 *   - Path to a JS module that default-exports a GeneratorModel
 */
async function resolveModel(nameOrPath: string, timeout?: number): Promise<GeneratorModel> {
    if (isCliAgentName(nameOrPath)) {
        return new CliGeneratorModel({ agent: nameOrPath, timeout });
    }
    if (isOpenAiSpec(nameOrPath)) {
        const { model } = parseOpenAiSpec(nameOrPath);
        const config: { model: string; timeout?: number } = { model };
        if (timeout !== undefined) config.timeout = timeout;
        return new OpenAiGeneratorModel(config);
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
