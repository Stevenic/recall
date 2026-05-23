/**
 * OpenClawMemoryAdapter — implements `MemorySystemAdapter` against OpenClaw's
 * built-in SQLite memory backend. See SPEC.md for design.
 */

import type { MemorySearchManager } from "@openclaw/memory-core/runtime-api.js";
import {
  closeAllMemorySearchManagers,
  createMemorySearchManager,
  registerOpenAiEmbeddingProvider,
} from "./manager.js";
import { synthesizeAnswer, type SynthesisModel } from "./synthesis.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  createWorkspace,
  destroyWorkspace,
  writeDayFile,
  type Workspace,
} from "./workspace.js";
import type { DayMetadata, MemorySystemAdapter } from "./types.js";

export interface OpenClawAdapterConfig {
  /** Embedding provider. 'auto' falls back to FTS-only when no provider is registered. Default: 'auto'. */
  embeddingProvider?: "auto" | "openai";
  /** Embedding model id. Default for OpenAI: 'text-embedding-3-small'. */
  embeddingModel?: string;
  /** Chat model used for adapter-side answer synthesis. Default: 'gpt-4.1-mini'. */
  synthesisModel?: string;
  /** Max search results to feed into synthesis. Default: 15. */
  maxSearchResults?: number;
  /** Min score threshold for search results. Default: 0.1. */
  minScore?: number;
  /** OpenAI API key for embeddings + synthesis. Falls back to OPENAI_API_KEY env. */
  openAiApiKey?: string;
  /**
   * Synthesis-side LLM provider. 'openai' (default) uses the standard OpenAI
   * SDK with OPENAI_API_KEY. 'azure' switches to AzureOpenAI for Azure
   * Foundry deployments; requires `azureEndpoint`, `azureApiVersion`, and an
   * Azure API key (config or AZURE_OPENAI_API_KEY env). The
   * `synthesisModel` field is interpreted as the Azure deployment name when
   * provider is 'azure'.
   */
  synthesisProvider?: "openai" | "azure";
  /** Azure resource base URL, e.g. `https://my-resource.openai.azure.com`. Falls back to AZURE_OPENAI_ENDPOINT. */
  azureEndpoint?: string;
  /** Azure API version. Falls back to AZURE_OPENAI_API_VERSION. */
  azureApiVersion?: string;
  /** Azure API key. Falls back to AZURE_OPENAI_API_KEY env. */
  azureApiKey?: string;
  /**
   * Answer mode. Default 'agent'. When 'agent' the harness exposes
   * memory_search/memory_get as OpenAI tools and lets the LLM drive
   * retrieval — mirrors OpenClaw's actual agent behavior. When 'synthesis'
   * the legacy single-shot path is used: the adapter retrieves all chunks up
   * front and stuffs them into one synthesis call.
   */
  answerMode?: "agent" | "synthesis";
  /** Max tool-loop iterations in agent mode. Default 6. */
  agentMaxIterations?: number;
  /**
   * Optional pre-built synthesis model. When supplied, `synthesisModel` and
   * `openAiApiKey` are ignored. Lets tests inject a fake without an API key.
   */
  synthesisModelImpl?: SynthesisModel;
  /**
   * Optional manager factory override. When supplied, replaces the default
   * `createMemorySearchManager` call. Lets tests run the full lifecycle
   * against a fake `MemorySearchManager` without OpenClaw being loaded.
   */
  managerFactory?: (params: {
    workspaceDir: string;
    indexPath: string;
    embeddingProvider: "auto" | "openai";
    embeddingModel?: string;
  }) => Promise<MemorySearchManager>;
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_SYNTHESIS_MODEL = "gpt-4.1-mini";

export class OpenClawMemoryAdapter implements MemorySystemAdapter {
  public readonly name: string;
  private readonly config: Required<
    Pick<OpenClawAdapterConfig, "embeddingProvider" | "maxSearchResults" | "minScore" | "answerMode" | "agentMaxIterations" | "synthesisProvider">
  > &
    Pick<OpenClawAdapterConfig, "embeddingModel" | "synthesisModel" | "openAiApiKey" | "azureEndpoint" | "azureApiVersion" | "azureApiKey">;
  private readonly synthesisOverride?: SynthesisModel;
  private readonly managerFactoryOverride?: OpenClawAdapterConfig["managerFactory"];

