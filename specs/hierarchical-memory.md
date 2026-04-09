# Hierarchical Memory — Design Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-08  
**Version:** 0.4  
**Parent spec:** [memory-service.md](./memory-service.md) v0.3

---

## 1. Overview

This spec describes a **hierarchical memory** architecture for Recall that replaces the current lossy compaction pipeline with an eidetic (lossless) system. Raw memories are never deleted. Higher-level summaries (weekly, monthly) store **pointers** to their constituent raw memories plus a generated summary, enabling a two-phase recall pipeline that combines coarse parent-level retrieval with precise child-level reranking.

### Problem

The current system deletes daily logs after 30 days and weekly summaries after 52 weeks. Every compression step loses information. An agent cannot recall details from 3 months ago if they were dropped during compaction.

### Solution

1. **Eidetic storage** — Raw daily memories are the permanent source of truth (~5 MB for 3 years)
2. **Pointer-based parents** — Weekly/monthly nodes store pointers to children + a generated summary
3. **Dual embeddings per parent** — An aggregated child embedding (for coarse routing) and a summary embedding (for gap coverage)
4. **Two-phase recall** — Phase 1 retrieves parent candidates (high recall); Phase 2 expands pointers and reranks raw memories (high precision)
5. **Hybrid scoring** — Embedding similarity + BM25 keyword matching in both phases

### Design Principles

- **Pointers are the real union** — A single merged embedding is only an approximation; pointers preserve the full semantic spread
- **Parents are routing aids, not authoritative memory** — The raw memories are always the ground truth
- **Tune Phase 1 for recall, Phase 2 for precision** — It's OK if irrelevant parents get through; it's not OK if a relevant parent is missed
- **Summary embeddings separate from aggregated embeddings** — Including summary text in the aggregate adds redundant information and increases washout

---

## 2. Data Model

### 2.1 Memory Node Types

| Type | Description | Embedding Strategy | Persistence |
|---|---|---|---|
| **Raw** | Individual daily memory entries | One embedding per entry | Permanent (never deleted) |
| **Weekly** | Pointer node for 7 days of raw memories | Aggregated child embedding + summary embedding | Permanent |
| **Monthly** | Pointer node for 4–5 weekly nodes | Aggregated child embedding + summary embedding | Permanent |
| **Typed** | Durable knowledge (user, feedback, project, reference) | One embedding per entry | Permanent (unchanged from current spec) |
| **Wisdom** | Distilled principles | One embedding per entry | Permanent (unchanged from current spec) |

### 2.2 Raw Memory Record

Unchanged from current spec. Daily log entries stored as markdown files.

```
memory/2026-04-08.md
```

Raw memories are the base of the hierarchy. They are **never deleted** — this is the fundamental change from the current system.

### 2.3 Parent Node Record

Weekly and monthly nodes gain structured metadata. The file format adds a `pointers` field to the YAML frontmatter:

```yaml
---
type: weekly
period: 2026-W15
pointers:
  - memory/2026-04-07.md
  - memory/2026-04-08.md
  - memory/2026-04-09.md
  - memory/2026-04-10.md
  - memory/2026-04-11.md
salience:
  memory/2026-04-07.md: 0.12
  memory/2026-04-08.md: 0.28
  memory/2026-04-09.md: 0.22
  memory/2026-04-10.md: 0.15
  memory/2026-04-11.md: 0.23
---

## Week of 2026-04-07

### Key Outcomes
- ...

### Decisions
- ...
```

Monthly nodes point to weekly nodes:

```yaml
---
type: monthly
period: 2026-04
pointers:
  - memory/weekly/2026-W14.md
  - memory/weekly/2026-W15.md
  - memory/weekly/2026-W16.md
  - memory/weekly/2026-W17.md
---

## April 2026

### Themes
- ...
```

### 2.4 Embedding Storage Per Parent

Each parent node stores **two** entries in the vector index:

| Entry | URI convention | Source | Purpose |
|---|---|---|---|
| **Aggregated embedding** | `weekly/2026-W15#agg` | Weighted average of child embeddings, normalized | Coarse routing — gets you in the ballpark |
| **Summary embedding** | `weekly/2026-W15#summary` | Embedding of the generated summary text | Gap coverage — captures high-level narrative |

