# OpenClaw Default Memory Adapter — Specification

## 1. Overview

This document specifies how to implement a `MemorySystemAdapter` for recall-bench that exercises
OpenClaw's default (built-in SQLite) memory backend **in-process**, without standing up a full
OpenClaw runtime (no agent loop, no CLI, no plugin activation).

The adapter will:

1. Stand up an isolated workspace in a temp directory per benchmark run.
2. Write each day's corpus content as a `memory/YYYY-MM-DD.md` file matching OpenClaw's
   daily-notes layout.
3. Construct OpenClaw's `MemoryIndexManager` directly via its exported factory and trigger a
   single `sync` call so the content is chunked, embedded (optional), and indexed.
4. Answer questions by running OpenClaw's hybrid vector+BM25 `search`, then synthesizing a prose
   answer with an LLM (separate from OpenClaw — OpenClaw itself does retrieval only).
5. Tear down the workspace and release all resources after each run.

The adapter lives in a new package: `packages/recall-bench-openclaw/`.

---

## 2. Responsibility split: what OpenClaw does vs. what the adapter does

OpenClaw's memory system is **retrieval-only**. It indexes Markdown files into SQLite (FTS5 +
optional vector store via `sqlite-vec`) and returns ranked `MemorySearchResult[]` chunks. **No LLM
is invoked at any point in OpenClaw's index or search path.**

| Concern                    | Owner    | Notes                                                         |
|----------------------------|----------|---------------------------------------------------------------|
| Markdown chunking          | OpenClaw | `chunkMarkdown` heuristic, splits on headings/paragraphs       |
| BM25 (FTS5) ranking        | OpenClaw | Always available, no external services                         |
| Vector embeddings          | OpenClaw | Optional; requires a registered embedding provider             |
| Hybrid score merging + MMR | OpenClaw | Built into `MemoryIndexManager.search`                         |
| Temporal decay             | OpenClaw | Applied during search; tunable per agent config                |
| Answer synthesis (prose)   | Adapter  | LLM call against retrieved chunks; OpenClaw is uninvolved      |
| Question scoring           | recall-bench judge | Independent of both                                  |

Practically: the adapter needs an LLM only for step 4 (synthesizing a prose answer). OpenAI's
chat completions are a fine default. Embeddings are a separate concern — needed only for vector
mode, also satisfiable with OpenAI (`text-embedding-3-small`).

---

## 3. Adapter Lifecycle → OpenClaw Mapping

| Adapter call                        | OpenClaw action                                                              |
|-------------------------------------|------------------------------------------------------------------------------|
| `setup()`                           | Create temp workspace; (vector mode) register OpenAI embedding adapter       |
| `ingestDay(day, content, metadata)` | Write `memory/<metadata.date>.md`; queue for sync                            |
| `finalizeIngestion()`               | `getMemorySearchManager(...)` → `manager.sync({ force: true })`              |
| `query(question)`                   | `manager.search(question, { sources: ['memory'] })` → assemble → LLM answer  |
| `teardown()`                        | `manager.close()` → `closeAllMemorySearchManagers()` → delete temp workspace |

---

## 4. Workspace Layout

The adapter creates a temp directory mimicking the structure OpenClaw expects:

```
<tmpDir>/
  MEMORY.md               ← stub file (OpenClaw treats this as a root memory note)
  memory/
    2026-01-01.md         ← day 1 content
    2026-01-02.md         ← day 2 content
    …
  index.sqlite            ← created by OpenClaw on first sync
```

**File naming**: Use `metadata.date` (ISO 8601, e.g., `2026-01-01`) from `DayMetadata` as the
filename. This maps naturally to OpenClaw's `memory/YYYY-MM-DD.md` convention.

**File content**: Write the corpus content verbatim. The content is already Markdown (headings,
paragraphs, bullet lists), which aligns with OpenClaw's chunking expectations.

