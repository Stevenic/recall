/**
 * MempalaceAdapter — implements MemorySystemAdapter against MemPalace's
 * `mempalace-mcp` server. See README.md for design.
 *
 * Lifecycle:
 *   setup()           — allocate a temp palace dir, spawn `mempalace-mcp`, MCP handshake
 *   ingestDay(...)    — `tools/call mempalace_add_drawer` with wing=persona, room=date
 *   finalizeIngestion — `tools/call mempalace_reconnect` so HNSW picks up the bulk writes
 *   query(question)   — `tools/call mempalace_search` + LLM-synthesized prose answer
 *   teardown()        — close stdin, await exit, rm -rf the temp palace dir
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpClient } from './mcp-client.js';
import {
    buildOpenAiChatClient,
    buildOpenAiSynthesisModel,
    synthesizeAnswer,
    toRetrievalEntries,
    type OpenAiChatClient,
    type OpenAiClientOptions,
    type SynthesisModel,
} from './synthesis.js';
import type { ChatCompleter, ChatCompletionParams, ChatCompletionResult } from './agent-loop.js';
import type {
    DayMetadata,
    MemorySystemAdapter,
    MempalaceSearchResponse,
    QueryDetail,
} from './types.js';

export interface MempalaceAdapterConfig {
    /**
     * Display name for the system under test. Surfaces in the bench report
     * and on heatmap rows. Default: derived from search/synthesis settings.
     */
    name?: string;

    /**
     * argv vector used to spawn the MCP server. The harness appends
     * `--palace <path>` automatically.
     *
     * Defaults to `["mempalace-mcp"]` (assumes the console script is on PATH).
     * Common overrides:
     *   - `["uv", "run", "--project", "C:/source/mempalace", "mempalace-mcp"]`
     *   - `["C:/source/mempalace/.venv/Scripts/mempalace-mcp.exe"]`
     *   - `["python", "-m", "mempalace.mcp_server"]`
     */
    mempalaceCommand?: string[];

    /**
     * Working directory for the spawned MCP process. Useful when
     * `mempalaceCommand` is a relative path or `uv` is run from a checkout.
     */
    cwd?: string;

    /**
     * Existing palace directory to reuse. When omitted, the adapter creates
     * a fresh temp directory in setup() and removes it in teardown().
     * Reuse is rarely useful for benchmarks — each run should start clean —
     * but supported for debugging an interrupted ingest.
     */
    palacePath?: string;

    /**
     * Extra env vars forwarded to the MCP subprocess. Merged onto the
     * parent process env; nothing is removed.
     */
    env?: Record<string, string>;

    /**
     * Per-MCP-request timeout (ms). Cold-start search (first call after
     * embedder load) can take ~15s; subsequent calls are sub-second.
     * Default: 60_000.
     */
    requestTimeoutMs?: number;

    /**
     * Number of search results to retrieve per query. Mempalace caps at
     * MAX_RESULTS internally (~50). Default: 10.
     */
    searchK?: number;

    /**
     * Max chars of memory excerpts assembled into the synthesis prompt.
     * Default: 8000.
     */
    contextBudget?: number;

    /**
     * Maximum search distance fed to mempalace. Lower = stricter.
     * Default: 1.5 (mempalace's own default).
     */
    maxDistance?: number;

    /**
     * Wing name to file every day under. Default: the persona id from
     * `DayMetadata.personaId`. Override if you want all personas in one wing
     * (e.g., shared-memory experiments).
     */
    wingOverride?: string;

    /**
     * Synthesis-side LLM provider. 'openai' (default) uses the standard
     * OpenAI SDK + OPENAI_API_KEY. 'azure' switches to AzureOpenAI for Azure
     * Foundry deployments and reads the AZURE_OPENAI_* env vars; the
     * `synthesisModel` field is interpreted as the deployment name.
     */
    synthesisProvider?: 'openai' | 'azure';

    /** Chat model used for query-time answer synthesis. Default: 'gpt-4.1-mini'. */
    synthesisModel?: string;

    /** OpenAI API key (falls back to OPENAI_API_KEY). */
    openAiApiKey?: string;
    /** Azure resource base URL (falls back to AZURE_OPENAI_ENDPOINT). */
    azureEndpoint?: string;
    /** Azure API version (falls back to AZURE_OPENAI_API_VERSION). */
    azureApiVersion?: string;
    /** Azure API key (falls back to AZURE_OPENAI_API_KEY). */
    azureApiKey?: string;

    /** Display name used in the synthesis system prompt's identity line. */
    identityName?: string;
    /** Identity body threaded into the synthesis system prompt. */
    identity?: string;

    /**
     * Append an anti-elaboration clause to the synthesis system prompt.
     * Useful when retrieval is wide (high searchK or day rollup) and the
     * model starts adding adjacent facts it can't ground. Default: false.
     */
    tightenSynthesis?: boolean;

    /**
     * Day-rollup retrieval: after the initial top-K vector search, take the
     * top N unique rooms (ISO dates) from the result set and run one
     * room-scoped search per day to surface every chunk on that day. Then
     * dedupe by drawer_id and feed the union to synthesis.
     *
     * This addresses the "right day, wrong chunk" failure mode where the
     * embedder ranks a day's narrative chunk above its bullet-list chunk:
     * if the day made it into the initial top-K at all, the answer-bearing
     * chunk almost certainly makes it through after the room-scoped pull.
     *
     * Default: false. When true, `dayRollupTopN` (default 4) caps the
     * number of days expanded and `dayRollupPerRoomK` (default 50) caps
     * the per-room search limit.
     */
    dayRollup?: boolean;
    /** Max distinct rooms to expand when `dayRollup` is on. Default: 4. */
    dayRollupTopN?: number;
    /** Per-room search limit when `dayRollup` is on. Default: 50. */
    dayRollupPerRoomK?: number;

    /**
     * Answer-generation mode.
     *
     *   - `'synthesis'` (default): one search call + one LLM call. Optionally
     *     widened with `dayRollup`.
     *   - `'agent'`: expose `memory_search` (and `memory_get_day`) as OpenAI
     *     tools to the synthesis model and let it drive retrieval. Mirrors
     *     OpenClaw's `+agent` mode; closes the synthesis/cross-reference gap
     *     by letting the LLM refine its query mid-answer.
     */
    answerMode?: 'synthesis' | 'agent';
    /** Max tool-loop iterations in agent mode. Default: 6. */
    agentMaxIterations?: number;

    /**
     * Pre-built synthesis model. When supplied, `synthesisModel`/provider
     * fields are ignored. Lets tests inject a stub without an API key.
     */
    synthesisModelImpl?: SynthesisModel;

    /**
     * Pre-built chat completer for `answerMode: 'agent'`. When supplied,
     * the agent loop uses this instead of constructing an OpenAI client.
     * Lets tests stub the LLM/tool-use without an API key.
     */
    chatCompleterImpl?: ChatCompleter;
}