**Why two entries:**
- The aggregated embedding preserves the semantic spread of child content but can wash out when children are diverse
- The summary embedding captures what was *important* that period (editorially chosen by the LLM) but may miss niche details
- Together they cast a wider net in Phase 1 retrieval

**Why not combine them:**
- The summary is derived from the same content as the children — folding it into the aggregate adds redundant signal and accelerates washout

### 2.5 Aggregation Formula

Given child embeddings `e_1, e_2, ..., e_n`, each L2-normalized:

```
e_agg = normalize( Σ w_i * e_i )
```

Default weighting strategy: **uniform** (simple average, then normalize).

Configurable strategies:
- **Uniform** (default) — Equal weight per child
- **Recency-weighted** — More recent children get higher weight (exponential decay)
- **Salience-weighted** — Children weighted by estimated importance

#### Salience Signals

When `aggregationStrategy: "salience"` is selected, child weights are derived from a normalized combination of:

| Signal | Weight | Rationale |
|---|---|---|
| **Token count** | 0.4 | Longer entries generally contain more substantive content; a 500-token entry with decisions and context is more representative than a 50-token "quiet day" entry |
| **Entity density** | 0.3 | Entries mentioning more unique entities (people, projects, tools, error codes) are semantically richer and more likely to be recall targets |
| **Decision markers** | 0.3 | Entries containing explicit decisions, conclusions, or actions taken ("decided to", "switched to", "chose X over Y") carry disproportionate recall value |

Salience weight per child: `w_i = normalize(0.4 × token_ratio_i + 0.3 × entity_ratio_i + 0.3 × decision_ratio_i)`

Where each ratio is the child's signal value divided by the max signal value in the sibling set. This keeps weights relative within a parent, not absolute.

**Salience weighting ships in MVP.** Signal extraction runs at **compaction time** (amortized — compaction already reads every child to generate the summary, so extracting signals is marginal extra work on data already in hand). Scores are stored in the parent's frontmatter and reused at query time with zero additional cost.

#### Salience Signal Extraction — Library Approach

A hybrid strategy using dependencies already in the project:

| Signal | Method | Implementation |
|---|---|---|
| **Token count** | `gpt-tokenizer` (already a dependency) | Count tokens per child entry |
| **Entity density — people & orgs** | `@huggingface/transformers` (already a dependency) — `pipeline("token-classification", "Xenova/bert-base-NER")` | BERT NER for PER/ORG entities. Lazy-load pipeline alongside `LocalEmbeddings`, cache on instance, reuse across compaction run. Model: ~108 MB quantized ONNX, downloads once. |
| **Entity density — projects/tools** | Regex + curated vocabulary | Code-style names (`CamelCase`, `kebab-case-project`) via regex. Known tools (Docker, Redis, Vectra, etc.) via `Set` lookup — faster and more accurate than any model for a known vocabulary. |
| **Entity density — error codes** | Regex | Syntactically distinct patterns: `/\b[A-Z_]{3,}\b/`, `ENOENT`, `HTTP [45]\d\d` |
| **Decision markers** | Regex pattern list | Linguistic patterns: "decided to", "switched to", "chose X over Y", "going with", "concluded that" |

**Key design choice:** No new dependencies. `@huggingface/transformers` and `gpt-tokenizer` are both already in `packages/core/package.json`. The NER pipeline mirrors the existing `LocalEmbeddings` pattern — lazy-load, cache, reuse.

---

## 3. Hierarchy Dimensions

The pointer-based model supports two orthogonal hierarchies sharing the same raw memory base:

### 3.1 Temporal Hierarchy (MVP)

```
Raw (daily entries)
  └── Weekly (7 days of pointers + summary)
        └── Monthly (4-5 weeks of pointers + summary)
```

This is the primary hierarchy and the only one implemented in v1.

### 3.2 Organizational Hierarchy (Future)

```
Raw (per-user daily entries)
  └── Group (pointers across users + summary)
        └── Team (pointers across groups + summary)
```

Same mechanics: pointer nodes with aggregated + summary embeddings, two-phase recall. Group/team nodes point directly to **raw memories** (not to user-level weekly/monthly nodes) for maximum precision during expansion. Deferred to a future version when multi-user support is added (currently a non-goal per memory-service spec §1).

---

## 4. Two-Phase Recall Pipeline

