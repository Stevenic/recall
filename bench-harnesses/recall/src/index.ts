/**
 * In-process bench adapter that wraps the Recall memory service.
 *
 * Loaded by `recall-bench run --adapter` via a JS module path:
 *
 *   harness:
 *     adapter: ../../packages/recall-bench/dist/recall-adapter.js
 *     factory: createRecallAdapter
 *     config:
 *       model: azure:gpt-5.4-mini
 *       answerMode: agent              # default; "synthesis" for legacy single-shot
 *       synthesisProvider: azure       # or "openai"
 *       identity: |
 *         Jordan is an AI executive assistant ...
 *
 * Lifecycle (per BenchmarkHarness):
 *   setup()           — provision a fresh memory root, init MemoryService
 *   ingestDay(...)    — write memory/<date>.md
 *   finalizeIngestion — incremental sync + (optional) compaction / dreaming
 *                       must be idempotent across multi-checkpoint runs
 *   query(question)   — agent loop (default) or single-shot synthesis
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
import { runAgentLoop } from './agent-loop.js';

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

    /**
     * Answer mode. Default 'agent'. When 'agent' the harness exposes
     * memory_search / memory_get as OpenAI tools and lets the LLM drive
     * retrieval — mirrors how a real agent uses Recall (and matches the
     * OpenClaw harness's measurement methodology). When 'synthesis' the
     * legacy single-shot path is used: search up front, stuff top-K
     * chunks into one synthesis call.
     */
    answerMode?: 'agent' | 'synthesis';

    /** Max tool-loop iterations in agent mode. Default 6. */
    agentMaxIterations?: number;

    /**
     * Synthesis/agent-side LLM provider. 'openai' (default) uses the
     * standard OpenAI SDK with OPENAI_API_KEY. 'azure' switches to
     * AzureOpenAI for Azure Foundry deployments; requires `azureEndpoint`,
     * `azureApiVersion`, and an Azure API key (config or
     * AZURE_OPENAI_API_KEY env). When provider is 'azure', the `model`
     * field's id-after-the-colon is interpreted as the Azure deployment.
     */
    synthesisProvider?: 'openai' | 'azure';

    /** Azure resource base URL, e.g. `https://my-resource.openai.azure.com`. Falls back to AZURE_OPENAI_ENDPOINT. */
    azureEndpoint?: string;
    /** Azure API version. Falls back to AZURE_OPENAI_API_VERSION. */
    azureApiVersion?: string;
    /** Azure API key. Falls back to AZURE_OPENAI_API_KEY env. */
    azureApiKey?: string;
}

const DEFAULT_NAME = 'Recall';
const DEFAULT_SEARCH_K = 8;
const DEFAULT_CONTEXT_BUDGET = 8000;
const DEFAULT_MODEL = 'openai:gpt-4o-mini';

