# Memory System Comparison: Recall vs OpenClaw

A detailed comparison of the **Recall** agent memory service and **OpenClaw's memory-core** plugin system — their architectures, storage models, search pipelines, compaction strategies, and design trade-offs.

---

## 1. Architecture Overview

| Dimension | Recall | OpenClaw (memory-core) |
|-----------|--------|----------------------|
| **Deployment** | Standalone CLI + library (`packages/core`) | Plugin inside OpenClaw host (`extensions/memory-core`) |
| **Storage backend** | Flat markdown files + Vectra vector index | SQLite database + file-backed workspace |
| **Embedding default** | Local transformers.js (`all-MiniLM-L6-v2`, 384-dim) | Auto-detected cloud provider (OpenAI, Gemini, Voyage, etc.) with local fallback |
| **LLM for compaction** | CLI agent subprocess (`CliAgentModel`) — no API keys | Host agent's model (inherits from OpenClaw session) |
| **Multi-backend** | Single backend, pluggable via interfaces | Three backends: Builtin (SQLite), QMD (sidecar binary), Honcho (cross-session) |
| **Host dependency** | None — usable by any agent framework | Tightly coupled to OpenClaw's plugin, agent, and session model |

### Recall Architecture

```
CLI (recall) → MemoryService → Files / Search / Compactor
                                    ↓
                        Storage · Embeddings · Index · Model
                        (LocalFS) (transformers.js) (Vectra) (CliAgent)
```

### OpenClaw Architecture

```
OpenClaw Agent → memory-core plugin → SearchManager → Backend
                       ↓                                  ↓
                 PromptSection              Builtin (SQLite + FTS5 + embeddings)
                 MemoryFlush                QMD (external sidecar)
                 Dreaming                   Honcho (cross-session service)
                 ActiveMemory
```

**Key difference:** Recall is a standalone service that any agent can call. OpenClaw's memory is a first-party plugin woven into the host's lifecycle (prompt injection, pre-compaction flush, session management).

---

## 2. Memory File Layout

### Recall

```
<memory-root>/
├── WISDOM.md                         # Distilled principles (permanent)
├── memory/
│   ├── 2026-04-01.md                 # Daily logs (raw, never deleted)
│   ├── type_topic.md                 # Typed memories (user, feedback, project, reference)
│   ├── weekly/
│   │   └── 2026-W14.md              # Weekly summaries with pointers + salience
│   └── monthly/
│       └── 2026-04.md               # Monthly summaries with pointers + salience
└── .index/                           # Vectra vector index
```

### OpenClaw

```
~/.openclaw/workspace/
├── MEMORY.md                         # Long-term evergreen memory
├── DREAMS.md                         # Dream diary (experimental)
├── memory/
│   ├── 2026-04-01.md                 # Daily notes
│   ├── .dreams/                      # Dreaming machine state
│   │   ├── short-term-recall.json    # Search scoring data
│   │   ├── phase-signals.json        # Light/REM reinforcement
│   │   ├── daily-ingestion.json      # Processed file state
│   │   └── session-corpus/           # Sanitized transcripts
│   └── dreaming/
│       └── <phase>/YYYY-MM-DD.md     # Phase reports
~/.openclaw/memory/<agentId>.sqlite   # Index database
```

### Comparison

| Aspect | Recall | OpenClaw |
|--------|--------|----------|
| **Hierarchy** | 4 levels: daily → weekly → monthly → wisdom | 2 levels: daily notes → MEMORY.md (evergreen) |
| **Summaries** | Explicit weekly/monthly files with pointer frontmatter | No explicit summary files; dreaming promotes snippets to MEMORY.md |
| **Typed memories** | First-class (`type_topic.md` with structured frontmatter) | Not a separate concept; everything lives in daily notes or MEMORY.md |
| **Index storage** | Vectra files on disk (`.index/`) | SQLite database per agent |
| **Metadata** | YAML frontmatter (pointers, salience, period) | JSON state files in `.dreams/` |

---

## 3. Memory Lifecycle

### Recall: Compaction Pipeline

