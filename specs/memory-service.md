# Agent Memory Service — Design Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-02  
**Version:** 0.3

---

## 1. Overview

Recall is an agent memory service that manages the full lifecycle of agent memory — from raw daily logs through compacted weekly, monthly, and wisdom files — with semantic search over all of it. It exposes both a **CLI** and a **programmatic API**.

The teammates version of recall only manages the Vectra index. This version owns the entire memory stack: daily logs, weekly/monthly summaries, wisdom distillation, typed memories, and the vector index that makes them searchable.

### Goals

1. **Full memory lifecycle** — Create, read, update, compact, and search daily/weekly/monthly/wisdom files
2. **Pluggable abstractions** — Storage, embeddings, index, and model layers are all replaceable
3. **Local-first defaults** — Works offline with zero cloud dependencies out of the box
4. **CLI & API parity** — Every operation available programmatically is also available from the command line

### Non-Goals (for v1)

- Multi-user / shared memory
- Real-time sync across processes
- GUI / web interface
- Cloud-hosted index backends (planned for later)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                     CLI (recall)                    │
├─────────────────────────────────────────────────────┤
│                  MemoryService API                  │
├──────────┬──────────┬───────────┬───────────────────┤
│  Files   │  Search  │ Compactor │  Query Expansion  │
├──────────┴──────────┴───────────┴───────────────────┤
│               Abstraction Layer                     │
│  ┌─────────┐ ┌────────────┐ ┌───────┐ ┌─────────┐   │
│  │ Storage │ │ Embeddings │ │ Index │ │  Model  │   │
│  └─────────┘ └────────────┘ └───────┘ └─────────┘   │
├─────────────────────────────────────────────────────┤
│              Default Implementations                │
│  LocalFS     Transformers.js  Vectra    CLI Agent   │
│  (SQLite)    (OpenAI, etc.)  (SQLite)  (OpenAI,..)  │
└─────────────────────────────────────────────────────┘
```

### Layers

| Layer | Responsibility |
|---|---|
| **CLI** | Command-line interface — thin shell over MemoryService |
| **MemoryService** | Top-level API. Orchestrates files, search, and compaction |
| **Files** | CRUD for daily, weekly, monthly, wisdom, and typed memory files |
| **Search** | Multi-pass semantic + keyword search with query expansion |
| **Compactor** | Summarizes daily→weekly→monthly→wisdom using the Model abstraction |
| **Abstraction Layer** | Pluggable interfaces for storage, embeddings, index, and model |

---

## 3. Abstraction Interfaces

### 3.1 Storage

Reuses Vectra's `FileStorage` interface. This is the lowest-level abstraction — all file I/O goes through it.

```typescript
// Re-exported from Vectra
export interface FileStorage {
  createFile(filePath: string, content: Buffer | string): Promise<void>;
  createFolder(folderPath: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  deleteFolder(folderPath: string): Promise<void>;
  getDetails(fileOrFolderPath: string): Promise<FileDetails>;
  listFiles(folderPath: string, filter?: ListFilesFilter): Promise<FileDetails[]>;
  pathExists(fileOrFolderPath: string): Promise<boolean>;
  readFile(filePath: string): Promise<Buffer>;
  upsertFile(filePath: string, content: Buffer | string): Promise<void>;
}
```

**Implementations:**

| Implementation | Package | Status |
|---|---|---|
| `LocalFileStorage` | `vectra` (re-exported) | Default — ships with core |
| `VirtualFileStorage` | `vectra` (re-exported) | For testing |
| `SqliteStorage` | `@stevenic/storage-sqlite` | Planned — separate package |

### 3.2 Embeddings

Reuses Vectra's `EmbeddingsModel` interface.

```typescript
// Re-exported from Vectra
export interface EmbeddingsModel {
  readonly maxTokens: number;
  createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse>;
}

export interface EmbeddingsResponse {
  status: EmbeddingsResponseStatus;
  output?: number[][];
  message?: string;
}
```

**Implementations:**

| Implementation | Package | Status |
|---|---|---|
| `LocalEmbeddings` | `recall` (core) | Default — transformers.js, Xenova/all-MiniLM-L6-v2 |
| `OpenAIEmbeddings` | `@stevenic/recall-openai` | Planned — separate package |
| `AnthropicEmbeddings` | `@stevenic/recall-anthropic` | Planned — separate package |
| `OSSEmbeddings` | `@stevenic/recall-oss` | Planned — any OpenAI-compatible endpoint |

### 3.3 Index

New abstraction. Wraps the vector database so Vectra can be swapped for another backend.

Each memory root has exactly one index stored at `<memory-root>/.index/`. To partition by agent or project, use separate memory roots (see §4.1).

```typescript
export interface MemoryIndex {
  /** Create or reset the index */
  createIndex(options?: CreateIndexOptions): Promise<void>;

