# Beacon — Goals

## MVP (v0.1) — Recall Agent Memory Service

Derived from `specs/memory-service.md` (v0.3, 2026-04-02).

### Abstraction Interfaces

- [x] Define `MemoryIndex` interface (`packages/core/src/interfaces/index.ts`)
- [x] Define `MemoryModel` interface (`packages/core/src/interfaces/model.ts`)
- [x] Define `FileStorage` interface (`packages/core/src/interfaces/storage.ts`) — custom, not re-exported from Vectra
- [x] Re-export `EmbeddingsModel` from Vectra (`packages/core/src/interfaces/embeddings.ts`)

### Default Implementations

- [x] `VectraIndex` — wraps Vectra's `LocalDocumentIndex` (`packages/core/src/defaults/vectra-index.ts`)
- [x] `LocalEmbeddings` — transformers.js with `Xenova/all-MiniLM-L6-v2` (`packages/core/src/defaults/local-embeddings.ts`)
- [x] `CliAgentModel` — spawns CLI coding agent subprocess (`packages/core/src/defaults/cli-agent-model.ts`)
- [x] `LocalFileStorage` — local disk via fs/promises (`packages/core/src/defaults/local-file-storage.ts`)
- [x] `VirtualFileStorage` — in-memory for testing (`packages/core/src/defaults/virtual-file-storage.ts`)

### Core Services

- [x] `MemoryFiles` — CRUD for daily, weekly, monthly, wisdom, and typed memory files (`packages/core/src/files.ts`)
- [x] `SearchService` — two-pass search (catalog + semantic) with multi-query fusion (`packages/core/src/search.ts`)
- [x] `Compactor` — daily->weekly->monthly->wisdom pipeline (`packages/core/src/compactor.ts`)
- [x] `MemoryService` — top-level API composing files, search, compaction (`packages/core/src/service.ts`)
- [x] Markdown chunker for index ingestion (`packages/core/src/chunker.ts`)
- [x] Query expansion for multi-query search (`packages/core/src/query-expansion.ts`)
- [x] Frontmatter catalog matching (`packages/core/src/catalog.ts`)

### CLI

- [x] CLI entry point with Commander (`packages/core/src/cli.ts`)
- [x] `recall search <query>` — semantic + catalog search
- [x] `recall index` — full rebuild of vector index
- [x] `recall sync` — incremental index sync
- [x] `recall status` — memory file counts and index health
- [x] `recall compact [level]` — run compaction pipeline
- [x] `recall add <file>` — add/update single file in index
- [x] `recall log <entry>` — append to today's daily log
- [x] `recall read <file>` — read a memory file
- [x] `recall list [type]` — list memory files
- [x] `recall watch` — watch for changes, auto-sync/compact
- [x] `--json` output on all commands

### Project Setup

- [x] Monorepo workspace root (`package.json`, `tsconfig.json`)
- [x] Core package scaffold (`packages/core/package.json`, `packages/core/tsconfig.json`)
- [x] Public API barrel export (`packages/core/src/index.ts`)

### Testing

- [x] Tests for `MemoryFiles` CRUD operations (17 tests)
- [x] Tests for `SearchService` (catalog matching, semantic search, dedup) (5 tests)
- [x] Tests for `Compactor` (daily->weekly, weekly->monthly, wisdom distillation) (7 tests)
- [x] Tests for `catalog` (parsing, scoring, matching) (10 tests)
- [x] Tests for `chunker` (splitting, line tracking, edge cases) (5 tests)

---

## v0.2 (Future)

- [ ] SQLite storage backend (`@stevenic/storage-sqlite`)
- [ ] SQLite index backend (`@stevenic/recall-sqlite`)
- [ ] OpenAI embeddings package (`@stevenic/recall-openai`)
- [ ] OpenAI / Anthropic model packages
- [ ] Python language binding (`bindings/python/`)
- [ ] Go language binding (`bindings/go/`)

## v0.3 (Future)

- [ ] OSS embeddings (OpenAI-compatible endpoint)
- [ ] OSS model adapter
- [ ] Anthropic embeddings package
- [ ] Rust language binding (`bindings/rust/`)
- [ ] C# language binding (`bindings/csharp/`)