### 4.1 Overview

```
Query
  │
  ├─── Phase 1a: Retrieve candidates (high recall)
  │      ├── Vector search over parent embeddings (agg + summary)
  │      ├── Vector search over raw memory embeddings (scoped)
  │      └── Optional: BM25 over parent summaries
  │
  ├─── Phase 1b: Expand pointers
  │      └── For each parent hit, load all pointed-to children + summary text
  │
  └─── Phase 2: Rerank (high precision)
         ├── Vector similarity (query vs. each raw memory embedding)
         ├── BM25 keyword match (query vs. raw memory text)
         └── Optional: parent score boost
         
  ──► Return top-K raw memories + relevant summaries
```

### 4.2 Phase 1a — Candidate Retrieval

**Goal:** High recall. Retrieve more candidates than needed; Phase 2 will filter.

**Inputs:**
- Query text (embedded at query time)
- Scope constraints: time range, memory types, metadata filters

**Operations (run in parallel where possible):**

1. **Parent vector search** — Query the index for parent embeddings (both `#agg` and `#summary` URIs). Retrieve top `K_parents` results (default: 10, deliberately oversampled to compensate for aggregation washout).

2. **Raw vector search** — Query the index for raw memory embeddings within the scoped time range. Retrieve top `K_raw` results (default: 20).

3. **BM25 parent search** (optional, enabled by default) — Keyword search over parent summary text using **Vectra's built-in BM25 support** (no additional library needed). Retrieve top `K_bm25` results (default: 10). Especially valuable for:
   - Proper nouns ("Dr. Smith", "Project Atlas")
   - IDs and error codes ("ticket #4821", "ECONNREFUSED")
   - Rare terms that embeddings blur

**Parent scoring (hybrid):**

```
s_parent(j) = α · cosine(q, p_j) + (1 - α) · BM25(q, summary_j)
```

Default `α = 0.7` (embedding-weighted). Configurable.

### 4.3 Phase 1b — Pointer Expansion

For each parent node retrieved in Phase 1a:

1. Read the `pointers` array from the node's frontmatter
2. Load each pointed-to child (recursively for monthly → weekly → raw)
3. Collect all unique raw memory entries (deduplicate by URI)
4. Include the parent's summary text as a separate candidate (summaries cover gaps between raw entries)

**Recursive expansion:** A monthly node points to weekly nodes, which point to raw memories. Expansion **always** follows the chain to the leaf level — there is no depth cap. At current scales (3 years ≈ 1,095 raw memories, even 10+ years ≈ 3,650) the expansion set is manageable. Phase 2 reranking handles the precision filtering.

Deduplication ensures a raw memory referenced by multiple parents appears only once.

### 4.4 Phase 2 — Reranking

**Goal:** High precision. Score every candidate from the expanded set against the query.

**Inputs:**
- Query text + query embedding
- Expanded candidate set (raw memories + parent summaries from Phase 1b, plus direct raw hits from Phase 1a)

**Scoring formula:**

```
s_final(i) = w_embed · cosine(q, e_i) + w_bm25 · BM25(q, text_i) + w_parent · s_parent(j)
```

Where:
- `w_embed = 0.5` — Semantic similarity (default)
- `w_bm25 = 0.3` — Keyword precision (default)
- `w_parent = 0.2` — Parent score inheritance, where `j` is the parent that contributed this child (default)
- All weights configurable, must sum to 1.0

**For direct raw hits** (not from parent expansion), `s_parent = 0`.

#### Temporal Affinity (Dated Weight)

The system must **not** apply recency decay. A memory from 10 years ago about a specific project is just as valuable as yesterday's memory when the query targets that project.

Instead, an optional **temporal affinity** signal boosts memories whose date is close to a time reference in the query:

1. **Time extraction** — At query time, extract temporal references from the query text using **regex pattern matching** (see §4.7 for patterns). If no temporal reference is detected, temporal affinity is neutral (weight = 1.0 for all candidates). The caller can also pass `temporalReference` directly via `QueryOptions` to override auto-detection.

2. **Affinity scoring** — When a temporal reference is detected, compute a date-proximity score:

```
temporal_affinity(i) = exp(-|date_i - date_ref| / σ)
```

Where `σ` (default: 30 days) controls the falloff width. Memories within the reference window score ~1.0; distant memories score lower but never zero.