**MEMORY.md stub**: Create `MEMORY.md` at the workspace root (OpenClaw treats it as a permanent
top-level memory note that's always indexed). A minimal one-line stub is fine; do not write
benchmark-specific durable facts here — they belong in the daily files.

---

## 5. Memory Manager Initialization

OpenClaw's `MemoryIndexManager` (which implements the `MemorySearchManager` interface) is
constructed via the `getMemorySearchManager` factory exported from `@openclaw/memory-core`'s
`runtime-api` entry point. There is **no** `createBuiltinMemorySearchManager` — the spec's
earlier reference to that name was incorrect.

```typescript
// packages/recall-bench-openclaw/src/manager.ts
import { getMemorySearchManager } from "@openclaw/memory-core/runtime-api";
import type {
  MemorySearchManager,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

export async function createOpenClawMemoryManager(params: {
  workspaceDir: string;
  indexPath: string;
  embeddingProvider: "openai" | "auto";
  embeddingModel?: string;
}): Promise<MemorySearchManager> {
  const cfg: OpenClawConfig = {
    memory: { backend: "builtin" },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: params.embeddingProvider,
          model: params.embeddingModel ?? "",
          store: { path: params.indexPath },
          cache: { enabled: false },
          // Disable file watcher and session-driven incremental sync — bench is batch-only.
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;

  const result = await getMemorySearchManager({ cfg, agentId: "main" });
  if (!result.manager) {
    throw new Error(result.error ?? "memory manager unavailable");
  }
  return result.manager;
}
```

This matches the pattern OpenClaw's own `manager.fts-only-reindex.test.ts` uses to instantiate
the manager standalone.

### 5.1 Adapter config surface

```typescript
export interface OpenClawAdapterConfig {
  /** Embedding provider. 'auto' falls back to FTS-only when no provider is registered. */
  embeddingProvider?: "openai" | "auto";
  /** Embedding model. Default for OpenAI: 'text-embedding-3-small'. */
  embeddingModel?: string;
  /** Chat model used for adapter-side answer synthesis (NOT OpenClaw). */
  synthesisModel?: string;
  /** Max search results to feed into synthesis. Default: 15. */
  maxSearchResults?: number;
  /** Min score threshold for search results. Default: 0.1. */
  minScore?: number;
  /** OpenAI API key for embeddings + synthesis. Falls back to OPENAI_API_KEY env. */
  openAiApiKey?: string;
}
```

### 5.2 FTS-only mode (default in CI)

`embeddingProvider: 'auto'` with no provider registered yields BM25-only ranking. No external
calls during sync or search. Ideal for offline reproducibility. Vector scores are absent;
hybrid merging degrades to pure lexical ranking.

### 5.3 Vector mode (recommended for production benchmark reporting)

Vector mode requires registering OpenClaw's OpenAI embedding adapter against the process-global
embedding-provider registry. This bypasses plugin activation entirely:

```typescript
// packages/recall-bench-openclaw/src/embedding-setup.ts
import { openAiMemoryEmbeddingProviderAdapter } from "@openclaw/openai/memory-embedding-adapter";
import { registerMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

let registered = false;
export function ensureOpenAiEmbeddingProviderRegistered(): void {
  if (registered) return;
  registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
  registered = true;
}
```

Then construct the manager with `embeddingProvider: "openai"` and ensure `OPENAI_API_KEY` is set
in the environment (or piped through OpenClaw's secret-input config — the simpler env-var path is
sufficient for benchmarking).

### 5.4 Lifecycle and isolation

`MemoryIndexManager` instances are cached process-wide by agent + workspace. The adapter's
`teardown()` must call both `manager.close()` and `closeAllMemorySearchManagers()` to evict the
cache; otherwise re-running with a fresh temp dir at the same path will reuse a stale manager.

For parallelism > 1, each worker must use a unique workspace path (include a UUID or the
range key in the path).

---

## 6. Ingestion Strategy

### 6.1 Write-then-sync

`ingestDay` writes the file to disk. No incremental indexing is triggered after each day. After
all days are written, `finalizeIngestion` instantiates the manager and calls `sync({ force: true })`
once. This is significantly faster than per-file syncing.

```typescript
async ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void> {
    const filename = `${metadata.date}.md`;
    await writeFile(join(this.memoryDir, filename), content, "utf8");
}

async finalizeIngestion(): Promise<void> {
    this.manager = await createOpenClawMemoryManager({ ... });
    await this.manager.sync?.({ reason: "recall-bench ingestion", force: true });
}
```

`force: true` ensures a clean reindex even if a stale `index.sqlite` was left from a prior run.

### 6.2 Re-use across time ranges

The harness calls `setup` → ingest N days → `finalizeIngestion` → queries → `teardown` for each
time-range window (30d, 90d, full, etc.). Each range gets its own clean workspace. The adapter
should delete and recreate the temp directory in `setup` if it already exists.

---

## 7. Query → Answer Pipeline

OpenClaw's `search` returns `MemorySearchResult[]` — ranked document chunks, not natural-language
answers. The adapter is responsible for synthesizing a prose answer from those chunks.

### 7.1 Search

```typescript
const results = await this.manager.search(question, {
    maxResults: this.config.maxSearchResults ?? 15,
    minScore: this.config.minScore ?? 0.1,
    sources: ["memory"],   // exclude session transcripts (none in this setup, but defensive)
});
```

### 7.2 Context Assembly

Concatenate the retrieved snippets in descending score order, with source attribution headers:

```
[2026-03-15] (score: 0.82)
<snippet text>

[2026-02-10] (score: 0.74)
<snippet text>
…
```

`MemorySearchResult.path` is the relative file path (e.g., `memory/2026-03-15.md`); strip the
`memory/` prefix and `.md` suffix for the header. Cap context at ~6,000 tokens (≈24,000 chars).
For synthesis-category questions whose evidence spans many snippets, raising `maxSearchResults`
to 20–25 may help.

### 7.3 LLM Synthesis (adapter-side, OpenAI chat completion)

```
System: You are a memory assistant. Answer the following question using ONLY the provided
memory excerpts. Be concise and specific. If the excerpts do not contain enough information to
answer, say "I don't have enough information in my memory to answer this."

User:
Question: <question>

Memory excerpts:
<context>
```

The model's response is returned verbatim as the adapter's answer string. Default model:
`gpt-4.1-mini`. Configurable via `synthesisModel`.

This is a **separate** OpenAI API call from any embedding calls — different endpoint, different
client. They share only the API key.

### 7.4 Model selection

Use the same model family as the recall-bench Q&A generation pipeline to minimize variance from
model-specific phrasing differences when judged. Default: `gpt-4.1-mini`.

---

## 8. Information-Boundary Questions

For Q&A pairs with `category: 'information-boundary'`, the question targets session isolation —
content that should NOT be disclosed across session boundaries in a multi-session setup.

OpenClaw's default memory backend does not enforce session boundaries at the file level;
isolation is an application concern. For v1 of this adapter:

- **Standard behavior**: All ingested content is visible to all queries. Boundary tests will
  naturally fail (disclose forbidden content) because the adapter has no isolation mechanism.
- **This is intentional**: The benchmark result documents that OpenClaw's default backend does
  not enforce information boundaries — accurate, useful signal.
- **Future work**: A second adapter variant (`OpenClawIsolatedAdapter`) could shard ingestion
  into per-session subdirectories and pass a `sessionKey` to `search` (OpenClaw supports
  `sessionKey` filtering on session-source results, though memory-source files are inherently
  global; an alternative is multiple workspaces, one per session).

---

## 9. Package Structure

```
packages/recall-bench-openclaw/
  package.json
  tsconfig.json
  src/
    index.ts             ← exports OpenClawAdapter, createOpenClawAdapter
    adapter.ts           ← MemorySystemAdapter implementation
    manager.ts           ← getMemorySearchManager wrapper + minimal OpenClawConfig
    embedding-setup.ts   ← registerMemoryEmbeddingProvider for OpenAI (vector mode)
    synthesis.ts         ← search → context → LLM answer pipeline
    workspace.ts         ← temp dir lifecycle (create, populate, delete)
  tests/
    adapter.test.ts      ← integration test, FTS-only mode
    adapter-vector.test.ts ← gated by OPENAI_API_KEY, vector mode
```

### 9.1 `package.json` dependencies

```json
{
  "dependencies": {
    "openclaw": "^2026.5.6",
    "@openclaw/memory-core": "workspace:*",
    "@openclaw/openai": "workspace:*",
    "openai": "^4.x"
  },
  "peerDependencies": {
    "@recall/recall-bench": "workspace:*"
  }
}
```

> **Note on package consumption**: `@openclaw/memory-core` and `@openclaw/openai` are currently
> private workspace packages inside the OpenClaw monorepo, and `extensions/memory-core/runtime-api.ts`
> is **not** in the published `openclaw` package's `exports` map (only the `plugin-sdk/memory-core-host-*`
> helper paths are). The adapter therefore needs either:
>
> 1. A workspace link to a local OpenClaw checkout (`pnpm link`/`workspace:*`), **or**
> 2. The OpenClaw team to publish a `memory-core/runtime-api` (or equivalent) entry point.
>
> This is a real coordination gap to surface to the OpenClaw maintainers before shipping.

