# Recall MVP — Implementation Plan

**Status:** Ready for handoff  
**Author:** Scribe  
**Date:** 2026-04-02  
**Spec:** [memory-service.md](./memory-service.md) (v0.3)

---

## Overview

This plan breaks the MVP (§12 of the design spec) into sequenced work packages. Each package is independently testable and builds on the previous one. @beacon owns all implementation work.

---

## Phase 1: Project Scaffolding & Interfaces

**Goal:** Monorepo structure, TypeScript config, all interfaces defined, and a "hello world" CLI.

### Tasks

1. **Workspace root** — `package.json` (workspaces), root `tsconfig.json`, `.gitignore`, `eslint` config
2. **`packages/core` scaffold** — `package.json`, `tsconfig.json`, `src/index.ts`
3. **Interface files** — Create all four interface files under `src/interfaces/`:
   - `storage.ts` — Re-export `FileStorage` from Vectra
   - `embeddings.ts` — Re-export `EmbeddingsModel` from Vectra
   - `index.ts` — `MemoryIndex`, `CreateIndexOptions`, `DocumentMetadata`, `QueryOptions`, `SearchResult`, `IndexStats`
   - `model.ts` — `MemoryModel`, `CompleteOptions`, `CompletionResult`, `CompletionError`
4. **CLI skeleton** — `src/cli.ts` using `commander`, wired to a stub `recall --version` command
5. **Dependencies** — Install `vectra`, `commander`, `gray-matter`, `gpt-tokenizer`, `@huggingface/transformers`
6. **Dev dependencies** — `vitest` (or project test runner of choice), `typescript`, `tsx`
7. **Verify** — `npm run build` succeeds, `npx recall --version` prints version

### Acceptance

- All interfaces from spec §3 are exported from `packages/core/src/index.ts`
- CLI binary entry point works
- Build + lint pass

---

## Phase 2: File Management Layer

**Goal:** Full CRUD for all memory file types, with frontmatter support.

### Tasks

1. **`src/files.ts`** — Implement `MemoryFiles` interface (spec §4.2):
   - Daily: `readDaily`, `writeDaily`, `appendDaily`, `listDailies`
   - Weekly: `readWeekly`, `writeWeekly`, `listWeeklies`
   - Monthly: `readMonthly`, `writeMonthly`, `listMonthlies`
   - Wisdom: `readWisdom`, `writeWisdom`
   - Typed: `readTypedMemory`, `writeTypedMemory`, `deleteTypedMemory`, `listTypedMemories`
   - Bulk: `listAll` → `MemoryFileManifest`
2. **Frontmatter handling** — Use `gray-matter` for typed memory YAML parsing (spec §4.3)
3. **File layout** — Enforce directory structure from spec §4.1 (`memory/`, `memory/weekly/`, `memory/monthly/`)
4. **Tests** — Use Vectra's `VirtualFileStorage` for in-memory testing. Cover:
   - CRUD round-trip for each file type
   - `listDailies` with `after`/`before` filtering
   - `appendDaily` creates file if missing, appends if exists
   - `listAll` returns correct manifest
   - Frontmatter parsing for typed memories

### Acceptance

- All `MemoryFiles` methods implemented and tested
- Works against both `LocalFileStorage` and `VirtualFileStorage`

---

## Phase 3: Index & Search

**Goal:** Semantic search with catalog matching, recency pass, and multi-query fusion.

### Tasks

1. **`src/defaults/vectra-index.ts`** — Implement `VectraIndex` wrapping Vectra's `LocalDocumentIndex`:
   - `createIndex`, `isCreated`, `upsertDocument`, `deleteDocument`, `hasDocument`, `query`, `getStats`
   - Map `DocumentMetadata` to Vectra metadata format
2. **`src/defaults/local-embeddings.ts`** — Implement `LocalEmbeddings` using `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2`
3. **`src/chunker.ts`** — Markdown-aware chunking:
   - Split on headings, then by token budget (use `gpt-tokenizer`)
   - Preserve frontmatter in first chunk
   - Return chunks with byte offsets for partial-result reporting
4. **`src/memory-index.ts`** — Catalog matching:
   - Scan typed memory frontmatter (`name`, `description`, `type`)
   - Score by keyword overlap with query
   - Return as `SearchResult[]` for merge with semantic results
5. **`src/query-expansion.ts`** — Generate 1–3 query variations (keyword extraction, rephrasing). Note: this can be simple string manipulation for MVP; LLM-powered expansion is a future enhancement.
6. **`src/search.ts`** — Implement `SearchService`:
   - `search()` — catalog match → semantic search → merge/dedup → recency inject
   - `multiSearch()` — expand query → run each variation → merge/dedup
7. **Sync logic** — `sync()` walks all memory files, diffs against index, upserts/deletes as needed
8. **Tests** — Cover:
   - VectraIndex CRUD and query (use VirtualFileStorage)
   - Chunker: heading splits, token budget, frontmatter preservation
   - Catalog matching: keyword overlap scoring
   - Search: merged results from catalog + semantic, dedup by URI
   - Sync: detects new/modified/deleted files

