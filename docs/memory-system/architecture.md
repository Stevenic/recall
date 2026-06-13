---
title: Architecture
layout: default
parent: Recall Memory System
nav_order: 1
---

# Recall — Memory Architecture Overview

Local-first agent memory service that manages the full lifecycle of AI agent memories — from raw daily logs through compacted summaries to distilled wisdom — with semantic search over all of it.

---

## System Layers

```
┌─────────────────────────────────────────────┐
│                 CLI  (recall)               │
├─────────────────────────────────────────────┤
│              MemoryService API              │
├────────┬────────┬─────────┬───────┬─────────┤
│ Files  │ Search │ Compact │ Wiki  │  Dream  │
├────────┴────────┴─────────┴───────┴─────────┤
│              Abstraction Layer              │
│     Storage · Embeddings · Index · Model    │
└─────────────────────────────────────────────┘
```

Recall manages two parallel views of memory: a **temporal stream** (daily logs rolled up by compaction) and a **topical [wiki](wiki.html)** of cross-linked pages. Compaction maintains the first; the wiki and dreaming maintain the second.

| Layer | Responsibility | Source |
|-------|----------------|--------|
| **CLI** | Command parsing, output formatting | `packages/core/src/cli.ts` |
| **MemoryService** | Top-level orchestrator, composes all subsystems | `packages/core/src/service.ts` |
| **MemoryFiles** | CRUD for daily, weekly, monthly, wiki, and wisdom files | `packages/core/src/files.ts` |
| **SearchService** | Two-phase hierarchical search with BM25 + vector fusion | `packages/core/src/search.ts` |
| **Compactor** | Daily→weekly→monthly→wisdom compression pipeline | `packages/core/src/compactor.ts` |
| **WikiEngine** | Topical knowledge pages — stub/append/synthesize/lint/merge/supersede | `packages/core/src/wiki-engine.ts` |
| **DreamEngine** | Asynchronous cross-temporal synthesis; writes wiki pages and supersessions | `packages/core/src/dream-engine.ts` |
| **IdentityLoader** | Agent identity frame (role/voice) used to steer synthesis | `packages/core/src/identity.ts` |
| **Abstractions** | Pluggable interfaces for storage, embeddings, indexing, and LLM | `packages/core/src/interfaces/` |

---

## Memory File Layout

```
<memory-root>/
├── WISDOM.md                    # Distilled principles + Knowledge Map (permanent)
├── DREAMS.md                    # Dream diary (append-only)
├── IDENTITY.md                  # Agent identity frame (role, voice)
├── memory/
│   ├── 2026-04-01.md            # Daily logs (raw, never deleted)
│   ├── 2026-04-02.md
│   ├── weekly/
│   │   ├── 2026-W13.md          # Weekly summaries (with pointers to dailies)
│   │   └── 2026-W14.md
│   ├── monthly/
│   │   ├── 2026-03.md           # Monthly summaries (with pointers to weeklies)
│   │   └── 2026-04.md
│   └── wiki/                    # Topical knowledge pages (one per subject)
│       ├── index.md
│       └── auth-middleware.md
└── .index/                      # Vectra vector index
```

All memory files use YAML frontmatter for metadata. Parent nodes (weekly/monthly) include a `pointers` array referencing their children and a `salience` map of per-child weights.

The earlier *typed memory* files (`user_*.md`, `feedback_*.md`, `project_*.md`, `reference_*.md`) have been folded into the [wiki](wiki.html): their four types became wiki **categories**, and `wiki migrate-typed-memories` converts any legacy files in place.

---

## Memory Lifecycle

Recall implements an **eidetic (lossless) memory model** — raw memories are never deleted. Compaction adds compressed layers on top without removing detail.

```
Daily logs  ──(7+ days)──►  Weekly summary  ──(4+ weeks)──►  Monthly summary
    │                            │                                │
    │                            │                                │
    ▼                            ▼                                ▼
  (permanent)              (permanent,                      (permanent,
                            pointers to dailies,             pointers to weeklies,
                            salience weights,                salience weights,
                            dual embeddings)                 dual embeddings)
                                                                  │
                                                                  ▼
                                                          Wisdom distillation
```

### Compaction Pipeline

1. **Daily → Weekly:** Collects dailies for a completed ISO week, sends to LLM, produces structured summary. Extracts typed memory candidates (decisions, feedback, project context). Stores `pointers` to source dailies and computes salience weights per child.

2. **Weekly → Monthly:** Aggregates weeklies for a calendar month into a monthly summary. More aggressive compression (~30% of input). Stores `pointers` to source weeklies.

