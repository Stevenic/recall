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

## Hierarchical Memory (v0.1.1)

Derived from `specs/hierarchical-memory.md` (v0.4, 2026-04-08).

### Phase A — Eidetic Storage

- [x] Remove daily/weekly retention and deletion from `Compactor`
- [x] Add `pointers` frontmatter generation to weekly and monthly compaction
- [x] Update `MemoryFiles` to parse `pointers` from frontmatter

### Phase B — Dual Embeddings + Salience

- [x] Add `getEmbedding()` and `upsertEmbedding()` to `MemoryIndex` interface
- [x] Implement in `VectraIndex`
- [x] Implement salience signal extraction (`packages/core/src/salience.ts`)
- [x] Integrate salience extraction into compaction pipeline
- [x] Compute and store dual embeddings (#agg + #summary) during compaction

### Phase C — Two-Phase Recall

- [x] Implement pointer expansion (recursive, with dedup)
- [x] Implement Phase 1a parallel retrieval (parent vector + raw vector)
- [x] Implement Phase 2 reranking with configurable weights
- [x] Extend `SearchResult` with `resultType`, `parentUri`, `scoreBreakdown`

### Phase D — BM25 Integration

- [x] Wire BM25 scoring weight into Phase 2 reranking formula
- [ ] Validate BM25 with Vectra's built-in `setupBm25`/`bm25Search` in integration tests

### Phase E — Migration

- [x] Implement `recall migrate --to hierarchical` CLI command
- [x] Pointer backfill logic for existing parent nodes
- [x] `--dry-run` support

### Supporting Modules

- [x] Temporal reference extraction (`packages/core/src/temporal.ts`)
- [x] Hierarchical memory config type (`packages/core/src/hierarchical-config.ts`)
- [x] Tests: 38 new tests (82 total, all passing)

---

## Dreaming System (v0.1.2)

Derived from `specs/dreaming.md` (v0.1, 2026-04-11).

### Phase A — Search Signal Infrastructure

- [x] Search log writing in `SearchService` (opt-in via `SearchLogger`)
- [x] Search log JSONL format with query, results, scores, timestamp
- [x] Monthly log rotation (`SearchLogger.rotateLog()`)
- [x] `.dreams/` directory management (search-log.jsonl, candidates.json, dream-state.json)
- [x] `DreamingConfig` added to `MemoryServiceConfig`

### Phase B — Signal Collection + Candidate Scoring

- [x] Hit frequency signal (URI recall count + query diversity)
- [x] Gap signal (null/low-score queries)
- [x] Entity frequency signal (recurring entities without typed memories)
- [x] Staleness signal (old project/reference typed memories)
- [x] Wisdom drift signal (wisdom entries with no search activity)
- [x] Candidate scoring with configurable weights
- [x] Carry-over candidate persistence (`candidates.json`)

### Phase C — Synthesis Pipeline

- [x] Five analysis templates: cross-reference, gap, contradiction, typed-memory, theme
- [x] `DreamEngine.analyze()` — per-candidate LLM analysis
- [x] JSON + freeform output parsing
- [x] Token usage tracking

### Phase D — Output + Integration

- [x] Insight files → `memory/dreams/insights/YYYY-MM-DD-<slug>.md`
- [x] Promoted typed memories → `memory/<type>_<topic>.md` (deduplicated)
- [x] Contradiction files → `memory/dreams/contradictions/YYYY-MM-DD.md`
- [x] Dream diary → `DREAMS.md` (append-only)
- [x] Insight and contradiction files indexed by Vectra (searchable)
- [x] Dreaming never modifies or deletes existing memory files

### CLI

- [x] `recall dream` — full dreaming session
- [x] `recall dream --dry-run` — show candidates without LLM calls
- [x] `recall dream --phase <phase>` — run specific phase
- [x] `recall dream --max-candidates <n>`
- [x] `recall dream status` — last run, pending candidates, signal stats
- [x] `recall watch --dream` — dreaming on interval
- [x] `--json` output on all dream commands

### Testing

- [x] Tests: 29 new tests (111 total, all passing)
- [x] SearchLogger: log writing, reading, window filtering, candidate/state persistence
- [x] Signal Collector: hit frequency, gap, entity, staleness, wisdom drift, entity extraction
- [x] DreamEngine: dry-run, gather, full session, insight writing, diary, state, dedup, graceful non-JSON, contradictions

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