### Acceptance

- `recall search "query"` returns ranked results from indexed memory files
- Catalog matches boost exact-name hits
- Recency pass includes recent weekly summaries
- `recall sync` and `recall index` work correctly

---

## Phase 4: Compaction Pipeline

**Goal:** LLM-powered summarization: daily→weekly→monthly→wisdom, with typed memory extraction.

### Tasks

1. **`src/defaults/cli-agent-model.ts`** — Implement `CliAgentModel`:
   - Resolve well-known names (`"claude"` → `claude --print`, etc.)
   - Spawn subprocess, pipe prompt via stdin or temp file
   - Capture stdout as `CompletionResult.text`
   - Parse token usage from stderr/output if available
   - Handle errors → `CompletionError` with `retryable`, `retryAfterMs`
   - Timeout support
2. **`src/compactor.ts`** — Implement compaction pipeline:
   - `compactDaily(week?)` — gather dailies for the week, prompt model, write weekly summary, extract typed memories
   - `compactWeekly(month?)` — gather weeklies for the month, prompt model, write monthly summary
   - `distillWisdom()` — gather wisdom + typed memories + latest monthly, prompt model, write updated WISDOM.md
   - `compact(options?)` — orchestrate all eligible levels
   - `dryRun` support — report what would be compacted without executing
   - Token counting via `gpt-tokenizer` to enforce compression targets
3. **Prompt templates** — Use templates from `specs/compaction-prompts.md` (provided by @lexicon). Wire as default system prompts in `CompactionConfig`.
4. **Tests** — Cover:
   - CliAgentModel: well-known name resolution, subprocess spawn (mock), error handling
   - Compactor: eligibility checks (min dailies, min weeklies, date math)
   - Typed memory extraction: model output → frontmatter files
   - Dry run: returns plan without side effects

### Acceptance

- `recall compact` runs full pipeline on eligible files
- `recall compact --dry-run` reports plan without modifying files
- `CliAgentModel` works with `"claude"` agent name
- Typed memories extracted during daily→weekly compaction

---

## Phase 5: MemoryService & CLI

**Goal:** Wire everything together into the top-level `MemoryService` API and complete CLI.

### Tasks

1. **`src/service.ts`** — Implement `MemoryService` class:
   - Constructor takes `MemoryServiceConfig`, wires defaults
   - `initialize()` — create directory structure, create index if needed
   - `close()` — release resources (index handles, watchers)
   - Expose `files`, `search`, `multiSearch`, `index`, `sync`, `status`, `compact*`, `distillWisdom`
2. **`src/cli.ts`** — Complete CLI commands:
   - `recall search <query>` with all options from spec §8.2
   - `recall index` / `recall sync` / `recall status`
   - `recall compact [level]` with `--dry-run`, `--agent`, `--compression`, `--max-wisdom`
   - `recall log <entry>` / `recall read <file>` / `recall list [type]` / `recall add <file>`
   - `recall watch` with `--compact` and `--debounce`
   - Global options: `--dir`, `--json`, `--verbose`
3. **`--json` output** — Structured JSON on all commands when `--json` is passed
4. **`recall watch`** — Filesystem watcher:
   - Watch `memory/` directory for changes
   - Debounce (default 2000ms, configurable)
   - On change: auto-sync index
   - If `--compact`: also trigger compaction when thresholds exceeded
5. **Integration tests** — End-to-end flows:
   - Initialize → log → sync → search → verify result
   - Initialize → write dailies → compact → verify weekly created
   - Watch mode: write file → verify index updated within debounce window
6. **Export public API** — `src/index.ts` exports all interfaces, types, `MemoryService`, and default implementations

### Acceptance

- All CLI commands from spec §8.1 work with both human-readable and `--json` output
- `MemoryService` can be instantiated programmatically with custom config
- Watch mode syncs on file changes with correct debounce
- Integration tests pass for core workflows

---

## Dependency Graph

```
Phase 1 (Scaffold)
    │
    ▼
Phase 2 (Files)
    │
    ├──────────────┐
    ▼              ▼
Phase 3 (Search)  Phase 4 (Compaction)
    │              │
    └──────┬───────┘
           ▼
    Phase 5 (Service + CLI)
```

**Phases 3 and 4 can run in parallel** once Phase 2 is complete. Both depend on the file layer but not on each other.

---

## Notes for @beacon

- **Test runner:** Use `vitest` — it works well with TypeScript monorepos and has fast watch mode.
- **Vectra dependency:** Import `FileStorage`, `EmbeddingsModel`, `LocalFileStorage`, `VirtualFileStorage`, `LocalDocumentIndex` from `vectra`. These are the integration points.
- **Compaction prompts:** Will be provided by @lexicon in `specs/compaction-prompts.md`. Use placeholder prompts during Phase 4 development and swap in final prompts when available.
- **CliAgentModel:** For testing, mock the subprocess. For manual testing, `"claude"` with `claude --print` is the primary target.
- **Watch mode:** Use `chokidar` or Node's `fs.watch` — pick whichever is more reliable cross-platform. Add it as a dependency if needed.