3. **Integration into Phase 2** — Temporal affinity acts as a multiplier on the final score, not an additive component:

```
s_final(i) = (w_embed · cosine + w_bm25 · BM25 + w_parent · s_parent) × temporal_affinity(i)
```

This ensures that without a temporal reference, scoring is purely semantic + keyword. With a temporal reference, date-relevant memories get a boost without excluding anything.

**Output:** Top `K_final` results (default: 10), each annotated with:
- The raw memory text
- Score breakdown (embed, bm25, parent)
- Source URI
- Parent URI (if arrived via expansion)
- Whether this is a summary or raw entry

### 4.5 Summary Inclusion

Parent summaries are included in the final results alongside raw memories. They serve a different purpose:

- **Raw memories** — Precise, detailed, authoritative
- **Summaries** — High-level narrative, covers gaps, provides temporal context

The retrieval response distinguishes between raw results and summary results so the caller can present them appropriately (e.g., summaries as context headers, raw memories as evidence).

### 4.6 Fallback: Direct Raw Search

When parent-only routing might miss niche memories (the "passport renewal buried in a work-heavy week" problem), Phase 1a already includes direct raw memory search. This acts as a safety net — even if no parent routes to a specific raw memory, the direct search can still find it.

The parallel structure of Phase 1a (parents + raw + BM25) ensures that recall failures in one channel are compensated by others.

### 4.7 Temporal Reference Extraction

Temporal references are extracted from query text using **regex-first** pattern matching. This is cheap, deterministic, and covers the majority of temporal queries. The caller can always override via `QueryOptions.temporalReference` when the agent has richer context.

**Supported patterns (MVP):**

| Pattern | Example | Resolved `date_ref` |
|---|---|---|
| Explicit year | "in 2019", "back in 2023" | `YYYY-07-01` (midpoint of year) |
| Year-month | "March 2024", "2024-03" | `YYYY-MM-15` (midpoint of month) |
| Full date | "April 8, 2026", "2026-04-08" | Exact date |
| Relative week | "last week", "two weeks ago" | Resolved against current date |
| Relative month | "last month", "3 months ago" | Resolved against current date |
| Relative year | "last year" | Resolved against current date |
| Quarter | "Q3 2024", "Q1 last year" | Midpoint of quarter |
| Named period | "yesterday", "this week", "this month" | Resolved against current date |

**Not handled (by design):**
- Implicit temporal references like "during the auth rewrite" or "back when we used AWS" — these require LLM-assisted extraction or metadata lookups
- If recall quality suffers from missing implicit references in practice, LLM-assisted extraction can be added as an enhancement without changing the scoring pipeline

**Resolution rules:**
- When a pattern resolves to a range (e.g., "in 2019" → Jan–Dec 2019), use the midpoint as `date_ref`
- When multiple temporal references appear in a query, use the **most specific** one (full date > month > quarter > year)
- When no pattern matches and no `temporalReference` is provided, temporal affinity is neutral (1.0)

---

## 5. Changes to Compaction Pipeline

### 5.1 What Changes

| Aspect | Current (v0.3) | Hierarchical (this spec) |
|---|---|---|
| Daily retention | Deleted after 30 days | **Never deleted** |
| Weekly retention | Deleted after 52 weeks | **Never deleted** |
| Weekly output | Summary text only | Summary text + `pointers` frontmatter + 2 index entries |
| Monthly output | Summary text only | Summary text + `pointers` frontmatter + 2 index entries |
| Index entries per parent | 1 (text embedding) | 2 (aggregated + summary) |
| Compaction trigger | Unchanged | Unchanged |
| Typed memory extraction | Unchanged | Unchanged |
| Wisdom distillation | Unchanged | Unchanged |

### 5.2 New Compaction Steps

**During daily → weekly compaction:**

1. Generate weekly summary (unchanged prompt)
2. For each source daily file, extract salience signals:
   a. Token count via `gpt-tokenizer`
   b. Entity density via NER pipeline (`Xenova/bert-base-NER` for PER/ORG) + regex (project names, tools, error codes) + vocabulary lookup
   c. Decision markers via regex pattern matching