  /** Check if the index exists and is initialized */
  isCreated(): Promise<boolean>;

  /** Add or update a document (handles chunking internally) */
  upsertDocument(uri: string, text: string, metadata?: DocumentMetadata): Promise<void>;

  /** Remove a document and all its chunks */
  deleteDocument(uri: string): Promise<void>;

  /** Check if a document exists by URI */
  hasDocument(uri: string): Promise<boolean>;

  /** Semantic search — returns ranked results */
  query(text: string, options?: QueryOptions): Promise<SearchResult[]>;

  /** Get index statistics */
  getStats(): Promise<IndexStats>;
}

export interface CreateIndexOptions {
  deleteIfExists?: boolean;
}

export interface DocumentMetadata {
  contentType?: string;    // "daily" | "weekly" | "monthly" | "wisdom" | "typed_memory"
  teammate?: string;
  period?: string;         // ISO date, week, or month
  [key: string]: MetadataTypes;
}

export interface QueryOptions {
  maxResults?: number;     // default: 10
  maxChunks?: number;      // default: 3
  maxTokens?: number;      // default: 500
  filter?: MetadataFilter;
}

export interface SearchResult {
  uri: string;
  text: string;
  score: number;
  metadata: DocumentMetadata;
  partial?: boolean;
}

export interface IndexStats {
  documentCount: number;
  chunkCount: number;
  lastUpdated?: Date;
}
```

**Implementations:**

| Implementation | Package | Status |
|---|---|---|
| `VectraIndex` | `recall` (core) | Default — wraps Vectra's LocalDocumentIndex |
| `SqliteIndex` | `@stevenic/recall-sqlite` | Planned — separate package |

### 3.4 Model

New abstraction for LLM-powered operations (compaction, wisdom distillation, query expansion).

```typescript
export interface MemoryModel {
  /**
   * Generate a completion from a prompt.
   * Used for compaction, summarization, and wisdom distillation.
   */
  complete(prompt: string, options?: CompleteOptions): Promise<CompletionResult>;
}

export interface CompleteOptions {
  /** System-level instructions */
  systemPrompt?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
}

export interface CompletionResult {
  /** The generated text */
  text: string;
  /** Input tokens consumed (if available from the provider) */
  inputTokens?: number;
  /** Output tokens generated (if available from the provider) */
  outputTokens?: number;
  /** Error info if the request failed or was rate-limited */
  error?: CompletionError;
}

export interface CompletionError {
  /** Error code — e.g., "rate_limited", "timeout", "model_error" */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether the caller should retry (e.g., true for rate limits) */
  retryable?: boolean;
  /** Suggested retry delay in ms (e.g., from Retry-After header) */
  retryAfterMs?: number;
}
```

**Implementations:**

| Implementation | Package | Status |
|---|---|---|
| `CliAgentModel` | `recall` (core) | Default — delegates to a CLI coding agent (see §3.4.1) |
| `OpenAIModel` | `@stevenic/recall-openai` | Planned — separate package |
| `AnthropicModel` | `@stevenic/recall-anthropic` | Planned — separate package |
| `OSSModel` | `@stevenic/recall-oss` | Planned — any OpenAI-compatible endpoint |

#### 3.4.1 CliAgentModel

The default model adapter spawns a CLI coding agent as a subprocess, sends the prompt, and captures its text output. This mirrors how teammates invokes Claude Code, Codex, Aider, etc.

**Configuration is required** — you must specify which agent to use. To keep it simple, pass a well-known agent name and the adapter resolves it to the correct command and flags:

```typescript
/** Shorthand agent identifiers — maps to the right CLI command + flags */
export type CliAgentName = "claude" | "codex" | "copilot";

export interface CliAgentModelConfig {
  /** Well-known agent name OR a custom command string */
  agent: CliAgentName | string;
  /** Additional arguments to pass before the prompt (optional) */
  args?: string[];
  /** Whether to pipe prompt via stdin (true) or temp file (false) */
  stdinPrompt?: boolean;
  /** Timeout in milliseconds (default: 120000) */
  timeout?: number;
}
```

Well-known agent resolution:

| Name | Command | Default flags |
|---|---|---|
| `"claude"` | `claude` | `--print`, stdin prompt |
| `"codex"` | `codex` | TBD — flags resolved at implementation time |
| `"copilot"` | `copilot` | TBD — flags resolved at implementation time |

Passing any other string uses it as a raw command (e.g., `"aider"`, `"/usr/local/bin/my-agent"`).

No API keys required for the model layer — just a working CLI agent installation.

---

## 4. Memory File Management

### 4.1 File Layout

Each agent or partition gets its own memory root. There is a single `.index/` folder per memory root — if you need multiple indexes or agents, define multiple memory roots.

```
<memory-root>/
├── WISDOM.md                      # Distilled principles (permanent)
├── memory/
│   ├── 2026-04-01.md              # Daily logs
│   ├── 2026-04-02.md
│   ├── type_topic.md              # Typed memories (user, feedback, project, reference)
│   ├── weekly/
│   │   ├── 2026-W13.md            # Weekly summaries
│   │   └── 2026-W14.md
│   └── monthly/
│       ├── 2026-03.md             # Monthly summaries
│       └── 2026-04.md
└── .index/                        # Single vector index for this memory root
```

**Multi-agent / multi-project example:** Instead of named indexes under one root, use separate memory roots:

```
project/
├── .teammates/scribe/             # scribe's memory root
│   ├── WISDOM.md
│   ├── memory/
│   └── .index/
├── .teammates/beacon/             # beacon's memory root
│   ├── WISDOM.md
│   ├── memory/
│   └── .index/
└── shared-memory/                 # shared memory root (optional)
    ├── WISDOM.md
    ├── memory/
    └── .index/
```

### 4.2 File Operations API

```typescript
export interface MemoryFiles {
  // Daily logs
  readDaily(date: string): Promise<string | null>;
  writeDaily(date: string, content: string): Promise<void>;
  appendDaily(date: string, entry: string): Promise<void>;
  listDailies(options?: ListOptions): Promise<string[]>;