const SYSTEM_PROMPT_PREFIX = [
    "You are an assistant answering from the agent's memory. Each MEMORY",
    'excerpt below is tagged with the date it was recorded.',
    '',
    'Read through the excerpts and answer the question from them. Extract',
    'specific facts, names, dates, and numbers verbatim from the excerpts',
    'when they appear. Be concise.',
    '',
    'If the excerpts contain a confident answer, give it directly and cite',
    'the source date in the form `(Source: YYYY-MM-DD)`. Do not cite file',
    'paths. If the excerpts do not contain a confident answer, say plainly',
    'that you checked the memory and did not find it — never invent details',
    "or fabricate names, dates, or numbers that aren't in the excerpts.",
].join('\n');

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
    // Compose an adapter name that distinguishes agent vs synthesis mode in
    // the bench report. Mirrors the OpenClaw harness's naming convention
    // (e.g. `openclaw[vector:text-embedding-3-small+agent]`).
    const baseName = cfg.name ?? DEFAULT_NAME;
    const modeTag = (cfg.answerMode ?? 'agent') === 'agent' ? '+agent' : '+synthesis';
    const name = `${baseName}${modeTag}`;
    const searchK = cfg.searchK ?? DEFAULT_SEARCH_K;
    const contextBudget = cfg.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const enableCompaction = cfg.enableCompaction ?? true;
    const enableDreaming = cfg.enableDreaming ?? false;
    const modelSpec = cfg.model ?? DEFAULT_MODEL;
    const answerMode = cfg.answerMode ?? 'agent';
    const agentMaxIterations = cfg.agentMaxIterations ?? 6;
    const synthesisProvider = cfg.synthesisProvider ?? 'openai';

    let service: MemoryService | null = null;
    let memoryRoot: string | null = null;
    let createdTempRoot = false;
    let model: MemoryModel | null = null;
    let agentOpenAi:
        | { chat: { completions: { create: (p: unknown) => Promise<unknown> } } }
        | null = null;
    const ingestedDates: Set<string> = new Set();
    let lastFinalizedSize = 0;

    /**
     * Lazy-build the chat client used by the agent loop. Same pattern the
     * OpenClaw harness uses — switches between OpenAI and AzureOpenAI based
     * on `synthesisProvider`.
     */
    async function resolveAgentClient(): Promise<NonNullable<typeof agentOpenAi>> {
        if (agentOpenAi) return agentOpenAi;
        const mod = (await import('openai')) as typeof import('openai');
        if (synthesisProvider === 'azure') {
            const apiKey =
                cfg.azureApiKey ?? process.env.AZURE_OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error(
                    'Azure OpenAI API key not found. Set AZURE_OPENAI_API_KEY or pass azureApiKey in RecallAdapterConfig.',
                );
            }
            const endpoint =
                cfg.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
            if (!endpoint) {
                throw new Error(
                    'Azure OpenAI endpoint not found. Set AZURE_OPENAI_ENDPOINT or pass azureEndpoint in RecallAdapterConfig.',
                );
            }
            const apiVersion =
                cfg.azureApiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
            if (!apiVersion) {
                throw new Error(
                    'Azure OpenAI API version not found. Set AZURE_OPENAI_API_VERSION or pass azureApiVersion in RecallAdapterConfig.',
                );
            }
            // The model spec for Azure is treated as the deployment name.
            // Strip a leading "azure:" prefix if present.
            const deployment = modelSpec.replace(/^azure:/i, '');
            agentOpenAi = new mod.AzureOpenAI({
                apiKey,
                endpoint,
                apiVersion,
                deployment,
                // Bench runs hit Azure quota windows; let the SDK ride out
                // 429s and transient 5xxs.
                maxRetries: 10,
            }) as unknown as NonNullable<typeof agentOpenAi>;
            return agentOpenAi;
        }

        // Default: OpenAI direct.
        const resolvedKey = process.env.OPENAI_API_KEY;
        if (!resolvedKey) {
            throw new Error(
                'OpenAI API key not found. Set OPENAI_API_KEY in your environment.',
            );
        }
        agentOpenAi = new mod.default({
            apiKey: resolvedKey,
        }) as unknown as NonNullable<typeof agentOpenAi>;
        return agentOpenAi;
    }

    async function runQueryDetail(question: string): Promise<QueryDetail> {
        if (!service) throw new Error('Adapter not set up.');
        if (!memoryRoot) throw new Error('Adapter memory root missing.');

        if (answerMode === 'agent') {
            const openai = await resolveAgentClient();
            // For Azure, the model id needs to be the deployment name (which
            // is what AzureOpenAI's client is already bound to). For OpenAI,
            // strip the "openai:" prefix and use what's left, or default.
            const modelId =
                synthesisProvider === 'azure'
                    ? modelSpec.replace(/^azure:/i, '')
                    : modelSpec.replace(/^openai:/i, '');
            const result = await runAgentLoop(question, {
                openai,
                model: modelId,
                service,
                memoryRoot,
                maxSearchResults: searchK,
                maxIterations: agentMaxIterations,
            });
            return { answer: result.answer, retrieval: result.retrieval };
        }

        // Legacy single-shot synthesis path.
        if (!model) throw new Error('Adapter not set up (model missing).');
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
