# Steven Ickman — Wisdom

Distilled from work history. Updated during compaction.

Last compacted: 2026-04-26

---

## Core Principles

**Pointer-chasing is the generalizable mechanism.**
The breakthrough behind Karpathy's LLM Wiki pattern isn't knowledge graphs specifically — it's that you can feed an agent a memory containing pointers to other memories and let the agent chase them on demand. This applies to any memory type (knowledge, decisions, projects, references), not just facts. Recall's hierarchical parents, wiki cross-links, and dreaming outputs all exploit the same primitive.

**Eidetic storage — raw memories are never deleted.**
Daily logs are the permanent source of truth (~5 MB for 3 years). Higher-level nodes (weekly, monthly, wiki) store pointers to children + generated summaries. Parents are routing aids, not authoritative memory. Any synthesized artifact is regenerable from its `sources` list.

**Summaries assist recall, never replace source data.**
This is the corollary to eidetic storage. It governs every compaction, dreaming, and wiki write decision.

## Architecture & Storage

**One `.index/` per memory root — partition by roots, not names.**
Multi-agent and multi-project isolation uses separate memory roots, each with its own `.index/`. The filesystem boundary is the natural partition.

**Pointer-based parent nodes with dual embeddings.**
Each parent (weekly/monthly) stores two index entries: aggregated child embedding (`#agg` for coarse routing) and summary embedding (`#summary` for gap coverage). Kept separate to avoid redundant signal and washout.

**Salience-weighted aggregation ships in MVP.**
Child weights: token count (0.4) + entity density (0.3) + decision markers (0.3). Computed at compaction time, stored in parent frontmatter, reused at query time. NER via `Xenova/bert-base-NER` (lazy-loaded), token count via `gpt-tokenizer`, project/tool names via regex + vocabulary `Set`.

## Wiki Layer (new — spec v0.2 drafted 2026-04-26)

**Wiki = topical knowledge graph alongside temporal logs.**
Per `specs/wiki.md`. One markdown file per entity/concept/project/reference/theme. Cross-references via `[[slug]]` links. Vectra-indexed with configurable score boost (~1.2–1.5×) because pages represent compiled, cross-referenced knowledge.

**Two write modes, same file format.**
Agent writes single-source stubs in real time during conversations. Dreaming enriches stubs into synthesized multi-source pages once 3+ sources accumulate. `len(sources)` is the only signal distinguishing them.

**Wiki replaces typed memories and dreaming insight files.**
The `<type>_<topic>.md` filename convention is retired; the four typed categories (`user`, `feedback`, `project`, `reference`) become wiki page categories with per-category templates that preserve typed-memory write conventions (rule/fact + **Why:** + **How to apply:**). Dreaming pipeline outputs wiki pages instead of separate insight files.

**Cross-references are free pointer expansion.**
Wiki `[[links]]` are pointers; recall fetches and reranks linked pages on demand using the same hierarchical pointer-expansion mechanism.

## Search & Retrieval

**Two-phase recall: Phase 1 for recall, Phase 2 for precision.**
Phase 1a retrieves candidates in parallel: parent vector search (agg + summary), direct raw memory search, and BM25 over parent summaries. Phase 1b expands pointers recursively to leaf. Phase 2 reranks with configurable weights (embed 0.5, BM25 0.3, parent 0.2).

**Temporal affinity, not recency decay.**
Old memories are never penalized. Temporal references (regex-detected) boost date-proximate memories multiplicatively. Without a temporal reference, scoring is purely semantic + keyword. Caller can override via `QueryOptions.temporalReference`.

**BM25 via Vectra built-in — no additional library.**
Used in both Phase 1 (parent retrieval) and Phase 2 (reranking). Especially valuable for proper nouns, IDs, error codes, and rare terms that embeddings blur.

## Dreaming System

**Dreaming is asynchronous knowledge synthesis, complementary to compaction.**
Compaction is structural (summarize within temporal windows). Dreaming is analytical — discovers cross-temporal patterns, surfaces forgotten connections, extracts insights, promotes durable knowledge, and detects contradictions. Output is now wiki pages (post v0.2 spec).

**Three-phase pipeline: Gather → Analyze → Write.**
Gather collects signals from search logs, entity scans, staleness checks, and wisdom drift (deterministic). Analyze uses the LLM via `MemoryModel` for synthesis. Write persists results without modifying existing files (append-only, eidetic-compatible).

**Signal-driven candidate selection with weighted scoring.**
Five signal types: hit frequency (0.25), query diversity (0.25), gap signal (0.20), staleness (0.15), entity frequency (0.15). Max 20 candidates per session. Unprocessed candidates carry over.

**Search signal logging via `SearchLogger`.**
Append-only JSONL at `.dreams/search-log.jsonl`. Records query, result URIs, scores, topK, timestamp. Rotated monthly. Opt-in via `DreamingConfig.logSearches`. `.dreams/` is gitignored machine state.

## Model & Abstractions

**Four pluggable abstraction layers with sensible defaults.**
Storage (LocalFileStorage), Embeddings (transformers.js / all-MiniLM-L6-v2), Index (VectraIndex), Model (CliAgentModel). All swappable via `MemoryServiceConfig`. Model has no default — must be configured explicitly. CliAgentModel takes a well-known name (`"claude"` | `"codex"` | `"copilot"`) or a raw command string — no auto-detection.