---

## 10. Integration Test Plan

The integration test (`adapter.test.ts`) should validate the full pipeline without a live
embedding API, using FTS-only mode:

| Test                              | What it verifies                                                |
|-----------------------------------|-----------------------------------------------------------------|
| `setup` creates workspace         | Temp dir, `MEMORY.md`, and `memory/` exist after `setup()`      |
| `ingestDay` writes files          | `memory/2026-01-01.md` present with correct content             |
| `finalizeIngestion` indexes       | `manager.status().chunks > 0` after sync                        |
| `query` returns non-empty string  | Search + synthesis returns a string for a seeded question       |
| `teardown` cleans up              | Temp dir is deleted; `closeAllMemorySearchManagers()` succeeds  |
| Re-setup after teardown           | Second `setup()` starts clean (no leftover files)               |
| 30d cutoff respected              | Querying after 30d ingestion returns content from day 1–30 only |

A second test (`adapter-vector.test.ts`) gated on `OPENAI_API_KEY` exercises vector mode,
verifying that `manager.status().vector.available === true` after sync and that semantic
queries (paraphrased questions with no exact lexical overlap) retrieve the correct day.

---

## 11. CLI Integration

The adapter is constructable from a plain config object so it can be used from recall-bench's
CLI:

```typescript
// packages/recall-bench-openclaw/src/index.ts
export function createOpenClawAdapter(config?: OpenClawAdapterConfig): MemorySystemAdapter {
    return new OpenClawAdapter(config ?? {});
}
```