  // Weekly summaries
  readWeekly(week: string): Promise<string | null>;
  writeWeekly(week: string, content: string): Promise<void>;
  listWeeklies(options?: ListOptions): Promise<string[]>;

  // Monthly summaries
  readMonthly(month: string): Promise<string | null>;
  writeMonthly(month: string, content: string): Promise<void>;
  listMonthlies(options?: ListOptions): Promise<string[]>;

  // Wisdom
  readWisdom(): Promise<string | null>;
  writeWisdom(content: string): Promise<void>;

  // Typed memories
  readTypedMemory(filename: string): Promise<string | null>;
  writeTypedMemory(filename: string, content: string): Promise<void>;
  deleteTypedMemory(filename: string): Promise<void>;
  listTypedMemories(): Promise<string[]>;

  // Bulk operations
  listAll(): Promise<MemoryFileManifest>;
}

export interface ListOptions {
  /** Return only files after this date/week/month (inclusive) */
  after?: string;
  /** Return only files before this date/week/month (inclusive) */
  before?: string;
}

export interface MemoryFileManifest {
  dailies: string[];
  weeklies: string[];
  monthlies: string[];
  typedMemories: string[];
  hasWisdom: boolean;
}
```

All file operations go through the `FileStorage` abstraction, so they work on local disk, in-memory (tests), or SQLite.

### 4.3 Frontmatter

Typed memory files use YAML frontmatter for catalog matching:

```yaml
---
name: Auth middleware rewrite
description: Driven by legal compliance, not tech debt
type: project
---

Auth middleware rewrite is driven by legal/compliance requirements...
```

Daily, weekly, and monthly files use minimal frontmatter:

```yaml
---
type: daily
---
```

---

## 5. Compaction

Compaction is the process of summarizing lower-granularity logs into higher-granularity summaries. It is the only operation that requires an LLM (the `MemoryModel` abstraction).

### 5.1 Compaction Pipeline

```
Daily logs  ──(7+ days)──►  Weekly summary
Weekly summaries  ──(4+ weeks)──►  Monthly summary
Monthly summaries + Typed memories  ──(on demand)──►  Wisdom distillation
```

### 5.2 Default Compaction Strategy

**Trigger:** Compaction runs when sufficient source material has accumulated. This can be invoked explicitly (`recall compact`) or automatically when a configurable threshold is reached (e.g., daily log token count exceeds budget).

#### Daily → Weekly

- **When:** A calendar week has ended and has 3+ daily logs (partial weeks are still compacted if the week is past)
- **Input:** All daily logs for the ISO week
- **Prompt strategy:** Instruct the model to produce a structured weekly summary that:
  - Captures key decisions, outcomes, and blockers
  - Drops routine/repetitive entries
  - Preserves any typed memory candidates (decisions, gotchas, feedback) as extractable sections
  - Targets ~30% of the combined input token count
- **Output:** `memory/weekly/YYYY-Wnn.md`
- **Retention:** Daily logs older than 30 days are deleted after successful compaction

#### Weekly → Monthly

- **When:** A calendar month has ended and has 2+ weekly summaries
- **Input:** All weekly summaries for the month
- **Prompt strategy:** Summarize themes, milestones, and trajectory. Even more aggressive compression — focus on what matters at the month scale.
  - Targets ~30% of the combined input token count
- **Output:** `memory/monthly/YYYY-MM.md`
- **Retention:** Weekly summaries older than 52 weeks are deleted after successful compaction

#### Wisdom Distillation

- **When:** Explicitly triggered, or during monthly compaction
- **Input:** Current WISDOM.md + all typed memories + latest monthly summary
- **Prompt strategy:**
  - Merge new insights into existing wisdom
  - Remove entries that are no longer relevant or are contradicted by newer information
  - Cap at ~20 high-value entries (decisions, invariants, gotchas, validated patterns)
  - Drop implementation recipes (derivable from code)
- **Output:** Updated `WISDOM.md`
- **Retention:** Typed memories that have been fully absorbed into wisdom *may* be flagged, but are not auto-deleted (they remain searchable)

### 5.3 Typed Memory Extraction

During daily→weekly compaction, the model is also asked to identify any entries that qualify as typed memories (decisions, feedback, project context, references). These are extracted and written as separate `memory/type_topic.md` files with proper frontmatter.

### 5.4 Compaction Configuration

All thresholds are configurable with smart defaults. Pass only the fields you want to override.

```typescript
export interface CompactionConfig {
  /** Model to use for summarization */
  model: MemoryModel;

