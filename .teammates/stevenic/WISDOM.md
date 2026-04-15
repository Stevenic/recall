# Steven Ickman — Wisdom

Distilled from work history. Updated during compaction.

Last compacted: 2026-04-15

---

## Architecture & Storage

**One `.index/` per memory root — partition by roots, not names.**
Multi-agent and multi-project isolation uses separate memory roots, each with its own `.index/` folder. The filesystem boundary is the natural partition.

**Eidetic storage — raw memories are never deleted.**
The hierarchical memory system (spec v0.4) replaces lossy compaction. Raw daily logs are the permanent source of truth (~5 MB for 3 years). Higher-level nodes (weekly, monthly) store pointers to children + generated summaries. Parents are routing aids, not authoritative memory.

**Pointer-based parent nodes with dual embeddings.**
Each parent (weekly/monthly) stores two index entries: an aggregated child embedding (`#agg` for coarse routing) and a summary embedding (`#summary` for gap coverage). Kept separate to avoid redundant signal and washout.

**Salience-weighted aggregation ships in MVP.**
Child weights: token count (0.4) + entity density (0.3) + decision markers (0.3). Extraction runs at compaction time (amortized). Scores stored in parent frontmatter, reused at query time with zero cost. Token count via `gpt-tokenizer`. NER via `@huggingface/transformers` (`Xenova/bert-base-NER`) — lazy-load, cache, reuse. Project/tool names via regex + vocabulary `Set`. Decision markers via regex.

## Search & Retrieval

**Two-phase recall: Phase 1 for recall, Phase 2 for precision.**
Phase 1a retrieves candidates in parallel: parent vector search (agg + summary), direct raw memory search, and BM25 over parent summaries. Phase 1b expands pointers recursively to leaf. Phase 2 reranks with configurable weights (embed 0.5, BM25 0.3, parent 0.2).

**Temporal affinity, not recency decay.**
Old memories are never penalized. Temporal references (regex-detected) boost date-proximate memories multiplicatively. Without a temporal reference, scoring is purely semantic + keyword. Caller can override via `QueryOptions.temporalReference`.

**BM25 via Vectra built-in — no additional library.**
Used in both Phase 1 (parent retrieval) and Phase 2 (reranking). Especially valuable for proper nouns, IDs, error codes, and rare terms that embeddings blur.

## Dreaming System

**Dreaming is asynchronous knowledge synthesis, complementary to compaction.**
Compaction is structural (summarize within temporal windows). Dreaming is analytical — discovers cross-temporal patterns, surfaces forgotten connections, extracts insights, promotes durable knowledge, and detects contradictions.

**Three-phase pipeline: Gather → Analyze → Write.**
Phase 1 (Gather) collects signals from search logs, entity scans, staleness checks, and wisdom drift — all deterministic. Phase 2 (Analyze) uses the LLM via `MemoryModel` abstraction for synthesis. Phase 3 (Write) persists results without modifying existing files.

**Signal-driven candidate selection with weighted scoring.**
Five signal types: hit frequency (0.25), query diversity (0.25), gap signal (0.20), staleness (0.15), entity frequency (0.15). Max 20 candidates per session. Unprocessed candidates carry over.

**Three output types, all append-only.**
Insights (`memory/dreams/insights/`), promoted typed memories (`memory/`), and contradiction flags (`memory/dreams/contradictions/`). Dream diary appended to `DREAMS.md`. All indexed in Vectra. Never modifies or deletes existing files (eidetic-compatible).

**Search signal logging via `SearchLogger`.**
Append-only JSONL at `.dreams/search-log.jsonl`. Records query, result URIs, scores, topK, timestamp. Rotated monthly. Opt-in via `DreamingConfig.logSearches`. `.dreams/` is gitignored machine state.

**Five LLM analysis templates.**
Cross-reference analysis, gap analysis, contradiction detection, typed memory extraction, and theme synthesis. All overridable via `DreamingConfig.analysisTemplates`.

## Model & Abstractions

**Four pluggable abstraction layers with sensible defaults.**
Storage (LocalFileStorage), Embeddings (transformers.js / all-MiniLM-L6-v2), Index (VectraIndex), Model (CliAgentModel). All swappable via `MemoryServiceConfig`. Model has no default — must be configured explicitly.

**CliAgentModel: explicit config, not auto-detection.**
Takes a well-known name (`"claude"` | `"codex"` | `"copilot"`) or a raw command string. No magic sniffing.

**CompletionResult surfaces token counts and error details.**
`complete()` returns text, inputTokens, outputTokens, and structured error info (code, message, retryable flag, retryAfterMs) for rate-limit handling and cost tracking.