const DEFAULT_COMMAND = ['mempalace-mcp'];
const DEFAULT_SEARCH_K = 10;
const DEFAULT_CONTEXT_BUDGET = 8000;
const DEFAULT_MAX_DISTANCE = 1.5;
const DEFAULT_SYNTHESIS_MODEL = 'gpt-4.1-mini';
const DEFAULT_DAY_ROLLUP_TOP_N = 4;
const DEFAULT_DAY_ROLLUP_PER_ROOM_K = 50;
const DEFAULT_AGENT_MAX_ITERATIONS = 6;
const ADD_DRAWER_TOOL = 'mempalace_add_drawer';
const SEARCH_TOOL = 'mempalace_search';
const RECONNECT_TOOL = 'mempalace_reconnect';

export class MempalaceAdapter implements MemorySystemAdapter {
    public readonly name: string;

    private readonly config: MempalaceAdapterConfig;
    private client: McpClient | null = null;
    private palacePath: string | null = null;
    private createdTempPalace = false;
    private synthesis: SynthesisModel | null = null;
    private chatCompleter: ChatCompleter | null = null;
    private ingestedSinceFinalize = 0;

    constructor(config: MempalaceAdapterConfig = {}) {
        this.config = config;
        const provider = config.synthesisProvider ?? 'openai';
        const model = config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL;
        this.name = config.name ?? `mempalace[${provider}:${model}]`;
    }