```
Daily logs ──(week complete)──► Weekly summary ──(month complete)──► Monthly summary
     │                               │                                    │
     │                               │                                    ▼
     │                               │                              Wisdom distillation
     │                               │
     ▼                               ▼
  (permanent)                   (permanent, pointers to dailies,
                                 salience weights, dual embeddings)
```

- **Trigger:** Temporal boundaries (week/month completion) + minimum file counts
- **Model:** Eidetic — raw daily logs are **never deleted**
- **Output:** Each summary stores pointers back to source files and salience weights
- **Side effect:** Daily→weekly compaction extracts typed memories (decisions, feedback, references)

### OpenClaw: Dreaming System

```
Daily notes + Session transcripts
     │
     ▼
 Light sleep ──► REM ──► Deep sleep
  (stage)      (patterns)  (promote)
     │                        │
     ▼                        ▼
  short-term-recall.json   MEMORY.md (promoted entries)
  phase-signals.json       DREAMS.md (diary)
```

- **Trigger:** Cron schedule (default 3 AM daily), opt-in
- **Model:** Promotion-based — candidates accumulate recall signals, then get promoted to MEMORY.md when they cross a score threshold
- **Output:** Promoted snippets written to MEMORY.md; dream diary entries to DREAMS.md
- **Scoring:** Six weighted signals — frequency (0.24), relevance (0.30), query diversity (0.15), recency (0.15), consolidation (0.10), conceptual richness (0.06)

### Comparison

| Aspect | Recall | OpenClaw |
|--------|--------|----------|
| **Philosophy** | Eidetic (lossless) — raw data permanent, summaries layer on top | Promotion-based — important snippets graduate to long-term store |
| **Compaction trigger** | Temporal boundaries (week/month end) | Scheduled cron job (dreaming) |
| **Typed memory extraction** | Built into daily→weekly compaction | Not a separate pipeline; concepts extracted as tags during dreaming |
| **Data retention** | All raw files kept forever | Daily notes accumulate; no automatic cleanup |
| **Lineage tracking** | Explicit pointer chains (monthly → weekly → daily) | Recall store tracks source path + line range |
| **Human-readable output** | Weekly/monthly markdown summaries | DREAMS.md diary entries |

---

## 4. Search & Retrieval

### Recall: Two-Phase Hierarchical Search

**Phase 1 — Candidate Retrieval (High Recall):**
1. Parent vector search on `#agg` and `#summary` embeddings (K=10)
2. Raw direct search on daily/typed memory embeddings (K=20)
3. BM25 keyword search on parent summary text
4. Pointer expansion: parent hits → recursively load child files

**Phase 2 — Reranking (Precision):**
```
score = w_embed · cosine(q, e) + w_bm25 · BM25(q, t) + w_parent · parent_score × temporal_affinity
```
Default weights: embed=0.5, bm25=0.3, parent=0.2

**Supporting features:**
- Query expansion (keyword + noun-phrase variants, no LLM)
- Recency pass (inject N most recent weekly summaries regardless of relevance)
- Typed memory boost (1.2× for catalog matches)
- Temporal affinity (`exp(-|date_diff| / σ)`, σ=30 days, no recency decay)
- Dual embeddings per parent: summary + aggregated child vectors

### OpenClaw: Hybrid Search

**Pipeline:**
```
Query → Embed + Tokenize → Vector Search ∥ BM25 (FTS5) → Weighted Merge → MMR → Results
```

**Features:**
- Temporal decay (30-day half-life — old notes lose ranking)
- MMR (Maximal Marginal Relevance) for diversity
- CJK trigram tokenization
- Multimodal support (images/audio via Gemini Embedding 2)
- Session transcript indexing (optional)
- Embedding cache in SQLite

### Comparison

| Aspect | Recall | OpenClaw |
|--------|--------|----------|
| **Search phases** | Two-phase: retrieve + rerank | Single-phase: hybrid merge |
| **Hierarchical** | Yes — searches parent summaries first, expands to children | No — flat search across all indexed chunks |
| **BM25** | Via Vectra on summary text | Via SQLite FTS5 on all chunks |
| **Vector search** | Vectra (local file index) | SQLite + embedding provider |
| **Temporal handling** | Affinity boost (no decay) — neutral by default, rewards temporal matches | Temporal decay (30-day half-life) — recent notes ranked higher |
| **Diversity** | Not explicit (query expansion provides variation) | MMR deduplication |
| **Multimodal** | Text only | Images + audio (with Gemini embeddings) |
| **Query expansion** | Built-in (keywords + noun phrases) | Not built-in (relies on LLM query formulation) |
| **Result metadata** | `resultType` (RAW/SUMMARY), `scoreBreakdown`, `parentUri` | Path, line range, snippet, score |