3. Compute salience weights: `w_i = normalize(0.4 × token_ratio + 0.3 × entity_ratio + 0.3 × decision_ratio)`
4. Write `memory/weekly/YYYY-Wnn.md` with `pointers` and `salience` in frontmatter listing all source daily files and their weights
5. Embed the summary text → store as `weekly/YYYY-Wnn#summary`
6. Retrieve embeddings for all pointed-to daily entries from the index
7. Compute aggregated embedding: `normalize(Σ w_i × e_i)` using salience weights
8. Store as `weekly/YYYY-Wnn#agg`
9. **Do NOT delete daily logs** (remove the retention/deletion step)

**During weekly → monthly compaction:**

1. Generate monthly summary (unchanged prompt)
2. For each source weekly file, extract salience signals (same pipeline as daily → weekly, applied to weekly summary text)
3. Compute salience weights for weekly children
4. Write `memory/monthly/YYYY-MM.md` with `pointers` and `salience` in frontmatter listing all source weekly files and their weights
5. Embed the summary text → store as `monthly/YYYY-MM#summary`
6. Retrieve aggregated embeddings for all pointed-to weekly nodes
7. Compute aggregated embedding: `normalize(Σ w_i × weekly_agg_i)` using salience weights
8. Store as `monthly/YYYY-MM#agg`
9. **Do NOT delete weekly summaries**

### 5.3 Backward Compatibility

Existing weekly/monthly files without `pointers` frontmatter continue to work as before — they are treated as summary-only nodes with no children to expand. The search pipeline gracefully handles nodes with and without pointers.

---

## 6. Changes to Interfaces

### 6.1 MemoryIndex — New Methods

```typescript
export interface MemoryIndex {
  // ... existing methods unchanged ...

  /**
   * Retrieve the raw embedding vector for a document URI.
   * Returns null if the document is not in the index.
   * Required for computing aggregated embeddings.
   */
  getEmbedding(uri: string): Promise<number[] | null>;

  /**
   * Upsert a pre-computed embedding vector (no text chunking).
   * Used for storing aggregated embeddings.
   */
  upsertEmbedding(uri: string, embedding: number[], metadata?: DocumentMetadata): Promise<void>;
}
```

### 6.2 SearchResult — Extended

```typescript
export enum ResultType {
  /** Raw daily memory entry — authoritative detail */
  RAW = "raw",
  /** Generated summary from a parent node — gap coverage, not authoritative */
  SUMMARY = "summary",
}

export interface SearchResult {
  uri: string;
  text: string;
  score: number;
  metadata: DocumentMetadata;
  partial?: boolean;
  /** Distinguishes raw memory entries from generated parent summaries */
  resultType: ResultType;
  /** URI of the parent node that contributed this result, if via expansion */
  parentUri?: string;
  /** Breakdown of scoring components */
  scoreBreakdown?: {
    embedding: number;
    bm25: number;
    parent: number;
  };
}
```

### 6.3 QueryOptions — Extended

```typescript
export interface QueryOptions {
  maxResults?: number;        // default: 10 (final results after reranking)
  maxChunks?: number;         // default: 3
  maxTokens?: number;         // default: 500
  filter?: MetadataFilter;

  /** Phase 1 oversampling factor for parent retrieval (default: 10) */
  parentCandidates?: number;
  /** Phase 1 direct raw memory candidates (default: 20) */
  rawCandidates?: number;
  /** Enable BM25 hybrid scoring (default: true) */
  enableBM25?: boolean;
  /** Phase 2 scoring weights (must sum to 1.0) */
  scoringWeights?: ScoringWeights;
  /** Include parent summaries in results (default: true) */
  includeSummaries?: boolean;
  /** Override temporal reference date for affinity scoring (auto-detected from query if omitted) */
  temporalReference?: Date;
}

export interface ScoringWeights {
  embedding?: number;   // default: 0.5
  bm25?: number;        // default: 0.3
  parent?: number;      // default: 0.2
}
```

### 6.4 CompactionConfig — Changes

```typescript
export interface CompactionConfig {
  // ... existing fields ...

  /** REMOVED: dailyRetentionDays — raw memories are never deleted */
  // dailyRetentionDays?: number;

  /** REMOVED: weeklyRetentionWeeks — weekly nodes are never deleted */
  // weeklyRetentionWeeks?: number;

  /** Aggregation weighting strategy for parent embeddings (default: "salience") */
  aggregationStrategy?: "uniform" | "recency" | "salience";
}
```

