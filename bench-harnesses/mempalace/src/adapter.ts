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
    buildOpenAiSynthesisModel,
    synthesizeAnswer,
    toRetrievalEntries,
    type SynthesisModel,
} from './synthesis.js';
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
     * Pre-built synthesis model. When supplied, `synthesisModel`/provider
     * fields are ignored. Lets tests inject a stub without an API key.
     */
    synthesisModelImpl?: SynthesisModel;
}

const DEFAULT_COMMAND = ['mempalace-mcp'];
const DEFAULT_SEARCH_K = 10;
const DEFAULT_CONTEXT_BUDGET = 8000;
const DEFAULT_MAX_DISTANCE = 1.5;
const DEFAULT_SYNTHESIS_MODEL = 'gpt-4.1-mini';
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
        const searchK = this.config.searchK ?? DEFAULT_SEARCH_K;
        const maxDistance = this.config.maxDistance ?? DEFAULT_MAX_DISTANCE;
        const raw = (await this.client.callTool(SEARCH_TOOL, {
            query: question,
            limit: searchK,
            max_distance: maxDistance,
        })) as MempalaceSearchResponse;
        if (raw?.error) {
            throw new Error(`mempalace_search error: ${raw.error}`);
        }
        const results = Array.isArray(raw?.results) ? raw.results : [];
        const synthesis = this.resolveSynthesisModel();
        const synthOpts: Parameters<typeof synthesizeAnswer>[3] = {
            contextBudget: this.config.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
        };
        if (this.config.identityName !== undefined) synthOpts.identityName = this.config.identityName;
        if (this.config.identity !== undefined) synthOpts.identity = this.config.identity;
        const answer = await synthesizeAnswer(synthesis, question, results, synthOpts);
        return { answer, retrieval: toRetrievalEntries(results) };
    }

    async teardown(): Promise<void> {
        try {
            if (this.client) await this.client.stop();
        } finally {
            this.client = null;
            this.synthesis = null;
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