  /** Days before daily logs are eligible for deletion (default: 30) */
  dailyRetentionDays?: number;

  /** Weeks before weekly summaries are eligible for deletion (default: 52) */
  weeklyRetentionWeeks?: number;

  /** Minimum daily logs in a week to trigger weekly compaction (default: 3) */
  minDailiesForWeekly?: number;

  /** Minimum weekly summaries in a month to trigger monthly compaction (default: 2) */
  minWeekliesForMonthly?: number;

  /** Token budget above which auto-compaction triggers (default: 12000) */
  autoCompactThreshold?: number;

  /** Target compression ratio for daily→weekly and weekly→monthly (default: 0.3) */
  compressionTarget?: number;

  /** Whether to extract typed memories during compaction (default: true) */
  extractTypedMemories?: boolean;

  /** Wisdom distillation settings */
  wisdom?: WisdomConfig;
}

export interface WisdomConfig {
  /** Maximum wisdom entries (default: 20) */
  maxEntries?: number;

  /** Whether to run wisdom distillation during monthly compaction (default: true) */
  autoDistill?: boolean;

  /** Minimum monthly summaries before first wisdom distillation (default: 1) */
  minMonthliesForDistill?: number;

  /** Categories/sections to organize wisdom into (default: none — flat list) */
  categories?: string[];