---

## 5. Embeddings & Indexing

| Aspect | Recall | OpenClaw |
|--------|--------|----------|
| **Default model** | `Xenova/all-MiniLM-L6-v2` (384-dim, local) | Auto-detected (OpenAI, Gemini, Voyage, etc.) |
| **Local-first** | Yes — transformers.js, no API keys | Supports local but prefers cloud providers |
| **Dual embeddings** | Yes — summary + aggregated per parent node | No — single embedding per chunk |
| **Salience weighting** | Yes — token count (0.4), entity density (0.3), decision markers (0.3) | No — uniform chunk weighting |
| **Chunking** | Heading-aware markdown, paragraph fallback | ~400 tokens with 80-token overlap, line tracking |
| **Embedding cache** | No explicit cache (Vectra manages index) | SQLite `embedding_cache` table with auto-pruning |
| **Batch config** | Not specified | 8000 tokens/batch, concurrency 4, retry with backoff |
| **Index format** | Vectra files on disk | SQLite tables |

### Salience Signals (Recall only)

Recall computes per-child salience weights during compaction, stored in parent frontmatter:

| Signal | Weight | Method |
|--------|--------|--------|
| Token count | 0.4 | Longer entries → more substantive |
| Entity density | 0.3 | NER + regex (CamelCase, kebab-case, error codes, ticket IDs, tool names) |
| Decision markers | 0.3 | Regex patterns ("decided to", "switched to", "chose X over Y", etc.) |

The aggregated parent embedding is a salience-weighted mean of child embeddings — not a uniform average. This means decision-heavy days contribute more to the parent's semantic vector.

---

## 6. Temporal Intelligence

### Recall: Temporal Affinity (Explicit, No Decay)

```
temporal_affinity = exp(-|memory_date - reference_date| / σ)     σ = 30 days
```

- Extracts date references from queries via regex (ISO dates, "last month", "Q1", named periods)
- Most specific reference wins
- **No recency bias** — a 2-year-old memory scores the same as yesterday's if the query doesn't mention time
- Temporal boost is multiplicative, applied during reranking

### OpenClaw: Temporal Decay (Implicit, Recency-Biased)

```
decay = exp(-age / half_life)     half_life = 30 days
```

- Applied to all search results by default
- Recent notes always rank higher, regardless of query content
- Configurable but on by default

### Design Philosophy

Recall's approach: *"Don't assume the user wants recent results unless they say so."* Temporal signal is query-driven — if you ask about "last week's auth decision," the affinity function boosts that timeframe. Otherwise, all memories compete equally.

OpenClaw's approach: *"Recent context is usually more relevant."* The decay function ensures the working set stays fresh, which works well for active conversations but can bury historically important decisions.

---

## 7. Context Loading & Integration

### Recall

- **Standalone CLI tool** — agents call `recall search` or use the library API
- **No automatic injection** — the host agent's prompt template decides when to search
- **Output modes:** Human-readable or JSON
- **Watch mode:** `recall watch` monitors filesystem, auto-syncs index, optional auto-compaction

### OpenClaw

- **Prompt injection:** Memory search instructions automatically added to every agent prompt
- **Two tools exposed:** `memory_search` (hybrid search) and `memory_get` (direct file access)
- **Memory flush:** Automatic silent turn before transcript compaction — writes important context to daily notes to prevent context loss
- **Active memory plugin:** Optional sub-agent that runs BEFORE the main reply to pre-inject relevant memories (blocking, 15s timeout)
- **Auto-loaded context:** `MEMORY.md` + today + yesterday's daily notes injected into every session

### Comparison