**Use Vectra 0.14.0, not older versions.**
The 0.14.x line exports `FileStorage`, `LocalFileStorage`, `VirtualFileStorage`. Reuse Vectra's abstractions — `VirtualFileStorage` for tests.

## Compaction Pipeline

**Compaction is two-phase: structural roll-up, then LLM compression.**
Phase 1 reorganizes without an LLM (cheap). Phase 2 fires only when token budgets are exceeded. Generates pointer nodes instead of deleting old data (eidetic storage).

**All compaction thresholds are configurable with smart defaults.**
Compression ratio (30%), wisdom cap (20 entries), minimum-log triggers — all overridable via `CompactionConfig` / `WisdomConfig`.

**Typed memory extraction happens during daily-to-weekly compaction.**
The compaction prompt extracts typed memories (decisions, feedback, project context, references) as separate `memory/type_topic.md` files with YAML frontmatter.

**Markdown chunking is heading-aware with token budgets.**
Splits on headings, then by token budget (via gpt-tokenizer). Preserves frontmatter in first chunk. Returns chunks with byte offsets for partial-result reporting.

## Project Structure

**Monorepo with package boundaries.**
Core in `packages/core/`. Benchmark tool in `packages/recall-bench/`. Future packages (storage-sqlite, model-openai, etc.) get their own dirs. Workspace root manages shared config.

**Watch mode is opt-in for compaction, default for sync.**
`recall watch` auto-syncs the index on file changes (debounce 2s default). Compaction only triggers with `--compact` flag. Dreaming available via `--dream` flag, protecting against unexpected LLM calls.

**Language bindings are thin CLI wrappers, not reimplementations.**
Bindings (Python, Go, Rust, C#) spawn the `recall` CLI with `--json` and parse structured output. Logic lives in one place (TypeScript core).

## Benchmarking

**recall-bench: persona-driven benchmark harness for agent memory systems.**
1000 days of synthetic memories per persona. Variable evaluation periods (default 1-week intervals = 143 evaluation points). Pluggable via gRPC adapter or direct TypeScript adapter. Covers diverse domains beyond software engineering.

**5 shipped personas across diverse domains.**
backend-eng-saas (SaaS platform), er-physician (trauma center), litigation-attorney (law firm), research-scientist (biology lab), financial-advisor (wealth management). Each has identity YAML, story arcs, daily logs, and Q&A pairs.

**8 evaluation categories.**
factual-recall, temporal-reasoning, decision-tracking, contradiction-resolution, cross-reference, recency-bias-resistance, synthesis, negative-recall. Scored on correctness (0-3) + completeness (0-2) + hallucination (0-1) = composite max 6.0.

**Heatmap is the primary output artifact.**
Category × evaluation-point grid. Green → amber → red color scale. Column = evaluation point (left-to-right shows degradation as corpus grows). Row = category. Reveals which capabilities degrade fastest. Generated via `scripts/generate-heatmap.mjs` with `--interval`, `--days`, `--output` flags. Cells are color-only (no score text), auto-scaling width.

**Benchmark dataset generation is two-pass.**
Pass 1 generates daily activity logs from persona story arcs (arc-driven, with gap filling for weeks < 5 active days). Pass 2 optionally constructs conversations that produce those logs. Separates "what happened" from "how it was communicated."

**Story arcs create realistic complexity.**
4 max concurrent arcs. Arc types: projects, incidents, decisions, learning, relationships, corrections. Correction arcs specifically test belief revision tracking. Quiet periods (vacations, breaks) test temporal gap handling.

**gRPC for cross-language memory system binding.**
`MemoryBenchService` proto maps 1:1 to TypeScript adapter interface. recall-bench binds to memory systems over gRPC. gRPC server support also planned for recall itself.

## Implementation Status

**Core MVP: Phases 1-2 complete, Phase 3 (index & search) and Phase 4 (compaction) in progress.**
Scaffolding & interfaces done. File management done. Phase 5 (MemoryService wiring & CLI) follows. @beacon owns implementation.

**Hierarchical memory implementation kicked off 2026-04-09.**
5 phases (A-E). Phase A: eidetic storage. Phase B: dual embeddings + salience. Phase C: two-phase recall (depends on B). Phase D: BM25 integration (parallel with C). Phase E: migration CLI. A+B started in parallel.

**Dreaming system scaffolding added 2026-04-12.**
`DreamEngine`, `SearchLogger`, `SignalCollector`, and `DreamingConfig` types exist in `packages/core/src/`. Implementation phases: A (search signal infra) → B (signal collection + scoring) → C (synthesis pipeline) → D (output + integration). A can ship independently to start accumulating search signals.