  /** Custom system prompt for the wisdom distillation LLM call (overrides default) */
  systemPrompt?: string;
}
```

---

## 6. Search

### 6.1 Two-Pass Architecture (inherited from teammates recall)

**Pass 1 — Catalog matching (no embeddings):**
Scan typed memory frontmatter and match against the query using keyword overlap. Cheap, fast, and catches exact-name hits that semantic search might rank lower.

**Pass 2 — Semantic search:**
Query the vector index with the embedded query. Merge with catalog matches, deduplicate by URI, keep highest score.

**Recency pass (optional):**
Also inject the N most recent weekly summaries (by date, not by relevance) to ensure recent context is always surfaced.

### 6.2 Multi-Query Fusion

Generate 1–3 query variations from the input (keyword extraction, conversation-derived rephrasing). Run each through the index, merge results, deduplicate.

### 6.3 Search API

```typescript
export interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  multiSearch(query: string, options?: MultiSearchOptions): Promise<SearchResult[]>;
}

export interface SearchOptions {
  maxResults?: number;         // default: 5
  maxChunks?: number;          // default: 3
  maxTokens?: number;          // default: 500
  skipSync?: boolean;          // default: false
  recencyDepth?: number;       // default: 2 (recent weekly summaries)
  typedMemoryBoost?: number;   // default: 1.2
}

export interface MultiSearchOptions extends SearchOptions {
  additionalQueries?: string[];
  catalogMatches?: SearchResult[];
}
```

---

## 7. MemoryService (Top-Level API)

The `MemoryService` is the main entry point. It composes files, search, and compaction behind a single interface.

```typescript
export interface MemoryServiceConfig {
  /** Root directory for memory files */
  memoryRoot: string;

  /** Storage backend (default: LocalFileStorage) */
  storage?: FileStorage;

  /** Embeddings model (default: LocalEmbeddings with transformers.js) */
  embeddings?: EmbeddingsModel;

  /** Vector index (default: VectraIndex at <memoryRoot>/.index/) */
  index?: MemoryIndex;

  /** LLM for compaction (required — no default, must configure explicitly) */
  model?: MemoryModel;

  /** Compaction settings */
  compaction?: Partial<CompactionConfig>;

  /** Watch mode settings */
  watch?: WatchConfig;
}

export interface WatchConfig {
  /** Whether to sync the index on file changes (default: true) */
  syncOnChange?: boolean;
  /** Whether to trigger compaction when thresholds are exceeded (default: false) */
  compactOnThreshold?: boolean;
  /** Debounce interval in ms before reacting to changes (default: 2000) */
  debounceMs?: number;
}

export class MemoryService {
  constructor(config: MemoryServiceConfig);

  // --- File operations ---
  readonly files: MemoryFiles;

  // --- Search ---
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  multiSearch(query: string, options?: MultiSearchOptions): Promise<SearchResult[]>;

  // --- Index management ---
  index(): Promise<IndexStats>;       // Full rebuild
  sync(): Promise<IndexStats>;        // Incremental sync
  status(): Promise<MemoryStatus>;

  // --- Compaction ---
  compact(options?: CompactOptions): Promise<CompactionResult>;
  compactDaily(week?: string): Promise<CompactionResult>;
  compactWeekly(month?: string): Promise<CompactionResult>;
  distillWisdom(): Promise<CompactionResult>;

  // --- Lifecycle ---
  initialize(): Promise<void>;        // Create directories, index if needed
  close(): Promise<void>;             // Cleanup resources
}