3. **Wisdom Distillation:** Merges insights from monthlies and typed memories into `WISDOM.md`. Deduplicates, removes stale entries, caps at configurable max entries (default 20).

### Topical Knowledge → the Wiki

Durable knowledge that isn't tied to a single day — rules, decisions, facts about people and systems — lives in the **[wiki](wiki.html)** rather than the temporal hierarchy. The agent writes short *stub* pages in real time; dreaming synthesizes them into richer pages as sources accumulate, and keeps them current via [supersession](wiki.html#supersession). The four former *typed memory* types are now wiki **categories**:

| Category | Purpose | Example |
|----------|---------|---------|
| `entity` | People, teams, systems, organizations | "Northstar Gridworks — primary infra vendor" |
| `concept` | Rules / behavioral guidance (was `feedback`) | "Don't mock the database in integration tests" |
| `project` | Ongoing work context (was `project`) | "Auth middleware: cookie→JWT migration, compliance-driven" |
| `reference` | Pointers to external systems (was `reference`) | "Pipeline bugs tracked in Linear project INGEST" |
| `theme` | Cross-cutting patterns synthesized by dreaming | "Migrations consistently slip when compliance gates them" |

See **[The LLM Wiki](wiki.html)** for the full page anatomy, the stub→synthesis lifecycle, and supersession.

---

## Search Architecture

