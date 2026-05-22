/**
 * In-process bench adapter that wraps the Recall memory service.
 *
 * Loaded by `recall-bench run --adapter` via a JS module path:
 *
 *   harness:
 *     adapter: ../../packages/recall-bench/dist/recall-adapter.js
 *     factory: createRecallAdapter
 *     config:
 *       model: openai:gpt-5.4-mini
 *       identity: |
 *         Jordan is an AI executive assistant ...
 *
 * Lifecycle (per BenchmarkHarness):
 *   setup()           — provision a fresh memory root, init MemoryService
 *   ingestDay(...)    — write memory/<date>.md
 *   finalizeIngestion — incremental sync + (optional) compaction / dreaming
 *                       must be idempotent across multi-checkpoint runs
 *   query(question)   — search + LLM-synthesize an answer
 *   teardown()        — delete the temp memory root if we created it
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    MemoryService,
    CliAgentModel,
    type MemoryModel,
    type CompleteOptions,
    type CompletionResult,
    type SearchResult,
} from 'recall';
import {
    OpenAiGeneratorModel,
    isOpenAiSpec,
    parseOpenAiSpec,
    isCliAgentName,
    isModelSpec,
    createModelFromSpec,
} from '@recall/bench';
import type {
    CliAgentName,
    GeneratorModel,
    DayMetadata,
    MemorySystemAdapter,
    QueryDetail,
    RetrievalEntry,
} from '@recall/bench';

export interface RecallAdapterConfig {
    /**
     * Display name for the system under test. Surfaced in the bench report.
     * Default: "Recall".
     */
    name?: string;

    /**
     * Optional memory root. When omitted, the adapter creates a fresh temp
     * directory in setup() and removes it in teardown().
     */
    memoryRoot?: string;

    /**
     * Identity content written to <memoryRoot>/IDENTITY.md before the service
     * starts. Threaded into compaction and dreaming synthesis prompts.
     */
    identity?: string;

    /** Display name used as the H1 of IDENTITY.md. Default: same as `name`. */
    identityName?: string;

    /**
     * Model spec for compaction, dreaming, and query-time answer synthesis.
     * Accepts:
     *   - `openai` or `openai:<model-id>` — OpenAiGeneratorModel (OPENAI_API_KEY)
     *   - `azure:<deployment>` — AzureOpenAiGeneratorModel (AZURE_OPENAI_* env)
     *   - `anthropic:<id>` — AnthropicGeneratorModel (ANTHROPIC_API_KEY)
     *   - `claude` / `codex` / `copilot` — CliAgentModel (subprocess)
     * Default: `openai:gpt-4o-mini`.
     */
    model?: string;

    /**
     * Pre-built MemoryModel instance, used in tests to inject a stub model
     * without standing up a real API client. When set, `model` is ignored.
     */
    modelInstance?: MemoryModel;

    /** Number of search results to retrieve per query. Default: 8. */
    searchK?: number;

    /**
     * Maximum number of characters of memory excerpts assembled into the
     * answer-synthesis prompt. Default: 8000.
     */
    contextBudget?: number;

    /**
     * Run compaction (daily → weekly → monthly) during finalizeIngestion.
     * Default: true.
     */
    enableCompaction?: boolean;

    /**
     * Run dreaming (wiki synthesis) during finalizeIngestion. Default: false.
     * Turning this on dramatically increases the model-call count.
     */
    enableDreaming?: boolean;
}

const DEFAULT_NAME = 'Recall';
const DEFAULT_SEARCH_K = 8;
const DEFAULT_CONTEXT_BUDGET = 8000;
const DEFAULT_MODEL = 'openai:gpt-4o-mini';

const SYSTEM_PROMPT_PREFIX = [
    'You are an assistant answering questions strictly from the memory excerpts provided.',
    'Be concise and direct. Quote names, dates, and specific values exactly when they appear in the excerpts.',
    'If the excerpts do not contain enough information to answer, say so plainly rather than guessing.',
].join(' ');

/**
 * Bridge that exposes a bench {@link GeneratorModel} (openai / anthropic /
 * azure) as a core {@link MemoryModel}. GeneratorModel splits system/user
 * prompts; MemoryModel takes a single prompt with an optional systemPrompt
 * option, so we map between them.
 */
class GeneratorMemoryModel implements MemoryModel {
    constructor(private readonly _model: GeneratorModel) {}

    async complete(
        prompt: string,
        options?: CompleteOptions,
    ): Promise<CompletionResult> {
        const systemPrompt = options?.systemPrompt ?? '';
        const opts: { temperature?: number; maxTokens?: number } = {};
        if (options?.temperature !== undefined) opts.temperature = options.temperature;
        if (options?.maxTokens !== undefined) opts.maxTokens = options.maxTokens;
        const result = await this._model.complete(systemPrompt, prompt, opts);
        const completion: CompletionResult = { text: result.text };
        if (result.inputTokens !== undefined) completion.inputTokens = result.inputTokens;
        if (result.outputTokens !== undefined) completion.outputTokens = result.outputTokens;
        return completion;
    }
}