export interface CompactOptions {
  /** Only compact up to this level (default: "wisdom") */
  level?: "weekly" | "monthly" | "wisdom";
  /** Dry run — report what would be compacted without doing it */
  dryRun?: boolean;
}

export interface CompactionResult {
  filesCompacted: string[];
  filesCreated: string[];
  filesDeleted: string[];
  typedMemoriesExtracted: string[];
}

export interface MemoryStatus {
  memoryRoot: string;
  indexCreated: boolean;
  indexStats?: IndexStats;
  fileManifest: MemoryFileManifest;
}
```

---

## 8. CLI

### 8.1 Command: `recall`

```
recall <command> [options]

Commands:
  recall search <query>      Search memories
  recall index               Full rebuild of the vector index
  recall sync                Incremental index sync
  recall status              Show memory file counts and index health
  recall compact [level]     Run compaction (weekly | monthly | wisdom | all)
  recall add <file>          Add/update a single file in the index
  recall log <entry>         Append an entry to today's daily log
  recall read <file>         Read a memory file (daily, weekly, monthly, wisdom, typed)
  recall list [type]         List memory files (daily | weekly | monthly | typed | all)
  recall watch               Watch for changes and auto-sync/compact

Global Options:
  --dir <path>               Memory root directory (default: ./memory)
  --json                     JSON output
  --verbose                  Verbose logging