CLI invocation example:

```bash
recall-bench run \
  --adapter @recall/recall-bench-openclaw \
  --adapter-factory createOpenClawAdapter \
  --persona executive-assistant \
  --ranges 30d,90d,full
```

The factory function name is passed as `--adapter-factory`; the harness `import()`s the package
and calls the named export.

---

## 12. Open Questions

1. **Published entry point**: As called out in §9.1, OpenClaw needs to expose
   `getMemorySearchManager` / `MemoryIndexManager` from a stable published path. Until then the
   adapter depends on a local workspace link.

2. **Sync speed at scale**: OpenClaw's sync rebuilds the FTS and (when enabled) embedding tables
   on first run. For 1,000 days of content this may take 30–90 seconds without embeddings, and
   several minutes with. Consider caching the indexed DB between time-range runs if the content
   is a superset (full ⊇ 1y ⊇ 6mo ⊇ 90d ⊇ 30d) to avoid redundant re-indexing.

3. **Chunking granularity**: OpenClaw's default chunker splits on headings and paragraph
   boundaries. Corpus files use H1 session headers and H2 topic sections. Verify that chunks
   don't split mid-session in ways that lose context for synthesis questions.

4. **Temporal decay**: OpenClaw's search applies a half-life decay using file mtime. During
   benchmark ingestion, all files are written at approximately the same wall-clock time, so
   decay would be uniform and would not reflect the simulated timeline. Either:
   - Touch each `memory/YYYY-MM-DD.md` to set its mtime to the simulated date after writing, or
   - Set `temporalDecayWeight: 0` in the manager config (if the field is exposed on
     `ResolvedMemorySearchConfig` — verify before relying on it).

5. **Workspace caching for parallelism**: With workers > 1, each must use a unique workspace
   path. Include a UUID or range key in the temp dir name; the
   `closeAllMemorySearchManagers()` global cache is fine because each worker's keys are
   distinct.

6. **Embedding cache reuse across ranges**: OpenClaw's embedding cache is keyed by chunk hash.
   If the 30d/90d/full workspaces share file content, copying the prior workspace's
   `index.sqlite` forward as a warm start could eliminate redundant embedding API spend.