  private workspace: Workspace | null = null;
  private manager: MemorySearchManager | null = null;
  private synthesisModel: SynthesisModel | null = null;
  private agentOpenAi: { chat: { completions: { create: (p: unknown) => Promise<unknown> } } } | null = null;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.config = {
      embeddingProvider: config.embeddingProvider ?? "auto",
      embeddingModel: config.embeddingModel,
      synthesisModel: config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
      maxSearchResults: config.maxSearchResults ?? 15,
      minScore: config.minScore ?? 0.1,
      openAiApiKey: config.openAiApiKey,
      answerMode: config.answerMode ?? "agent",
      agentMaxIterations: config.agentMaxIterations ?? 6,
      synthesisProvider: config.synthesisProvider ?? "openai",
      azureEndpoint: config.azureEndpoint,
      azureApiVersion: config.azureApiVersion,
      azureApiKey: config.azureApiKey,
    };
    this.synthesisOverride = config.synthesisModelImpl;
    this.managerFactoryOverride = config.managerFactory;

    const provider =
      this.config.embeddingProvider === "openai"
        ? `vector:${this.config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL}`
        : "fts";
    const modeTag = this.config.answerMode === "agent" ? "+agent" : "+synthesis";
    this.name = `openclaw[${provider}${modeTag}]`;
  }

  async setup(): Promise<void> {
    if (this.workspace) {
      throw new Error("OpenClawMemoryAdapter.setup called twice without teardown");
    }
    this.workspace = await createWorkspace();

    if (this.config.embeddingProvider === "openai" && !this.managerFactoryOverride) {
      await registerOpenAiEmbeddingProvider();
    }
  }

  async ingestDay(_day: number, content: string, metadata: DayMetadata): Promise<void> {
    if (!this.workspace) {
      throw new Error("OpenClawMemoryAdapter.ingestDay called before setup");
    }
    await writeDayFile(this.workspace, metadata.date, content);
  }

  async finalizeIngestion(): Promise<void> {
    if (!this.workspace) {
      throw new Error("OpenClawMemoryAdapter.finalizeIngestion called before setup");
    }
    // Idempotent: first call constructs the manager; subsequent calls reuse it
    // and trigger a fresh sync so newly-ingested day files are picked up. This
    // lets the harness checkpoint after each incremental batch of days.
    if (!this.manager) {
      const factory = this.managerFactoryOverride ?? createMemorySearchManager;
      const params: Parameters<typeof createMemorySearchManager>[0] = {
        workspaceDir: this.workspace.rootDir,
        indexPath: this.workspace.indexPath,
        embeddingProvider: this.config.embeddingProvider,
      };
      if (this.config.embeddingModel !== undefined) {
        params.embeddingModel = this.config.embeddingModel;
      } else if (this.config.embeddingProvider === "openai") {
        params.embeddingModel = DEFAULT_EMBEDDING_MODEL;
      }
      this.manager = await factory(params);
    }
    // Incremental sync without `force: true`. Critical caveat: the manager's
    // sync() short-circuits unless `this.dirty` is set, and `dirty` is only
    // flipped by the chokidar filesystem watcher (manager-sync-ops.ts:1090).
    // The bench writes files and calls sync() back-to-back, so chokidar
    // hasn't fired yet — we must wait briefly for the watcher to observe
    // the new files and mark them dirty. 750ms is a generous margin over
    // chokidar's default stability threshold (~100ms) and still cheap (~750ms
    // per checkpoint vs. the ~25-min full-rebuild cost when force: true is
    // passed at day 500).
    await new Promise((resolve) => setTimeout(resolve, 750));
    await this.manager.sync?.({ reason: "recall-bench ingestion" });
  }

  async query(question: string): Promise<string> {
    const detail = await this.queryDetail(question);
    return detail.answer;
  }

  async queryDetail(question: string): Promise<{ answer: string; retrieval?: Array<{ path: string; score: number; snippet: string }> }> {
    if (!this.manager) {
      throw new Error("OpenClawMemoryAdapter.queryDetail called before finalizeIngestion");
    }
    if (!this.workspace) {
      throw new Error("OpenClawMemoryAdapter.queryDetail called before setup");
    }

    if (this.config.answerMode === "agent") {
      const openai = await this.resolveAgentClient();
      const result = await runAgentLoop(question, {
        openai,
        model: this.config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
        manager: this.manager,
        workspaceDir: this.workspace.rootDir,
        maxSearchResults: this.config.maxSearchResults,
        minScore: this.config.minScore,
        maxIterations: this.config.agentMaxIterations,
      });
      return { answer: result.answer, retrieval: result.retrieval };
    }

    // Legacy single-shot synthesis path.
    const results = await this.manager.search(question, {
      maxResults: this.config.maxSearchResults,
      minScore: this.config.minScore,
      sources: ["memory"],
    });
    const model = this.resolveSynthesisModel();
    const answer = await synthesizeAnswer(model, question, results);
    return {
      answer,
      retrieval: results.map((r) => ({ path: r.path, score: r.score, snippet: r.snippet })),
    };
  }