| Aspect | Recall | OpenClaw |
|--------|--------|----------|
| **Integration model** | Pull (agent calls when needed) | Push (auto-injected into prompts) |
| **Auto-loaded files** | None (agent decides) | MEMORY.md + today/yesterday daily notes |
| **Pre-reply enrichment** | None | Active memory sub-agent (optional) |
| **Context loss prevention** | Eidetic model (nothing deleted) | Memory flush before compaction |
| **Tool surface** | CLI commands + library API | `memory_search` + `memory_get` tools |

---

## 8. Compaction & Dreaming

Both systems now have compaction and dreaming, but they serve different roles and use different architectures.

### Recall: Compaction (Structural Summarization)

- **Deterministic triggers** — runs when temporal boundaries are crossed (week/month end)
- **Structural output** — produces markdown files at each hierarchy level
- **Pointer-based lineage** — every summary links back to its sources
- **Side-channel extraction** — typed memories (decisions, feedback, references) pulled out during compaction
- **Wisdom distillation** — periodic consolidation of principles into WISDOM.md (capped at ~20 entries)

### Recall: Dreaming (Analytical Synthesis)

- **Signal-driven** — examines memories based on search patterns, entity frequency, staleness, and wisdom drift
- **Three phases** — Gather (signals) → Analyze (LLM synthesis) → Write (persist)
- **Cross-temporal** — core design goal is connecting insights across time boundaries that compaction can't span
- **Output types** — insight files, typed memory promotions, contradiction flags, dream diary
- **Contradiction detection** — built-in comparison of WISDOM.md against observed behavior
- **Gap analysis** — identifies topics with consistently poor search results
- **Opt-in** — scheduled (cron, default 3 AM) or on-demand via `recall dream`

### OpenClaw: Dreaming (Signal-Based Promotion)

- **Biologically inspired** — three phases mimicking sleep stages (light, REM, deep)
- **Signal-based promotion** — candidates accumulate recall signals over time; promotion happens when signals cross thresholds
- **Scoring formula** — six weighted components (frequency, relevance, diversity, recency, consolidation, conceptual richness)
- **Promotion gates** — minimum score (0.75), minimum recall count (3), minimum unique queries (2), maximum age (90 days)
- **Human-readable output** — DREAMS.md diary + per-phase reports
- **Experimental** — opt-in, runs on cron schedule

### Comparison

| Aspect | Recall Compaction | Recall Dreaming | OpenClaw Dreaming |
|--------|------------------|-----------------|-------------------|
| **Purpose** | Structural summarization | Analytical synthesis | Signal-based promotion |
| **Metaphor** | Archival (summarize → file) | Investigative (gather → analyze → report) | Biological (sleep stages) |
| **Trigger** | Deterministic (temporal boundaries) | Scheduled + on-demand | Scheduled (cron) |
| **Input** | Raw logs for a period | Search signals, entity scans, wisdom drift | Recall traces, session transcripts |
| **Output** | Hierarchical summaries | Insights, promotions, contradictions | MEMORY.md promotions + diary |
| **Scope** | Within one time window | Across all time windows | Recent signal accumulation |
| **Cross-temporal** | No | Yes (core goal) | Limited |
| **Contradiction detection** | No | Yes (wisdom drift) | No |
| **Gap analysis** | No | Yes (null queries) | No |
| **Lineage** | Explicit pointers | Source references in insight frontmatter | Source path + line range |
| **Data model** | Append-only (new layers) | Append-only (new files) | Promotion (signals → long-term) |
| **Maturity** | Core, always-on | Opt-in | Experimental, opt-in |

---

## 9. Pluggability & Extensibility

### Recall: Four Swappable Interfaces

| Interface | Default | Planned |
|-----------|---------|---------|
| `FileStorage` | Local filesystem | SQLite |
| `EmbeddingsModel` | transformers.js (local) | OpenAI, Anthropic |
| `MemoryIndex` | Vectra | SQLite |
| `MemoryModel` | CliAgentModel (subprocess) | OpenAI, Anthropic API |

All configured at service construction time. No runtime switching.

### OpenClaw: Backend + Provider Matrix