### 6.5 DocumentMetadata — Extended

```typescript
export interface DocumentMetadata {
  contentType?: string;    // "daily" | "weekly" | "monthly" | "wisdom" | "typed_memory"
  teammate?: string;
  period?: string;
  /** For parent nodes: "agg" or "summary" */
  embeddingType?: "agg" | "summary";
  /** For parent nodes: list of child URIs */
  pointers?: string[];
  [key: string]: MetadataTypes;
}
```

---

## 7. Configuration

New configuration fields added to `MemoryServiceConfig`:

```typescript
export interface HierarchicalMemoryConfig {
  /** Enable hierarchical memory (default: true once this feature ships) */
  enabled?: boolean;

  /** Phase 1 hybrid scoring weight for embeddings vs BM25 (default: 0.7) */
  parentAlpha?: number;

  /** Phase 2 scoring weights */
  scoringWeights?: ScoringWeights;

  /** Parent oversampling factor (default: 10) */
  parentCandidates?: number;

  /** Direct raw memory candidates in Phase 1 (default: 20) */
  rawCandidates?: number;

  /** Embedding aggregation strategy (default: "salience") */
  aggregationStrategy?: "uniform" | "recency" | "salience";

  /** Enable BM25 in Phase 1 parent retrieval (default: true) */
  bm25Parents?: boolean;

  /** Enable BM25 in Phase 2 reranking (default: true) */
  bm25Rerank?: boolean;

  /** Temporal affinity falloff width in days (default: 30). 
   *  Controls how quickly the date-proximity boost decays. */
  temporalSigma?: number;

  /** Enable temporal affinity scoring (default: true).
   *  When enabled, queries with detected time references boost date-relevant memories. */
  temporalAffinity?: boolean;
}
```

---

## 8. Storage Budget Analysis

### 8.1 Raw Memory Text

Assuming ~1 KB/day average for daily logs:
- 1 year: ~365 KB
- 3 years: ~1.1 MB
- 5 years: ~1.8 MB

### 8.2 Embeddings (using MiniLM-L6-v2, 384-dim, float32)

Per embedding: `384 × 4 = 1,536 bytes ≈ 1.5 KB`

| Component | Count (3 years) | Embeddings | Storage |
|---|---|---|---|
| Raw daily memories | ~1,095 | 1,095 | ~1.6 MB |
| Weekly nodes (agg + summary) | ~156 × 2 | 312 | ~0.5 MB |
| Monthly nodes (agg + summary) | ~36 × 2 | 72 | ~0.1 MB |
| Typed memories | ~50–200 | 200 | ~0.3 MB |
| **Total** | | ~1,679 | **~2.5 MB** |

### 8.3 Total Budget (3 years)

| Component | Size |
|---|---|
| Raw text (daily logs) | ~1.1 MB |
| Summary text (weekly + monthly) | ~0.5 MB |
| Embeddings + index overhead (1.5×) | ~3.8 MB |
| Typed memories + wisdom | ~0.3 MB |
| **Total** | **~5.7 MB** |

This is well within acceptable limits for a local-first system. No aggressive compression or pruning needed.

---

## 9. Migration Path

### 9.1 From Current System (v0.3)

1. **Stop deleting dailies** — Remove retention/deletion logic from compaction
2. **Backfill pointers** — For existing weekly/monthly files without `pointers` frontmatter, infer pointers from the date range in the `period` field and write them into the frontmatter
3. **Generate aggregated embeddings** — For each existing parent node, retrieve child embeddings and compute the aggregate
4. **Re-index** — Full rebuild of the vector index to include the new `#agg` and `#summary` entries

### 9.2 Migration CLI Command

```bash
recall migrate --to hierarchical [--dry-run]
```

Reports:
- Number of parent nodes to upgrade
- Daily logs that would have been deleted but are now retained
- Missing daily logs (already deleted under old retention policy — these are permanently lost, but pointers to them are marked as broken)

---

