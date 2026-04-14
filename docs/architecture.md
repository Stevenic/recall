# Recall — Memory Architecture Overview

Local-first agent memory service that manages the full lifecycle of AI agent memories — from raw daily logs through compacted summaries to distilled wisdom — with semantic search over all of it.

---

## System Layers

```
┌──────────────────────────────┐
│        CLI  (recall)         │
├──────────────────────────────┤
│      MemoryService API       │
├──────────┬──────────┬────────┤
│  Files   │  Search  │Compact │
├──────────┴──────────┴────────┤
│     Abstraction Layer        │
│  Storage · Embeddings ·      │
│  Index   · Model             │
└──────────────────────────────┘
```

| Layer | Responsibility | Source |
|-------|----------------|--------|
| **CLI** | Command parsing, output formatting | `packages/core/src/cli.ts` |
| **MemoryService** | Top-level orchestrator, composes all subsystems | `packages/core/src/service.ts` |
| **MemoryFiles** | CRUD for daily, weekly, monthly, typed, and wisdom files | `packages/core/src/files.ts` |
| **SearchService** | Two-phase hierarchical search with BM25 + vector fusion | `packages/core/src/search.ts` |
| **Compactor** | Daily→weekly→monthly→wisdom compression pipeline | `packages/core/src/compactor.ts` |
| **Abstractions** | Pluggable interfaces for storage, embeddings, indexing, and LLM | `packages/core/src/interfaces/` |

---

## Memory File Layout

```
<memory-root>/
├── WISDOM.md                    # Distilled principles (permanent)
├── memory/
│   ├── 2026-04-01.md            # Daily logs (raw, never deleted)
│   ├── 2026-04-02.md
│   ├── type_topic.md            # Typed memories (user, feedback, project, reference)
│   ├── weekly/
│   │   ├── 2026-W13.md          # Weekly summaries (with pointers to dailies)
│   │   └── 2026-W14.md
│   └── monthly/
│       ├── 2026-03.md           # Monthly summaries (with pointers to weeklies)
│       └── 2026-04.md
└── .index/                      # Vectra vector index
```

All memory files use YAML frontmatter for metadata. Parent nodes (weekly/monthly) include a `pointers` array referencing their children and a `salience` map of per-child weights.

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

### Typed Memories

Short, durable knowledge extracted during compaction or written directly by agents:

| Type | Purpose | Example |
|------|---------|---------|
| `user` | Role, preferences, knowledge | "Senior Go engineer, new to React" |
| `feedback` | Behavioral guidance | "Don't mock the database in integration tests" |
| `project` | Ongoing work context | "Merge freeze begins 2026-03-05 for mobile release" |
| `reference` | Pointers to external systems | "Pipeline bugs tracked in Linear project INGEST" |

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

- **Catalog matching** (`catalog.ts`): Frontmatter keyword overlap on typed memories — fast, no embeddings, catches exact-name hits.
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
| `search <query>` | Search memories (all options: `--results`, `--max-chunks`, `--max-tokens`, `--no-sync`) |
| `index` | Full rebuild of vector index |
| `sync` | Incremental index sync |
| `status` | Memory file counts and index health |
| `compact [level]` | Compact to level (`weekly` / `monthly` / `wisdom`) with `--dry-run` and `--agent` |
| `log <entry>` | Append entry to today's daily log |
| `list [type]` | List memory files |
| `read <file>` | Read a memory file |
| `watch` | Watch for changes and auto-sync/compact |
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
| **Input** | Raw memories for a period | Search signals, entity scans, wisdom drift |
| **Output** | Summary files in hierarchy | Insights, typed memory promotions, contradiction flags |
| **LLM usage** | Summarization | Cross-reference analysis, gap analysis, theme synthesis |

### Three Phases

```
Search signals + Entity scans + Staleness checks + Wisdom drift
    │
    ▼
Phase 1: Gather ──► Phase 2: Analyze ──► Phase 3: Write
 (signals)           (LLM synthesis)       (persist)
    │                     │                    │
    ▼                     ▼                    ▼
candidates.json     insight drafts       memory/dreams/insights/
                    contradiction flags   memory/dreams/contradictions/
                    typed memory candidates  memory/<type>_<topic>.md
                                          DREAMS.md (diary)
```

**Phase 1 — Gather:** Collects signals from search logs (query patterns, hit frequency, null queries), entity frequency scans, typed memory staleness checks, and wisdom-vs-behavior drift analysis. Produces a scored candidate list.

**Phase 2 — Analyze:** Sends candidate clusters to the LLM via `MemoryModel` for cross-reference analysis, gap analysis, contradiction detection, typed memory extraction, and theme synthesis. Each analysis type has a dedicated prompt template.

**Phase 3 — Write:** Persists results as insight files, typed memory promotions, contradiction reports, and dream diary entries. All output files are indexed in Vectra and become searchable.

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
│   └── dreams/
│       ├── insights/
│       │   └── 2026-04-11-auth-evolution.md
│       └── contradictions/
│           └── 2026-04-11.md
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

For full design details, see [`specs/dreaming.md`](../specs/dreaming.md).

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

- [`specs/memory-service.md`](../specs/memory-service.md) — Service architecture, abstractions, compaction, CLI (v0.3)
- [`specs/hierarchical-memory.md`](../specs/hierarchical-memory.md) — Eidetic storage, pointers, two-phase search, salience (v0.4)
- [`specs/dreaming.md`](../specs/dreaming.md) — Asynchronous knowledge synthesis, signal collection, cross-temporal analysis (v0.1)
- [`docs/prompts/`](prompts/) — Compaction prompt templates (daily→weekly, weekly→monthly, wisdom distillation)