    async setup(): Promise<void> {
        if (this.client) {
            throw new Error('MempalaceAdapter.setup called twice without teardown');
        }

        if (this.config.palacePath) {
            this.palacePath = resolvePath(this.config.palacePath);
            await mkdir(this.palacePath, { recursive: true });
            this.createdTempPalace = false;
        } else {
            this.palacePath = await mkdtemp(join(tmpdir(), `recall-mempalace-${randomUUID()}-`));
            this.createdTempPalace = true;
        }

        const command = this.config.mempalaceCommand ?? DEFAULT_COMMAND;
        const clientOpts: ConstructorParameters<typeof McpClient>[0] = {
            command,
            palacePath: this.palacePath,
        };
        if (this.config.cwd) clientOpts.cwd = this.config.cwd;
        if (this.config.env) clientOpts.env = this.config.env;
        if (this.config.requestTimeoutMs !== undefined) {
            clientOpts.requestTimeoutMs = this.config.requestTimeoutMs;
        }
        this.client = new McpClient(clientOpts);
        await this.client.start();
        this.ingestedSinceFinalize = 0;
    }

    async ingestDay(_day: number, content: string, metadata: DayMetadata): Promise<void> {
        if (!this.client) throw new Error('MempalaceAdapter.ingestDay called before setup');
        const wing = this.config.wingOverride ?? metadata.personaId;
        const room = metadata.date;
        await this.client.callTool(ADD_DRAWER_TOOL, {
            wing,
            room,
            content,
            source_file: `day-${String(metadata.dayNumber).padStart(4, '0')}.md`,
            added_by: 'recall-bench',
        });
        this.ingestedSinceFinalize++;
    }

    async finalizeIngestion(): Promise<void> {
        if (!this.client) throw new Error('MempalaceAdapter.finalizeIngestion called before setup');
        if (this.ingestedSinceFinalize === 0) return;
        // Flush mempalace's metadata + chroma caches so the HNSW index reflects
        // the just-written drawers. Idempotent; safe to call when nothing was
        // ingested but we skip in that case to keep checkpoint overhead near zero.
        try {
            await this.client.callTool(RECONNECT_TOOL, {});
        } catch (err) {
            // Non-fatal: search has its own transient-index retry path. We log
            // and continue so a flaky reconnect doesn't fail the whole run.
            process.stderr.write(
                `[mempalace-adapter] reconnect failed (non-fatal): ${(err as Error).message}\n`,
            );
        }
        this.ingestedSinceFinalize = 0;
    }

    async query(question: string): Promise<string> {
        const detail = await this.queryDetail(question);
        return detail.answer;
    }

    async queryDetail(question: string): Promise<QueryDetail> {
        if (!this.client) throw new Error('MempalaceAdapter.queryDetail called before setup');

        if (this.config.answerMode === 'agent') {
            return this.runAgentQuery(question);
        }

        const results = await this.gatherSearchResults(question);
        const synthesis = this.resolveSynthesisModel();
        const synthOpts: Parameters<typeof synthesizeAnswer>[3] = {
            contextBudget: this.config.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
        };
        if (this.config.identityName !== undefined) synthOpts.identityName = this.config.identityName;
        if (this.config.identity !== undefined) synthOpts.identity = this.config.identity;
        if (this.config.tightenSynthesis) synthOpts.tightenSynthesis = true;
        const answer = await synthesizeAnswer(synthesis, question, results, synthOpts);
        return { answer, retrieval: toRetrievalEntries(results) };
    }