## 10. Resolved Questions (v0.2)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | BM25 implementation | Use **Vectra's built-in BM25** — no additional library | Vectra already supports BM25; adding a separate library would be redundant |
| 2 | Salience weighting signals | **Token count (0.4), entity density (0.3), decision markers (0.3)** — ships in MVP | Hybrid extraction: `@huggingface/transformers` NER + regex + vocabulary lookup. No new dependencies. |
| 3 | Max expansion depth | **Always expand to leaf** — no depth cap | Even 10+ years of memories (~3,650 entries) is manageable. Temporal affinity scoring handles relevance filtering without artificial caps |
| 4 | Summary result type | **Enum** (`ResultType.RAW` / `ResultType.SUMMARY`) | Cleaner API than boolean; extensible if new result types emerge |
| 5 | Cross-hierarchy pointers | Group/team nodes point to **raw memories** directly | Maximum precision during expansion; wider expansion sets are handled by Phase 2 reranking |

## 10.1 Resolved Questions (v0.3)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 6 | Temporal reference extraction | **Regex-first** — deterministic pattern matching for explicit dates, periods, and relative references (§4.7) | Covers 80%+ of temporal queries cheaply. Caller can override via `QueryOptions.temporalReference`. LLM-assisted extraction deferred unless recall quality suffers in practice. |

## 10.2 Resolved Questions (v0.4)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 7 | Salience signal extraction timing | **Compaction-time** (amortized) | Compaction already reads every child to generate the summary — extracting signals is marginal extra work. Query-time extraction would add latency to every recall. Scores stored in frontmatter, reused with zero query-time cost. If signals change, `recall migrate` recomputes all parents (same pattern as other migrations). |
| 8 | Salience promotion to MVP | **Ships in MVP** (not deferred to v2) | `@huggingface/transformers` and `gpt-tokenizer` are already dependencies. NER pipeline mirrors existing `LocalEmbeddings` pattern. No new libraries needed. |

## 10.3 Open Questions

_None — all questions resolved._

---

## 11. Acceptance Criteria

### Storage

- [ ] Raw daily memories are never deleted by compaction
- [ ] Weekly summaries are never deleted by compaction
- [ ] Weekly nodes include `pointers` array in frontmatter pointing to source daily files
- [ ] Monthly nodes include `pointers` array in frontmatter pointing to source weekly files
- [ ] Each parent node produces two index entries: `#agg` (aggregated embedding) and `#summary` (summary embedding)
- [ ] Aggregated embedding is computed as normalized mean of child embeddings

### Salience Extraction

- [ ] Token count is computed per child entry using `gpt-tokenizer`
- [ ] Entity density is computed using NER pipeline (`Xenova/bert-base-NER`) for PER/ORG + regex for project names, tools, and error codes + vocabulary lookup
- [ ] Decision markers are detected via regex pattern list ("decided to", "switched to", "chose X over Y", etc.)
- [ ] NER pipeline is lazy-loaded and cached on the instance (mirrors `LocalEmbeddings` pattern)
- [ ] Salience weights are stored in parent frontmatter (`salience` field) alongside `pointers`
- [ ] Salience weights are computed at compaction time, not query time
- [ ] Aggregated embedding uses salience weights by default (not uniform)

### Retrieval — Phase 1

- [ ] Parent vector search retrieves both `#agg` and `#summary` entries
- [ ] Direct raw memory search runs in parallel with parent search
- [ ] BM25 search over parent summaries runs in parallel (when enabled)
- [ ] Parent candidates are oversampled (configurable, default 10)
- [ ] Hybrid parent scoring combines cosine similarity and BM25 with configurable alpha

### Retrieval — Phase 2

- [ ] All parent pointers are recursively expanded to raw memories
- [ ] Expanded raw memories are deduplicated by URI
- [ ] Parent summary text is included as a candidate alongside raw memories
- [ ] Final scoring combines embedding similarity, BM25, and parent score with configurable weights
- [ ] Results distinguish between raw memories and summary entries (`resultType` enum: `RAW` / `SUMMARY`)
- [ ] Score breakdown is available per result (`scoreBreakdown`)

### Retrieval — Temporal Affinity

- [ ] No recency decay is applied by default — old memories are not penalized
- [ ] When a query contains a temporal reference, date-proximate memories receive a multiplicative boost
- [ ] Without a temporal reference, temporal affinity is neutral (1.0 for all candidates)
- [ ] Temporal falloff width (σ) is configurable (default: 30 days)
- [ ] Temporal references are extracted from query text via regex pattern matching (§4.7 patterns)
- [ ] Explicit year, year-month, full date, relative, and quarter patterns are supported
- [ ] When multiple temporal references appear, the most specific one is used
- [ ] Caller-provided `temporalReference` in `QueryOptions` overrides auto-detection