**Backends:** Builtin (SQLite), QMD (sidecar), Honcho (cross-session)
**Embedding providers:** OpenAI, Gemini, Voyage, Mistral, Bedrock, Ollama, Local
**Fallback chain:** QMD → Builtin (automatic)

OpenClaw's provider auto-detection scans for API keys and picks the best available. Recall requires explicit configuration.

---

## 10. Storage & Performance

| Metric | Recall | OpenClaw |
|--------|--------|----------|
| **3-year single-agent projection** | ~5.7 MB (markdown + 384-dim vectors) | Varies by embedding model (higher-dim = larger) |
| **Index format** | Flat files (Vectra) | SQLite (single file per agent) |
| **Reindex speed** | Full rebuild via `recall index` | Debounced incremental (1.5s after change) |
| **Watch mode** | `recall watch` (filesystem watcher) | chokidar-based with 200ms stability window |
| **Concurrency** | Not specified | 4 parallel embedding operations |
| **Embedding cache** | None (Vectra index is the cache) | SQLite table with auto-pruning |

---

## 11. Design Trade-offs Summary

| Trade-off | Recall's Choice | OpenClaw's Choice |
|-----------|----------------|-------------------|
| **Data retention** | Eidetic (keep everything, compress on top) | Promotion (important things graduate) |
| **Recency bias** | None (temporal affinity is query-driven) | Default on (30-day decay half-life) |
| **Cloud dependency** | None (fully local by default) | Prefers cloud embeddings, local fallback |
| **Host coupling** | Standalone (any agent can use it) | Tightly coupled to OpenClaw lifecycle |
| **Search complexity** | Higher (two-phase, dual embeddings, pointer expansion) | Lower (hybrid merge, flat index) |
| **Compaction model** | Archival (structural hierarchy) + analytical dreaming | Biological (dreaming phases) |
| **Typed knowledge** | First-class (separate files with frontmatter schema) | Emergent (concept tags extracted during dreaming) |
| **Multimodal** | Text only | Images + audio (with compatible provider) |
| **Session memory** | Not built-in (agent manages its own logs) | Built-in transcript indexing + flush |
| **Default UX** | Explicit (agent must call search) | Automatic (prompt injection, auto-load, flush) |

---

## 12. When to Use Which

**Recall is a better fit when:**
- You need a standalone memory service decoupled from any specific agent host
- Long-term historical accuracy matters more than recency (eidetic model, no decay)
- You want explicit hierarchical summaries with traceable lineage
- You're running fully offline / air-gapped (local embeddings, CLI agent model)
- You want structured typed memories as first-class objects
- You need cross-temporal analysis (dreaming insights, contradiction detection, gap analysis)
- You want analytical dreaming that discovers patterns across time boundaries

**OpenClaw's memory-core is a better fit when:**
- You're already in the OpenClaw ecosystem and want tight lifecycle integration
- You need automatic context loading without explicit search calls
- Multimodal memory matters (images, audio)
- You want signal-based dreaming that promotes high-recall candidates to long-term memory
- You need multiple backend options (SQLite, QMD sidecar, Honcho cross-session)
- You want automatic embedding provider detection and cloud-first performance

---

## 13. Architectural Similarities

Despite different philosophies, both systems share core patterns:

1. **Hybrid search** — Both combine vector similarity with BM25 keyword matching
2. **File-based daily logs** — `memory/YYYY-MM-DD.md` is the atomic unit in both
3. **Evergreen wisdom** — Both maintain a top-level distilled file (WISDOM.md / MEMORY.md)
4. **Watch mode** — Both support filesystem monitoring for incremental reindexing
5. **Pluggable embeddings** — Both support multiple embedding providers behind an interface
6. **Frontmatter metadata** — Both use YAML frontmatter for memory file metadata
7. **CLI access** — Both expose memory operations through command-line interfaces
8. **Local-first option** — Both can run entirely offline (though OpenClaw prefers cloud)
9. **Dreaming systems** — Both now implement dreaming as an asynchronous analysis pass (Recall for cross-temporal synthesis, OpenClaw for signal-based promotion)
10. **Dream diary** — Both produce a human-readable `DREAMS.md` log of dreaming activity
11. **Search signal tracking** — Both track search patterns to inform dreaming decisions
