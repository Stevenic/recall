/**
 * Bridge to OpenClaw's `MemoryIndexManager`.
 *
 * All OpenClaw imports route through `@openclaw/memory-core/runtime-api`
 * (and `@openclaw/openai-provider/memory-embedding-adapter` for vector mode).
 * Type imports are erased at compile time; the actual modules are loaded
 * lazily inside the factory functions so tests using fakes never pull in
 * OpenClaw's full module graph.
 */

import type {
  MemorySearchManager,
  OpenClawConfig,
} from "@openclaw/memory-core/runtime-api.js";

const MEMORY_CORE_RUNTIME_API = "@openclaw/memory-core/runtime-api.js";
const OPENAI_MEMORY_EMBEDDING_ADAPTER = "@openclaw/openai-provider/memory-embedding-adapter.js";

type MemoryCoreModule = typeof import("@openclaw/memory-core/runtime-api.js");
type OpenAiEmbeddingAdapterModule =
  typeof import("@openclaw/openai-provider/memory-embedding-adapter.js");

let memoryCorePromise: Promise<MemoryCoreModule> | null = null;

/**
 * Lazy-load `@openclaw/memory-core/runtime-api`. Cached after first success.
 *
 * Lazy because: (a) tests use a fake `MemorySearchManager` and shouldn't pay
 * to load OpenClaw's full memory module graph (sqlite, chokidar, embedding
 * providers); (b) downstream consumers may construct the adapter without ever
 * calling `finalizeIngestion`/`query`.
 */
export async function loadOpenClawMemoryCore(): Promise<MemoryCoreModule> {
  memoryCorePromise ??= import(MEMORY_CORE_RUNTIME_API) as Promise<MemoryCoreModule>;
  return memoryCorePromise;
}

/**
 * Register OpenClaw's OpenAI memory-embedding adapter. Historically this was a
 * belt-and-suspenders explicit registration for vector mode, but OpenClaw's
 * own plugin-discovery already registers the openai adapter when its package
 * is reachable in node_modules (which it is here — it's a dep of this
 * harness). We just force-load the runtime so the discovery runs.
 *
 * Kept as an async no-op-ish hook so the adapter's setup signature stays the
 * same; future versions may re-introduce explicit registration if discovery
 * stops being reliable.
 */
let openAiEmbeddingRegistered = false;
export async function registerOpenAiEmbeddingProvider(): Promise<void> {
  if (openAiEmbeddingRegistered) return;
  await loadOpenClawMemoryCore();
  openAiEmbeddingRegistered = true;
}

export interface BuildManagerParams {
  workspaceDir: string;
  indexPath: string;
  embeddingProvider: "auto" | "openai";
  embeddingModel?: string;
}

/**
 * Build the minimal `OpenClawConfig` needed to instantiate
 * `MemoryIndexManager` for a single agent. Mirrors the canonical pattern in
 * `extensions/memory-core/src/memory/manager.fts-only-reindex.test.ts`.
 */
export function buildOpenClawConfig(params: BuildManagerParams): OpenClawConfig {
  return {
    memory: { backend: "builtin" },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: params.embeddingProvider,
          model: params.embeddingModel ?? "",
          store: { path: params.indexPath },
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

/**
 * Construct OpenClaw's `MemoryIndexManager` for the given workspace. Throws
 * if OpenClaw returns a null manager (e.g., misconfigured backend).
 */
export async function createMemorySearchManager(
  params: BuildManagerParams,
): Promise<MemorySearchManager> {
  const core = await loadOpenClawMemoryCore();
  const cfg = buildOpenClawConfig(params);
  const result = await core.getMemorySearchManager({ cfg, agentId: "main" });
  if (!result.manager) {
    throw new Error(
      `OpenClaw getMemorySearchManager returned no manager: ${result.error ?? "unknown"}`,
    );
  }
  return result.manager;
}

/** Close OpenClaw's process-wide manager cache. Safe even if OpenClaw never loaded. */
export async function closeAllMemorySearchManagers(): Promise<void> {
  if (!memoryCorePromise) return;
  const core = await memoryCorePromise;
  await core.closeAllMemorySearchManagers();
}

/** Test-only hook: reset cached lazy imports. */
export function __resetForTests(): void {
  memoryCorePromise = null;
  openAiEmbeddingRegistered = false;
}