  /**
   * Lazy-build the chat client used by both the agent loop and the legacy
   * synthesis path. Returns an OpenAI-compatible interface — when
   * `synthesisProvider === 'azure'` the AzureOpenAI client is constructed
   * instead. Both expose `chat.completions.create` with the same shape so
   * downstream code is provider-agnostic.
   */
  private async resolveAgentClient(): Promise<NonNullable<typeof this.agentOpenAi>> {
    if (this.agentOpenAi) return this.agentOpenAi;
    const mod = (await import("openai")) as typeof import("openai");
    if (this.config.synthesisProvider === "azure") {
      const apiKey = this.config.azureApiKey ?? process.env.AZURE_OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Azure OpenAI API key not found. Set AZURE_OPENAI_API_KEY in your environment or pass `azureApiKey` in OpenClawAdapterConfig.",
        );
      }
      const endpoint = this.config.azureEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
      if (!endpoint) {
        throw new Error(
          "Azure OpenAI endpoint not found. Set AZURE_OPENAI_ENDPOINT in your environment or pass `azureEndpoint` in OpenClawAdapterConfig.",
        );
      }
      const apiVersion = this.config.azureApiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
      if (!apiVersion) {
        throw new Error(
          "Azure OpenAI API version not found. Set AZURE_OPENAI_API_VERSION in your environment or pass `azureApiVersion` in OpenClawAdapterConfig.",
        );
      }
      // AzureOpenAI's deployment is fixed per-client. We use synthesisModel
      // as the deployment name (mirroring AzureOpenAiGeneratorModel's
      // convention in recall-bench).
      const deployment = this.config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL;
      this.agentOpenAi = new mod.AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion,
        deployment,
        // Bench runs hit Azure quota windows; let the SDK ride out 429s
        // and transient 5xxs without crashing the harness.
        maxRetries: 10,
      }) as unknown as NonNullable<typeof this.agentOpenAi>;
      return this.agentOpenAi;
    }

    // Default: OpenAI direct.
    const resolvedKey = this.config.openAiApiKey ?? process.env.OPENAI_API_KEY;
    if (!resolvedKey) {
      throw new Error(
        "OpenAI API key not found. Set OPENAI_API_KEY in your environment or pass `openAiApiKey` in OpenClawAdapterConfig.",
      );
    }
    this.agentOpenAi = new mod.default({ apiKey: resolvedKey }) as unknown as NonNullable<typeof this.agentOpenAi>;
    return this.agentOpenAi;
  }

  async teardown(): Promise<void> {
    try {
      if (this.manager?.close) {
        await this.manager.close();
      }
    } finally {
      this.manager = null;
      // Always evict OpenClaw's process-wide cache, even if close() threw.
      await closeAllMemorySearchManagers().catch(() => {});
      if (this.workspace) {
        await destroyWorkspace(this.workspace);
        this.workspace = null;
      }
    }
  }

  private resolveSynthesisModel(): SynthesisModel {
    if (this.synthesisOverride) return this.synthesisOverride;
    if (this.synthesisModel) return this.synthesisModel;
    this.synthesisModel = buildDefaultSynthesisModel(
      this.config.synthesisModel ?? DEFAULT_SYNTHESIS_MODEL,
      this.config.openAiApiKey,
    );
    return this.synthesisModel;
  }
}

/**
 * Build the default OpenAI-backed synthesis model. Lazy-imports `openai` so
 * consumers that always pass a `synthesisModelImpl` (e.g., tests) never load it.
 */
function buildDefaultSynthesisModel(modelId: string, apiKey?: string): SynthesisModel {
  let cached: SynthesisModel | null = null;
  return {
    async complete(systemPrompt, userMessage, options) {
      if (!cached) {
        const { default: OpenAI } = (await import("openai")) as typeof import("openai");
        const resolvedKey = apiKey ?? process.env.OPENAI_API_KEY;
        if (!resolvedKey) {
          throw new Error(
            "OpenAI API key not found. Set OPENAI_API_KEY in your environment or pass `openAiApiKey` in OpenClawAdapterConfig.",
          );
        }
        const client = new OpenAI({ apiKey: resolvedKey });
        cached = {
          async complete(sys, usr, opts) {
            const params: Parameters<typeof client.chat.completions.create>[0] = {
              model: modelId,
              messages: [
                { role: "system", content: sys },
                { role: "user", content: usr },
              ],
            };
            if (opts?.temperature !== undefined) params.temperature = opts.temperature;
            if (opts?.maxTokens !== undefined) params.max_completion_tokens = opts.maxTokens;
            const response = await client.chat.completions.create(
              params as Parameters<typeof client.chat.completions.create>[0] & {
                stream?: false;
              },
            );
            const completion = response as Awaited<
              ReturnType<typeof client.chat.completions.create>
            > & {
              choices: Array<{ message?: { content?: string | null } }>;
            };
            const text = completion.choices[0]?.message?.content ?? "";
            return { text };
          },
        };
      }
      return cached.complete(systemPrompt, userMessage, options);
    },
  };
}