    /**
     * Single-shot vector search, optionally widened by day-rollup.
     *
     * When `dayRollup` is on we issue one room-scoped follow-up per top-N
     * day in the initial result set. The room-scoped call pulls every chunk
     * on that day (up to `dayRollupPerRoomK`), which surfaces bullet-list
     * answer chunks that lose the global cosine ranking to wordier narrative
     * chunks. Result sets are merged and de-duplicated by `(wing,room,text)`
     * since mempalace_search does not return drawer ids in its response.
     */
    private async gatherSearchResults(question: string) {
        const searchK = this.config.searchK ?? DEFAULT_SEARCH_K;
        const maxDistance = this.config.maxDistance ?? DEFAULT_MAX_DISTANCE;
        const initial = await this.searchOnce(question, { limit: searchK, maxDistance });

        if (!this.config.dayRollup || initial.length === 0) return initial;

        const topN = this.config.dayRollupTopN ?? DEFAULT_DAY_ROLLUP_TOP_N;
        const perRoomK = this.config.dayRollupPerRoomK ?? DEFAULT_DAY_ROLLUP_PER_ROOM_K;

        // Pick the top-N unique rooms by best (highest-similarity) chunk seen.
        // Rooms come out of mempalace as ISO dates; the same room can appear
        // many times in `initial`, so we keep the best-scoring chunk per room.
        const bestByRoom = new Map<string, number>();
        for (const r of initial) {
            const key = `${r.wing}::${r.room}`;
            const prev = bestByRoom.get(key) ?? -1;
            if ((r.similarity ?? 0) > prev) bestByRoom.set(key, r.similarity ?? 0);
        }
        const roomsByRank = [...bestByRoom.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topN)
            .map(([key]) => {
                const [wing, room] = key.split('::');
                return { wing: wing!, room: room! };
            });

        const merged = [...initial];
        for (const { wing, room } of roomsByRank) {
            const roomHits = await this.searchOnce(question, {
                limit: perRoomK,
                maxDistance,
                wing,
                room,
            });
            for (const r of roomHits) merged.push(r);
        }

        // Dedup by (wing, room, text-first-120-chars). Mempalace doesn't
        // return a drawer id from search, but two chunks colliding on wing
        // + room + the same opening 120 chars are the same chunk in practice
        // (chunks are 800 chars and the 100-char overlap leaves the opening
        // distinct).
        const seen = new Set<string>();
        const dedup: typeof merged = [];
        for (const r of merged) {
            const key = `${r.wing}::${r.room}::${(r.text ?? '').slice(0, 120)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            dedup.push(r);
        }
        // Sort by similarity descending so synthesis sees the strongest first.
        dedup.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
        return dedup;
    }

    private async searchOnce(
        query: string,
        opts: { limit: number; maxDistance: number; wing?: string; room?: string },
    ): Promise<MempalaceSearchResponse['results']> {
        if (!this.client) throw new Error('MempalaceAdapter.searchOnce called before setup');
        const args: Record<string, unknown> = {
            query,
            limit: opts.limit,
            max_distance: opts.maxDistance,
        };
        if (opts.wing) args['wing'] = opts.wing;
        if (opts.room) args['room'] = opts.room;
        const raw = (await this.client.callTool(SEARCH_TOOL, args)) as MempalaceSearchResponse;
        if (raw?.error) throw new Error(`mempalace_search error: ${raw.error}`);
        return Array.isArray(raw?.results) ? raw.results : [];
    }

    private async runAgentQuery(question: string): Promise<QueryDetail> {
        if (!this.client) throw new Error('MempalaceAdapter.runAgentQuery called before setup');
        const { runAgentLoop } = await import('./agent-loop.js');
        return runAgentLoop({
            question,
            client: this.client,
            searchTool: SEARCH_TOOL,
            maxIterations: this.config.agentMaxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS,
            searchK: this.config.searchK ?? DEFAULT_SEARCH_K,
            maxDistance: this.config.maxDistance ?? DEFAULT_MAX_DISTANCE,
            chatComplete: this.resolveChatCompleter(),
            identityName: this.config.identityName,
            identity: this.config.identity,
            tightenSynthesis: this.config.tightenSynthesis ?? false,
        });
    }

    private resolveChatCompleter(): ChatCompleter {
        if (this.config.chatCompleterImpl) return this.config.chatCompleterImpl;
        if (this.chatCompleter) return this.chatCompleter;
        const opts: OpenAiClientOptions = {
            provider: this.config.synthesisProvider ?? 'openai',
            model: this.config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
        };
        if (this.config.openAiApiKey !== undefined) opts.openAiApiKey = this.config.openAiApiKey;
        if (this.config.azureEndpoint !== undefined) opts.azureEndpoint = this.config.azureEndpoint;
        if (this.config.azureApiVersion !== undefined) opts.azureApiVersion = this.config.azureApiVersion;
        if (this.config.azureApiKey !== undefined) opts.azureApiKey = this.config.azureApiKey;
        const getClient = buildOpenAiChatClient(opts);
        this.chatCompleter = makeOpenAiChatCompleter(getClient, opts.model);
        return this.chatCompleter;
    }

    async teardown(): Promise<void> {
        try {
            if (this.client) await this.client.stop();
        } finally {
            this.client = null;
            this.synthesis = null;
            this.chatCompleter = null;
            if (this.createdTempPalace && this.palacePath) {
                try {
                    await rm(this.palacePath, { recursive: true, force: true });
                } catch {
                    // ignore — Windows file locks on chroma sqlite occasionally
                    // linger past process exit; the OS cleans tmpdir eventually.
                }
            }
            this.palacePath = null;
            this.createdTempPalace = false;
            this.ingestedSinceFinalize = 0;
        }
    }

    private resolveSynthesisModel(): SynthesisModel {
        if (this.config.synthesisModelImpl) return this.config.synthesisModelImpl;
        if (this.synthesis) return this.synthesis;
        const opts: Parameters<typeof buildOpenAiSynthesisModel>[0] = {
            provider: this.config.synthesisProvider ?? 'openai',
            model: this.config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
        };
        if (this.config.openAiApiKey !== undefined) opts.openAiApiKey = this.config.openAiApiKey;
        if (this.config.azureEndpoint !== undefined) opts.azureEndpoint = this.config.azureEndpoint;
        if (this.config.azureApiVersion !== undefined) opts.azureApiVersion = this.config.azureApiVersion;
        if (this.config.azureApiKey !== undefined) opts.azureApiKey = this.config.azureApiKey;
        this.synthesis = buildOpenAiSynthesisModel(opts);
        return this.synthesis;
    }
}

/**
 * Adapt a lazy OpenAI client into the agent loop's `ChatCompleter` contract.
 *
 * Translates our SDK-agnostic `ChatCompletionParams` shape into the OpenAI
 * Node SDK's `chat.completions.create` argument shape and the response back
 * into `ChatCompletionResult`. Kept here (not in `synthesis.ts`) so the
 * synthesis-mode path doesn't carry the tool-use wiring.
 */
function makeOpenAiChatCompleter(
    getClient: () => Promise<OpenAiChatClient>,
    model: string,
): ChatCompleter {
    return async function chatComplete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
        const client = await getClient();
        // Translate our message shape → OpenAI's. The only non-obvious case
        // is that an `assistant` message with `toolCalls` must include the
        // `tool_calls` field (with arguments serialized) so the follow-up
        // `tool` role messages reference valid call ids.
        const messages = params.messages.map((m) => {
            if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                return {
                    role: 'assistant',
                    content: m.content,
                    tool_calls: m.toolCalls.map((c) => ({
                        id: c.id,
                        type: 'function' as const,
                        function: { name: c.name, arguments: c.argumentsJson },
                    })),
                };
            }
            if (m.role === 'tool') {
                return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
            }
            return { role: m.role, content: m.content };
        });

        const req: Record<string, unknown> = { model, messages };
        if (params.tools && params.tools.length > 0) {
            req['tools'] = params.tools.map((t) => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parametersJsonSchema,
                },
            }));
            req['tool_choice'] = params.toolChoice ?? 'auto';
        }
        if (params.temperature !== undefined) req['temperature'] = params.temperature;
        if (params.maxTokens !== undefined) req['max_completion_tokens'] = params.maxTokens;

        const response = (await client.chat.completions.create(req)) as {
            choices: Array<{
                message?: {
                    content?: string | null;
                    tool_calls?: Array<{
                        id: string;
                        function?: { name?: string; arguments?: string };
                    }>;
                };
            }>;
        };

        const msg = response.choices?.[0]?.message;
        return {
            content: msg?.content ?? null,
            toolCalls: (msg?.tool_calls ?? []).map((c) => ({
                id: c.id,
                name: c.function?.name ?? '',
                argumentsJson: c.function?.arguments ?? '{}',
            })),
        };
    };
}