function resolveModel(spec: string): MemoryModel {
    if (isCliAgentName(spec)) {
        return new CliAgentModel({ agent: spec as CliAgentName });
    }
    if (isOpenAiSpec(spec)) {
        const { model } = parseOpenAiSpec(spec);
        return new GeneratorMemoryModel(new OpenAiGeneratorModel({ model }));
    }
    if (isModelSpec(spec)) {
        return new GeneratorMemoryModel(createModelFromSpec(spec));
    }
    throw new Error(
        `Unrecognized model spec: "${spec}". Use "openai[:<id>]", "anthropic:<id>", "azure:<deployment>", or a CLI agent name (claude/codex/copilot).`,
    );
}

/**
 * Factory invoked by the bench profile loader (`harness.factory: createRecallAdapter`).
 * Returns a {@link MemorySystemAdapter} bound to the supplied config.
 */
export function createRecallAdapter(rawCfg: unknown): MemorySystemAdapter {
    const cfg = (rawCfg ?? {}) as RecallAdapterConfig;
    const name = cfg.name ?? DEFAULT_NAME;
    const searchK = cfg.searchK ?? DEFAULT_SEARCH_K;
    const contextBudget = cfg.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const enableCompaction = cfg.enableCompaction ?? true;
    const enableDreaming = cfg.enableDreaming ?? false;
    const modelSpec = cfg.model ?? DEFAULT_MODEL;

    let service: MemoryService | null = null;
    let memoryRoot: string | null = null;
    let createdTempRoot = false;
    let model: MemoryModel | null = null;
    const ingestedDates: Set<string> = new Set();
    let lastFinalizedSize = 0;

    async function runQueryDetail(question: string): Promise<QueryDetail> {
        if (!service || !model) throw new Error('Adapter not set up.');

        const results: SearchResult[] = await service.search(question, {
            maxResults: searchK,
            skipSync: true,
        });

        const retrieval: RetrievalEntry[] = results.map((r) => ({
            path: r.uri,
            score: r.score,
            snippet: (r.text ?? '').slice(0, 600),
        }));

        let used = 0;
        const chunks: string[] = [];
        for (const r of results) {
            const piece = `--- ${r.uri} (score: ${r.score.toFixed(2)})\n${r.text ?? ''}\n`;
            if (used + piece.length > contextBudget && chunks.length > 0) break;
            chunks.push(piece);
            used += piece.length;
        }
        const excerpts = chunks.join('\n').trim();
        const userPrompt =
            `Question: ${question}\n\nMemory excerpts:\n${excerpts || '(no relevant memories found)'}\n\nAnswer:`;

        const completion = await model.complete(userPrompt, {
            systemPrompt: SYSTEM_PROMPT_PREFIX,
            temperature: 0,
            maxTokens: 600,
        });
        return { answer: completion.text.trim(), retrieval };
    }

    const adapter: MemorySystemAdapter = {
        name,

        async setup(): Promise<void> {
            if (cfg.memoryRoot) {
                memoryRoot = path.resolve(cfg.memoryRoot);
                await fs.mkdir(memoryRoot, { recursive: true });
                createdTempRoot = false;
            } else {
                memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-bench-'));
                createdTempRoot = true;
            }

            if (cfg.identity) {
                const heading = `# ${cfg.identityName ?? name}\n\n`;
                await fs.writeFile(
                    path.join(memoryRoot, 'IDENTITY.md'),
                    heading + cfg.identity.trim() + '\n',
                    'utf-8',
                );
            }

            model = cfg.modelInstance ?? resolveModel(modelSpec);

            const serviceConfig: ConstructorParameters<typeof MemoryService>[0] = {
                memoryRoot,
                model,
                wiki: { enabled: true },
            };
            if (enableDreaming) {
                serviceConfig.dreaming = { enabled: true };
            }
            service = new MemoryService(serviceConfig);
            await service.initialize();

            ingestedDates.clear();
            lastFinalizedSize = 0;
        },

        async ingestDay(_day: number, content: string, metadata: DayMetadata): Promise<void> {
            if (!service || !memoryRoot) throw new Error('Adapter not set up.');
            const dailyPath = path.join(memoryRoot, 'memory', `${metadata.date}.md`);
            await fs.mkdir(path.dirname(dailyPath), { recursive: true });
            await fs.writeFile(dailyPath, content, 'utf-8');
            ingestedDates.add(metadata.date);
        },

        async finalizeIngestion(): Promise<void> {
            if (!service) throw new Error('Adapter not set up.');
            const currentSize = ingestedDates.size;
            if (currentSize === lastFinalizedSize) return;

            await service.sync();

            if (enableCompaction) {
                try {
                    await service.compact();
                } catch (err) {
                    process.stderr.write(
                        `[recall-adapter] compaction error: ${(err as Error).message}\n`,
                    );
                }
            }
            if (enableDreaming) {
                try {
                    await service.dream();
                } catch (err) {
                    process.stderr.write(
                        `[recall-adapter] dream error: ${(err as Error).message}\n`,
                    );
                }
            }
            lastFinalizedSize = currentSize;
        },

        async query(question: string): Promise<string> {
            const detail = await runQueryDetail(question);
            return detail.answer;
        },

        async queryDetail(question: string): Promise<QueryDetail> {
            return runQueryDetail(question);
        },

        async teardown(): Promise<void> {
            if (createdTempRoot && memoryRoot) {
                try {
                    await fs.rm(memoryRoot, { recursive: true, force: true });
                } catch {
                    // ignore
                }
            }
            service = null;
            memoryRoot = null;
            model = null;
            ingestedDates.clear();
            lastFinalizedSize = 0;
            createdTempRoot = false;
        },
    };

    return adapter;
}

export default createRecallAdapter;