```

### 8.2 Command Details

#### `recall search <query>`

```
recall search "database migration" --results 5 --no-sync --json
```

Options:
- `--results <n>` — Max results (default: 5)
- `--max-chunks <n>` — Max chunks per document (default: 3)
- `--max-tokens <n>` — Max tokens per result (default: 500)
- `--recency-depth <n>` — Recent weekly summaries to include (default: 2)
- `--typed-memory-boost <n>` — Boost multiplier for typed memories (default: 1.2)
- `--model <name>` — Embedding model (default: Xenova/all-MiniLM-L6-v2)
- `--no-sync` — Skip auto-sync before searching

#### `recall compact [level]`

```
recall compact                  # Compact everything eligible
recall compact weekly           # Only daily → weekly
recall compact monthly          # Only weekly → monthly  
recall compact wisdom           # Only distill wisdom
recall compact --dry-run        # Show what would be compacted
```

Options:
- `--dry-run` — Report only, don't execute
- `--agent <name>` — CLI agent for summarization (`"claude"` | `"codex"` | `"copilot"` | custom command)
- `--compression <ratio>` — Override compression target (default: 0.3)
- `--max-wisdom <n>` — Override max wisdom entries (default: 20)

#### `recall watch`

```
recall watch                         # Sync only (default)
recall watch --compact               # Also trigger compaction on threshold
recall watch --debounce 5000         # Custom debounce interval (ms)
```

Options:
- `--compact` — Enable auto-compaction when thresholds are exceeded
- `--debounce <ms>` — Debounce interval before reacting to changes (default: 2000)

#### `recall log <entry>`

```
recall log "Decided to use SQLite for the index backend"
recall log --file notes.md      # Append from a file
```

Appends to today's daily log (`memory/YYYY-MM-DD.md`), creating it if needed.

#### `recall list [type]`

```
recall list                     # All files
recall list daily               # Just dailies
recall list typed               # Just typed memories
recall list --after 2026-03-01  # Filter by date
```

---

## 9. Language Bindings

The `bindings/` folder contains thin wrappers for popular programming languages. Each binding spawns the `recall` CLI as a subprocess, passes arguments, and parses `--json` output. This keeps the core logic in one place (the TypeScript CLI) while making recall accessible from any language.

### Design Principles

1. **CLI is the contract** — Bindings call the CLI binary; they don't reimplement logic. If the CLI changes, bindings update their argument passing, not their algorithms.
2. **JSON in, JSON out** — All bindings use `--json` mode for structured responses. No output parsing heuristics.
3. **Minimal dependencies** — Each binding should only depend on the language's standard library for process spawning and JSON parsing.
4. **Error propagation** — Non-zero exit codes and stderr are surfaced as language-appropriate exceptions/errors with the original message.

### Binding Surface

Each binding exposes the same operations as the CLI:

| Method | CLI Equivalent |
|---|---|
| `search(query, options?)` | `recall search <query> --json` |
| `index()` | `recall index --json` |
| `sync()` | `recall sync --json` |
| `status()` | `recall status --json` |
| `compact(level?, options?)` | `recall compact [level] --json` |
| `log(entry)` | `recall log <entry> --json` |
| `list(type?)` | `recall list [type] --json` |
| `read(file)` | `recall read <file> --json` |
| `add(file)` | `recall add <file> --json` |

### Initial Languages

| Language | Package Name | Priority |
|---|---|---|
| Python | `recall-memory` | v0.2 — most common agent/ML ecosystem |
| Go | `recall` | v0.2 — common for CLI-heavy toolchains |
| Rust | `recall` | v0.3 |
| C# | `Recall` | v0.3 |

---

## 10. Package Structure

```
recall/
├── packages/
│   ├── core/                          # Main package: recall
│   │   ├── src/
│   │   │   ├── index.ts               # Public API exports
│   │   │   ├── service.ts             # MemoryService implementation
│   │   │   ├── files.ts               # MemoryFiles implementation
│   │   │   ├── search.ts              # Search + multi-search
│   │   │   ├── compactor.ts           # Compaction pipeline
│   │   │   ├── chunker.ts             # Markdown chunking
│   │   │   ├── query-expansion.ts     # Query variation generation
│   │   │   ├── memory-index.ts        # Frontmatter catalog matching
│   │   │   ├── interfaces/
│   │   │   │   ├── storage.ts         # FileStorage (re-export from Vectra)
│   │   │   │   ├── embeddings.ts      # EmbeddingsModel (re-export from Vectra)
│   │   │   │   ├── index.ts           # MemoryIndex interface
│   │   │   │   └── model.ts           # MemoryModel interface
│   │   │   ├── defaults/
│   │   │   │   ├── vectra-index.ts    # VectraIndex implementation
│   │   │   │   ├── local-embeddings.ts # transformers.js embeddings
│   │   │   │   └── cli-agent-model.ts # CLI agent model adapter
│   │   │   └── cli.ts                 # CLI entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── (future separate packages)
│       ├── storage-sqlite/            # @stevenic/storage-sqlite
│       ├── index-sqlite/              # @stevenic/index-sqlite
│       ├── embeddings-openai/         # @stevenic/embeddings-openai
│       ├── embeddings-anthropic/      # @stevenic/embeddings-anthropic
│       ├── model-openai/              # @stevenic/model-openai
│       ├── model-anthropic/           # @stevenic/model-anthropic
│       └── model-oss/                 # @stevenic/model-oss
├── bindings/                          # Language bindings (thin wrappers over CLI)
│   ├── python/                        # Python binding
│   │   ├── recall/
│   │   │   ├── __init__.py
│   │   │   └── client.py             # Spawns `recall` CLI subprocess
│   │   ├── pyproject.toml
│   │   └── README.md
│   ├── go/                            # Go binding
│   │   ├── recall.go                  # Spawns `recall` CLI subprocess
│   │   ├── go.mod
│   │   └── README.md
│   ├── rust/                          # Rust binding
│   │   ├── src/
│   │   │   └── lib.rs                 # Spawns `recall` CLI subprocess
│   │   ├── Cargo.toml
│   │   └── README.md
│   └── csharp/                        # C# binding
│       ├── Recall/
│       │   └── RecallClient.cs        # Spawns `recall` CLI subprocess
│       ├── Recall.csproj
│       └── README.md
├── package.json                       # Workspace root
└── tsconfig.json
```

---

## 11. Dependencies (core package)

| Dependency | Purpose |
|---|---|
| `vectra` | Vector index + storage abstractions |
| `@huggingface/transformers` | Local embeddings (transformers.js) |
| `commander` | CLI framework |
| `gray-matter` | YAML frontmatter parsing |
| `gpt-tokenizer` | Token counting for budget management |

---

## 12. Acceptance Criteria

### MVP (v0.1)

**Core service:**
- [ ] `MemoryService` with `LocalFileStorage`, `LocalEmbeddings`, `VectraIndex`
- [ ] Service lifecycle — `initialize()` creates directories and index; `close()` releases resources
- [ ] All abstractions (Storage, Embeddings, Index, Model) are pluggable via `MemoryServiceConfig`

**File management:**
- [ ] File CRUD for all memory types (daily, weekly, monthly, wisdom, typed)
- [ ] YAML frontmatter parsing for typed memories (§4.3)
- [ ] `MemoryFileManifest` via `listAll()`

**Search:**
- [ ] Semantic search with catalog matching (frontmatter keyword overlap) and recency pass
- [ ] Multi-query fusion search with query expansion (§6.2)
- [ ] Auto-sync before search (with `--no-sync` opt-out)
- [ ] Markdown chunking for index ingestion

**Compaction:**
- [ ] Daily→weekly compaction with typed memory extraction (§5.3)
- [ ] Weekly→monthly compaction
- [ ] Wisdom distillation
- [ ] `CliAgentModel` with well-known agent name resolution (`"claude"` | `"codex"` | `"copilot"`)
- [ ] `CompletionResult` error handling — rate limit detection, retryable flag, token usage reporting
- [ ] All compaction thresholds configurable via `CompactionConfig` / `WisdomConfig`
- [ ] `compact --dry-run` support

**CLI:**
- [ ] Commands: `search`, `index`, `sync`, `status`, `log`, `list`, `read`, `add`, `watch`, `compact`
- [ ] `--json` output on all commands
- [ ] `watch` mode with configurable debounce, sync-only (default) and opt-in compaction

### v0.2

- [ ] SQLite storage backend
- [ ] SQLite index backend
- [ ] OpenAI embeddings package
- [ ] OpenAI / Anthropic model packages
- [ ] Python language binding
- [ ] Go language binding

### v0.3

- [ ] OSS embeddings (any OpenAI-compatible endpoint)
- [ ] OSS model adapter
- [ ] Anthropic embeddings package
- [ ] Rust language binding
- [ ] C# language binding

---

## 13. Resolved Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Compaction thresholds configurable? | **Yes — all configurable with smart defaults** | Compression target (30%), wisdom cap (20), retention periods, min-log thresholds are all overridable via `CompactionConfig` |
| 2 | CliAgentModel auto-detect vs explicit? | **Explicit config, but simple** — pass `"claude"` \| `"codex"` \| `"copilot"` and the adapter resolves the command + flags | Avoids magic detection; keeps config to one string |
| 3 | Index isolation model? | **One index per memory root** — partition by using separate memory roots, not named indexes | Simpler file layout; multiple roots is the natural boundary for agents/projects |
| 4 | Watch mode scope? | **Configurable — supports both** sync and compaction, controlled via `WatchConfig.compactOnThreshold` (default: off) | Users who want auto-compaction opt in; everyone else gets safe index sync |
| 5 | Monorepo vs single package? | **Monorepo from day one** | Plugin model is cleaner when the package boundary exists from the start |
| 6 | Wisdom distillation configurable? | **Yes** — `WisdomConfig` controls max entries, auto-distill trigger, categories, and custom system prompts | Different agents/projects have different wisdom shapes |
| 7 | `MemoryModel.complete()` return type? | **Rich result** — returns `CompletionResult` with text, token counts, and error info | Callers need to detect rate limits, track costs, and handle failures gracefully |
| 8 | Multiple indexes per memory root? | **No — one `.index/` per root.** Multiple agents = multiple memory roots | Simpler layout; eliminates `MemoryIndexProvider` factory pattern |
| 9 | Language bindings? | **Yes — `bindings/` folder** with thin CLI wrappers for Python, Go, Rust, C# | Extends recall to non-JS ecosystems without duplicating logic |

## 14. Open Questions

(None — all initial questions resolved.)