Recall uses a **two-phase hierarchical search** that balances high recall (don't miss relevant memories) with high precision (rank the best ones first).

### Phase 1a — Candidate Retrieval (Parallel)

Three retrieval paths run concurrently:

| Path | What it searches | Why |
|------|-----------------|-----|
| **Parent vector search** | `#agg` and `#summary` embeddings on weekly/monthly nodes | Coarse routing — finds relevant time periods |
| **Raw direct search** | Embeddings on individual daily/typed memories | Safety net — catches niche memories aggregation might wash out |
| **BM25 keyword search** | Parent summary text | Precise for proper nouns, IDs, error codes, rare terms |

Parent oversampling (default K=10) compensates for aggregation washout in parent embeddings.

### Phase 1b — Pointer Expansion

For each parent node retrieved, recursively load all children via `pointers` frontmatter — always expanding to leaf (raw memory) level. Also includes parent summaries as separate candidates.

### Phase 2 — Reranking

Every candidate is scored with a hybrid formula:

```
score = w_embed · cosine(query, embedding)
      + w_bm25  · BM25(query, text)
      + w_parent · parent_score
      × temporal_affinity
```

Default weights: `embed=0.5`, `bm25=0.3`, `parent=0.2` (configurable, must sum to 1.0).

Results are returned with a `resultType` (`RAW` or `SUMMARY`) and optional `scoreBreakdown` for debugging.

### Temporal Affinity

When a query contains a time reference ("last March", "Q3 2024", "two weeks ago"), memories closer to that date receive a multiplicative boost:

```
temporal_affinity = exp(-|memory_date - reference_date| / σ)
```

Default σ = 30 days. Without a temporal reference, affinity is neutral (1.0 for all memories). There is no recency decay — old memories are never penalized just for age.

Temporal references are extracted via regex patterns (explicit dates, relative references, quarters, named periods). The most specific reference wins when multiple are detected. Callers can override via `QueryOptions.temporalReference`.

### Supporting Search Features

- **Hybrid retrieval**: Vectra's combined semantic + BM25 retrieval is enabled, so dense and lexical matches are fused at the index level before reranking.
- **Catalog matching** (`catalog.ts`): Frontmatter keyword overlap on wiki pages and any remaining typed memories — fast, no embeddings, catches exact-name hits.
- **Temporal embeddings**: Chunk text is prefixed with `[as of YYYY-MM-DD]` before embedding, so a memory's date is part of its vector — sharpening time-sensitive retrieval without relying on regex extraction alone.
- **Wiki score boost** (`wiki.scoreBoost`, default `0.9`): A multiplier applied to wiki-page retrieval scores. The default is a deliberate *de-boost* so a synthesized page can't outrank the immutable daily that holds a specific fact — see [The LLM Wiki](wiki.html#retrieval-and-the-score-boost).
- **Query expansion** (`query-expansion.ts`): Generates 1–3 query variations (original, keyword-only, noun phrases) and merges results by URI. No LLM needed.

---

## Embeddings & Indexing

### Dual Embeddings Per Parent

Each parent node (weekly/monthly) stores two embeddings in the index:

| Entry | URI Pattern | Source | Purpose |
|-------|-------------|--------|---------|
| **Summary** | `weekly/2026-W15#summary` | Embedding of generated summary text | Gap coverage — captures editorially chosen importance |
| **Aggregated** | `weekly/2026-W15#agg` | Normalized weighted mean of child embeddings | Coarse routing — preserves semantic spread of children |

Summary alone can miss niche details. Aggregated alone washes out when children are diverse. Together they cast a wider net during Phase 1 retrieval.

### Salience-Weighted Aggregation

Aggregated embeddings use salience weights rather than uniform averaging:

```
e_agg = normalize( Σ salience_i × e_i )
```

Three salience signals (computed at compaction time, stored in parent frontmatter):

| Signal | Weight | Method |
|--------|--------|--------|
| Token count | 0.4 | Token counter — longer entries are more substantive |
| Entity density | 0.3 | NER + regex + vocabulary — more unique entities = semantically richer |
| Decision markers | 0.3 | Regex patterns ("decided to", "switched to", "chose X over Y") |

Alternative aggregation strategies (`uniform`, `recency`) are configurable but `salience` is the default.

### Default Embeddings Model

`LocalEmbeddings` uses `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2`:
- 384-dimensional vectors
- Fully offline, no API keys
- Lazy-loaded on first use

---

## Pluggable Abstractions

All core subsystems are behind interfaces, swappable at configuration time:

| Interface | Default Implementation | Planned |
|-----------|----------------------|---------|
| **FileStorage** | `LocalFileStorage` (local disk) | SQLite |
| **EmbeddingsModel** | `LocalEmbeddings` (transformers.js, offline) | OpenAI, Anthropic |
| **MemoryIndex** | `VectraIndex` (Vectra local vector DB) | SQLite |
| **MemoryModel** | `CliAgentModel` (spawns CLI agent subprocess) | OpenAI, Anthropic, OSS |

### CliAgentModel

LLM operations (compaction, wisdom distillation) are delegated to a CLI coding agent via subprocess:

| Agent name | CLI command |
|-----------|-------------|
| `"claude"` | `claude --print` (via stdin) |
| `"codex"` | `codex` (custom flags) |
| `"copilot"` | `copilot` (custom flags) |

No API keys needed — the host agent's CLI handles authentication.

---

## CLI Surface

```
recall [--dir <path>] [--json] [--verbose] <command>
```

| Command | Description |
|---------|-------------|
| `search <query>` | Search memories (`--results`, `--max-chunks`, `--max-tokens`, `--recency-depth`, `--typed-memory-boost`, `--wiki-boost`, `--wiki-only`, `--no-wiki`, `--no-sync`) |
| `index` | Full rebuild of vector index |
| `sync` | Incremental index sync |
| `status` | Memory file counts and index health |
| `compact [level]` | Compact to level (`weekly` / `monthly` / `wisdom`) with `--dry-run` and `--agent` |
| `dream` | Run an asynchronous synthesis session; `dream status` shows the last run and pending signals |
| `wiki <subcommand>` | Manage topical knowledge pages — `list`, `show`, `stub`, `append`, `rebuild`, `merge`, `rename`, `lint`, `status` (see [The LLM Wiki](wiki.html#cli)) |
| `log <entry>` | Append entry to today's daily log |
| `list [type]` | List memory files |
| `read <file>` | Read a memory file |
| `watch` | Watch for changes and auto-sync, with optional `--compact` / `--dream` |
| `migrate` | Migrate existing memories to hierarchical architecture |

---

## Storage Budget

Three-year projection for a single agent:

| Component | Estimate |
|-----------|----------|
| Raw daily text (1,095 files) | ~1.1 MB |
| Summary text (weekly + monthly) | ~0.5 MB |
| Embeddings (384-dim float32, ~1,679 entries) | ~2.5 MB |
| Index overhead (1.5× embeddings) | ~1.3 MB |
| Typed memories + wisdom | ~0.3 MB |
| **Total** | **~5.7 MB** |

The eidetic design keeps total storage minimal because individual memory files are small (markdown text).

---

## Dreaming System

Dreaming is an **asynchronous knowledge synthesis** engine that runs alongside compaction. While compaction is structural (summarize within temporal windows), dreaming is analytical — it discovers patterns across time boundaries, surfaces forgotten connections, detects contradictions, and promotes durable knowledge that compaction's single-pass extraction missed.

### How It Differs from Compaction

| | Compaction | Dreaming |
|--|-----------|----------|
| **Trigger** | Temporal boundaries (week/month end) | Scheduled (cron) or on-demand |
| **Scope** | Within one time window | Across all time windows |
| **Input** | Raw memories for a period | Search signals, entity scans, decision markers, wisdom drift |
| **Output** | Summary files in hierarchy | Wiki pages (stubs + synthesized rewrites), supersessions, contradiction flags |
| **LLM usage** | Summarization | Cross-reference analysis, gap analysis, contradiction detection, theme synthesis |

### Three Phases

```
Search signals + Entity scans + Decision markers + Staleness + Wisdom drift
    │
    ▼
Phase 1: Gather ──► Phase 2: Analyze ──► Phase 3: Write
 (signals)           (LLM synthesis)       (persist)
    │                     │                    │
    ▼                     ▼                    ▼
candidates.json     wiki ops (create/update)  memory/wiki/<slug>.md
                    supersession proposals     (+ supersedes frontmatter)
                    contradiction flags        DREAMS.md (diary)
```

**Phase 1 — Gather:** Collects signals from search logs (query patterns, hit frequency, null queries), entity frequency scans, decision-marker scans (for [supersession](wiki.html#supersession)), wiki staleness checks, and wisdom-vs-behavior drift analysis. Produces a scored candidate list.

**Phase 2 — Analyze:** Sends candidate clusters to the LLM via `MemoryModel` for cross-reference analysis, gap analysis, contradiction detection, and theme synthesis. Each analysis type has a dedicated prompt template; the output is a set of **wiki operations** (create a stub, synthesize a page, supersede a prior claim).

**Phase 3 — Write:** Applies the wiki operations — creating or rewriting `memory/wiki/<slug>.md` pages, recording superseded claims in their `supersedes` frontmatter, flagging contradictions, and appending a `DREAMS.md` diary entry. All output is indexed in Vectra and becomes searchable. (Legacy `memory/dreams/insights/` files from earlier versions are converted to wiki pages by `wiki migrate-insights`.)

### Signal Collection

The search service logs every query + result set to `.dreams/search-log.jsonl` when dreaming is enabled. From this, the engine computes:

- **Hit frequency** — Which memories get recalled most often
- **Query diversity** — Memories hit by many different queries are cross-cutting
- **Null queries** — Topics the memory system can't answer (knowledge gaps)
- **Temporal clusters** — Which time periods are being actively investigated

### File Layout

```
<memory-root>/
├── DREAMS.md                              # Dream diary (append-only)
├── memory/
│   └── wiki/                              # Where dreaming writes its synthesis
│       ├── auth-middleware.md             #   (pages + supersedes frontmatter)
│       └── auth-middleware-trajectory.md  #   (auto-built once a page has ≥2 supersessions)
└── .dreams/                               # Machine state (gitignored)
    ├── search-log.jsonl
    ├── candidates.json
    └── dream-state.json
```

### CLI

```
recall dream                    # Run a full dreaming session
recall dream --dry-run          # Show what would be examined
recall dream status             # Last run, pending candidates, signal stats
recall watch --dream            # Enable scheduled dreaming in watch mode
```

For full design details, see [`specs/dreaming.md`](https://github.com/Stevenic/recall/blob/main/specs/dreaming.md).

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `vectra` | Vector index, storage abstractions, BM25 |
| `@huggingface/transformers` | Local embeddings (MiniLM-L6-v2), NER for salience |
| `commander` | CLI framework |
| `gray-matter` | YAML frontmatter parsing |
| `gpt-tokenizer` | Token counting for budget management |

---

## Design Specs

For full details, see:

- [`specs/memory-service.md`](https://github.com/Stevenic/recall/blob/main/specs/memory-service.md) — Service architecture, abstractions, compaction, CLI (v0.4)
- [`specs/hierarchical-memory.md`](https://github.com/Stevenic/recall/blob/main/specs/hierarchical-memory.md) — Eidetic storage, pointers, two-phase search, salience (v0.4)
- [`specs/dreaming.md`](https://github.com/Stevenic/recall/blob/main/specs/dreaming.md) — Asynchronous knowledge synthesis, signal collection, cross-temporal analysis (v0.2)
- [`specs/wiki.md`](https://github.com/Stevenic/recall/blob/main/specs/wiki.md) — Topical knowledge graph: stubs, synthesis, supersession, shared wikis (v0.4)
- [**The LLM Wiki**](wiki.html) — Operator guide to the wiki layer and supersession
- [Prompts](prompts/) — Compaction prompt templates (daily→weekly, weekly→monthly, wisdom distillation)