### Configuration

- [ ] All scoring weights are configurable via `HierarchicalMemoryConfig`
- [ ] BM25 can be independently enabled/disabled for Phase 1 and Phase 2
- [ ] Aggregation strategy is configurable (uniform default)
- [ ] Parent/raw candidate counts are configurable
- [ ] Temporal affinity can be enabled/disabled independently

### Migration

- [ ] `recall migrate --to hierarchical` upgrades existing parent nodes with pointer frontmatter
- [ ] Migration generates aggregated embeddings for existing parents
- [ ] `--dry-run` reports what would change without modifying files
- [ ] Existing files without pointers continue to work (graceful degradation)

### Backward Compatibility

- [ ] Parent nodes without `pointers` frontmatter are treated as summary-only (no expansion)
- [ ] Existing `SearchResult` consumers are not broken by new optional fields
- [ ] Current compaction prompts continue to work (no prompt changes required)

---

## 12. Implementation Sequencing

### Phase A — Eidetic Storage (no retrieval changes)

1. Remove daily/weekly retention and deletion from `Compactor`
2. Add `pointers` frontmatter generation to weekly and monthly compaction
3. Update `MemoryFiles` to parse `pointers` from frontmatter

**Can ship independently.** Immediate benefit: no more data loss.

### Phase B — Dual Embeddings + Salience

1. Add `getEmbedding()` and `upsertEmbedding()` to `MemoryIndex` interface
2. Implement in `VectraIndex`
3. Implement salience signal extraction:
   a. Token count via `gpt-tokenizer`
   b. NER pipeline (`Xenova/bert-base-NER`) — lazy-load, cache, reuse (mirror `LocalEmbeddings` pattern)
   c. Regex extractors: project names, tools, error codes, decision markers
   d. Vocabulary `Set` for known tools
4. Integrate salience extraction into compaction: compute per-child weights, store in frontmatter
5. After compaction, compute salience-weighted aggregated + summary embeddings
6. Update sync to handle `#agg` and `#summary` URI conventions

### Phase C — Two-Phase Recall

1. Implement pointer expansion (recursive, with dedup)
2. Implement Phase 1a parallel retrieval (parent vector + raw vector + BM25)
3. Implement Phase 2 reranking with configurable weights
4. Extend `SearchResult` with `isSummary`, `parentUri`, `scoreBreakdown`

### Phase D — BM25 Integration

1. Wire Vectra's built-in BM25 support into Phase 1 parent retrieval and Phase 2 reranking
2. Ensure BM25 index covers raw memory text + parent summaries
3. Validate hybrid scoring weights with representative queries

### Phase E — Migration

1. Implement `recall migrate --to hierarchical`
2. Pointer backfill logic
3. Aggregated embedding generation for existing nodes

**Phases A and B can run in parallel. C depends on B. D can run in parallel with C. E can run anytime after A.**

---

## 13. Changelog

| Version | Date | Changes |
|---|---|---|
| 0.4 | 2026-04-08 | Promoted salience weighting from v2 to MVP. Default aggregation strategy changed from "uniform" to "salience". Documented hybrid extraction approach: `@huggingface/transformers` NER + regex + vocabulary lookup (zero new dependencies). Resolved salience extraction timing: compaction-time (amortized). Added `salience` field to parent frontmatter. Added salience acceptance criteria. Updated Phase B to include salience extraction. All open questions resolved. |
| 0.3 | 2026-04-08 | Resolved temporal extraction: regex-first approach (§4.7) with full pattern table. Added acceptance criteria for temporal extraction. One open question remains (salience extraction timing). |
| 0.2 | 2026-04-08 | Resolved all 5 open questions. BM25 via Vectra built-in. Salience weighting defined (token count + entity density + decision markers, deferred to v2). Always expand to leaf — no depth cap. ResultType enum replaces isSummary boolean. Cross-hierarchy points to raw memories. Added temporal affinity scoring (no recency decay; date-proximity boost when query has time reference). Two new open questions for v0.3. |
| 0.1 | 2026-04-08 | Initial draft |