**CompletionResult surfaces token counts and error details.**
`complete()` returns text, inputTokens, outputTokens, and structured error info (code, message, retryable flag, retryAfterMs) for rate-limit handling and cost tracking.

**Use Vectra 0.14.0, not older versions.**
Exports `FileStorage`, `LocalFileStorage`, `VirtualFileStorage`. Reuse Vectra's abstractions — `VirtualFileStorage` for tests.

## Compaction Pipeline

**Compaction is two-phase: structural roll-up, then LLM compression.**
Phase 1 reorganizes without an LLM (cheap). Phase 2 fires only when token budgets are exceeded. Generates pointer nodes instead of deleting old data.

**All thresholds configurable with smart defaults.**
Compression ratio (30%), wisdom cap (20 entries), minimum-log triggers — all overridable via `CompactionConfig` / `WisdomConfig`. Markdown chunking is heading-aware with token budgets (`gpt-tokenizer`); preserves frontmatter in first chunk.

## Project Structure

**Monorepo with package boundaries.**
Core in `packages/core/`. Benchmark tool in `packages/recall-bench/`. Future packages (storage-sqlite, model-openai, etc.) get their own dirs.

**Watch mode is opt-in for compaction, default for sync.**
`recall watch` auto-syncs on file changes (debounce 2s default). Compaction triggers only with `--compact` flag. Dreaming via `--dream` flag — protects against unexpected LLM calls.

**Language bindings are thin CLI wrappers.**
Bindings (Python, Go, Rust, C#) spawn the `recall` CLI with `--json` and parse structured output. Logic lives in one place (TypeScript core). gRPC server support also planned for cross-language memory system binding.

## Benchmarking (recall-bench)

**Persona-driven benchmark harness for agent memory systems.**
1000 days of synthetic memories per persona. Default 1-week evaluation interval (143 evaluation points). Pluggable via gRPC adapter or direct TypeScript adapter.

**5 shipped personas across diverse domains.**
backend-eng-saas, er-physician, litigation-attorney, research-scientist, financial-advisor. Each persona ships as 2 files (consolidated from 3 per 2026-04-25 decision).

**Personas model the humans the agent interacts with.**
recall-bench simulates an *agent*, so each persona needs a variable number of human collaborators (peers, stakeholders, clients) — first-class part of persona definition, not an afterthought of arc generation.

**Generation order: persona & arcs → Q&A → memories.**
Q&A pairs defined *after* persona/arcs are locked but *before* memory generation, so memories deliberately seed the facts each evaluation question needs to recall. Avoids unanswerable or trivially-answered questions.

**Two-pass dataset generation.**
Pass 1 generates daily activity logs from story arcs (with gap filling for weeks < 5 active days). Pass 2 optionally constructs ~100 days of conversation history that produces those logs. Separates "what happened" from "how it was communicated."

**Story arcs create realistic complexity.**
Max 4 concurrent arcs. Types: projects, incidents, decisions, learning, relationships, corrections. Correction arcs specifically test belief revision. Quiet periods (vacations, breaks) test temporal gap handling.

**8+1 evaluation categories.**
factual-recall, temporal-reasoning, decision-tracking, contradiction-resolution, cross-reference, recency-bias-resistance, synthesis, negative-recall — scored on correctness (0–3) + completeness (0–2) + hallucination (0–1) = composite max 6.0. Hallucination is the +1 dimension tracked over time.

**Heatmap is the primary output artifact.**
Category × evaluation-point grid. Green→amber→red gradient. Column = evaluation point (left-to-right shows degradation as corpus grows). Row = category. Cells color-only, continuous gradient; cell width auto-scales (4–16px). Generated via `scripts/generate-heatmap.mjs --interval 7d --days 1000`.

## Implementation Status

**Core MVP: Phases 1–2 complete; Phase 3 (index & search) and Phase 4 (compaction) in progress.**
Scaffolding, interfaces, and file management done. Phase 5 (MemoryService wiring & CLI) follows. @beacon owns implementation.

**Hierarchical memory (kicked off 2026-04-09).**
5 phases (A–E). A: eidetic storage. B: dual embeddings + salience. C: two-phase recall (depends on B). D: BM25 integration (parallel with C). E: migration CLI. A+B started in parallel. @beacon owns.

**Dreaming system (scaffolding added 2026-04-12).**
`DreamEngine`, `SearchLogger`, `SignalCollector`, `DreamingConfig` types in `packages/core/src/`. Phases A→D. A (search signal infra) can ship independently to start accumulating signals. @beacon owns.

**Wiki layer (spec v0.2 drafted 2026-04-26).**
`specs/wiki.md` by @scribe. Open question being evaluated: do typed memories remain necessary if wiki/pointer model is in place? Spec position: typed memories are subsumed (categories become wiki page categories).

**Persona generation in flight for recall-bench (status 2026-04-25).**
Active modification: `packages/recall-bench/src/cli-generator-model.ts`, `cli.ts`, `generator.ts`. research-scientist persona memories partially generated. Adding human-collaborator modeling per persona; reordering Q&A to precede memory generation; persona file shape consolidated to 2 files. @beacon owns.
