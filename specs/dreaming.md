# Dreaming System — Design Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-11  
**Version:** 0.1  
**Parent spec:** [memory-service.md](./memory-service.md) v0.3, [hierarchical-memory.md](./hierarchical-memory.md) v0.4

---

## 1. Overview

Dreaming is an **asynchronous knowledge synthesis** system that runs alongside Recall's existing compaction pipeline. While compaction is structural (summarize daily→weekly→monthly on temporal boundaries), dreaming is **analytical** — it discovers patterns, surfaces forgotten connections, extracts insights, and promotes durable knowledge that compaction's time-bounded windows would miss.

### Problem

Compaction compresses memories within fixed temporal windows (week, month). It cannot:

1. **Discover cross-temporal patterns** — A decision made in January that contradicts a decision made in August lives in two separate monthly summaries with no link between them
2. **Surface forgotten context** — Important but infrequently recalled memories decay in practical relevance even though Recall doesn't apply recency bias to search scores
3. **Synthesize emerging themes** — Repeated low-signal patterns (e.g., "auth issues mentioned 12 times across 6 months") don't surface until someone asks the right question
4. **Detect contradictions** — The agent's stated principles in WISDOM.md may conflict with actual behavior recorded in daily logs
5. **Extract latent typed memories** — Decisions, preferences, and references embedded in daily prose that compaction's single-pass extraction missed

### Solution

A dreaming pipeline that runs on a configurable schedule (or on-demand) and produces three types of output:

1. **Insights** — Cross-temporal discoveries written to `memory/dreams/insights/`
2. **Promotions** — Typed memories extracted from under-surfaced content and written to `memory/`
3. **Dream diary** — Human-readable report of what the dreaming session discovered, written to `DREAMS.md`

### Design Principles

- **Complementary, not competing** — Dreaming does not replace compaction. Compaction handles structural summarization on temporal boundaries. Dreaming handles analytical synthesis across those boundaries.
- **Eidetic-compatible** — Dreaming never deletes or modifies raw memories. It only creates new files (insights, promotions, diary entries).
- **Signal-driven, not schedule-driven** — While dreaming runs on a schedule, what it *examines* is guided by recall signals (search hits, typed memory gaps, temporal clusters) rather than processing everything sequentially.
- **LLM-powered with deterministic scaffolding** — Signal collection and candidate selection are deterministic. Synthesis and insight generation use the `MemoryModel` abstraction.
- **Observable** — Every dreaming session produces a diary entry explaining what was examined and what was found. No silent side effects.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   DreamEngine                           │
├──────────┬──────────────┬──────────────┬────────────────┤
│ Signal   │   Candidate  │  Synthesis   │    Output      │
│ Collector│   Selector   │  Pipeline    │    Writer      │
├──────────┴──────────────┴──────────────┴────────────────┤
│           Existing Recall Abstractions                  │
│  MemoryFiles · SearchService · MemoryIndex · MemoryModel│
└─────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|-----------|---------------|
| **Signal Collector** | Gathers recall signals from search logs, identifies temporal clusters, finds under-surfaced memories |
| **Candidate Selector** | Scores and prioritizes which memories/themes to examine this session |
| **Synthesis Pipeline** | Uses the LLM to analyze candidates and produce insights, promotions, and contradictions |
| **Output Writer** | Writes insights, promotions, and diary entries to the filesystem |

---

## 3. Dreaming Phases

Dreaming runs in three sequential phases per session. Each phase builds on the prior phase's output.

### Phase 1 — Gather (Signal Collection)

**Goal:** Identify what's worth dreaming about this session.

**Signal sources:**

| Signal | Source | What it reveals |
|--------|--------|----------------|
| **Search log** | `memory/.dreams/search-log.jsonl` | Which memories get recalled, how often, by what queries |
| **Recency gap** | Temporal scan of daily logs | Periods with no compaction coverage or low search activity |
| **Entity frequency** | NER + regex scan across recent memories | Recurring entities that may warrant typed memories |
| **Typed memory staleness** | Frontmatter `date` vs current date | Project/reference memories that may be outdated |
| **Wisdom drift** | WISDOM.md vs recent behavior | Principles that may no longer reflect actual practice |

**Search log format** (`memory/.dreams/search-log.jsonl`):

Each search operation appends a line:

```json
{
  "ts": "2026-04-11T14:30:00Z",
  "query": "auth middleware changes",
  "results": ["memory/2026-04-08.md", "memory/weekly/2026-W14.md"],
  "scores": [0.82, 0.71],
  "topK": 5,
  "returned": 2
}
```

The search log is append-only and rotated monthly (old logs archived, not deleted).

**Phase 1 output:** A scored list of **dream candidates** — memory URIs, entity clusters, temporal ranges, and typed memory gaps that are worth examining.

### Phase 2 — Analyze (Synthesis)

**Goal:** Use the LLM to examine candidates and produce insights.

For each candidate cluster (batched by theme or time range):

1. **Load context** — Retrieve the candidate memories + surrounding context (adjacent days, parent summaries)
2. **Prompt the model** with one of several analysis templates:
   - **Cross-reference analysis** — "Here are N memories mentioning [entity]. What patterns, contradictions, or evolution do you see?"
   - **Gap analysis** — "Here is a period with sparse coverage. Based on surrounding context, what might be missing or worth noting?"
   - **Contradiction detection** — "Here is the current WISDOM.md and here are recent memories. Do any entries conflict with observed behavior?"
   - **Typed memory extraction** — "Here are daily entries that were not fully mined during compaction. Extract any decisions, feedback, project context, or references."
   - **Theme synthesis** — "Here are memories spanning [time range] that share [theme]. Synthesize the trajectory — what started, what changed, what resolved?"
3. **Parse output** — Extract structured results: insights, typed memory candidates, contradiction flags, diary entries

### Phase 3 — Write (Output)

**Goal:** Persist dreaming results without modifying existing files.

| Output | Location | Format |
|--------|----------|--------|
| **Insights** | `memory/dreams/insights/YYYY-MM-DD-<slug>.md` | Markdown with frontmatter (`type: insight`, `sources`, `theme`) |
| **Promoted typed memories** | `memory/<type>_<topic>.md` | Standard typed memory format (only if not duplicate) |
| **Contradiction flags** | `memory/dreams/contradictions/YYYY-MM-DD.md` | Markdown listing contradictions with source references |
| **Dream diary** | `DREAMS.md` | Append-only log of what was examined and found |

---

## 4. Signal Collection Detail

### 4.1 Search Log Signals

The search log tracks every query + result set. From this, the dreaming engine computes:

| Metric | Calculation | Purpose |
|--------|------------|---------|
| **Hit frequency** | Count of times a URI appears in results | Identifies heavily-recalled memories (potential typed memory candidates) |
| **Query diversity** | Distinct query embeddings that retrieved a URI | Memories recalled by diverse queries are cross-cutting |
| **Score trend** | Average score over time per URI | Declining scores may indicate context drift |
| **Null queries** | Queries with 0 or low-score results | Topics the memory system can't answer well — gap signal |
| **Temporal clusters** | Group queries by their temporal references | Reveals which time periods are being actively investigated |

### 4.2 Entity Frequency Signals

Reuses the salience extraction pipeline from the hierarchical memory spec (NER + regex + vocabulary):

1. Scan daily logs from the last N days (configurable, default: 30)
2. Extract entities: people, projects, tools, error codes
3. Count frequency per entity across days
4. Entities appearing in 3+ days without a corresponding typed memory are promotion candidates

### 4.3 Staleness Signals

For each typed memory with `type: project` or `type: reference`:

1. Parse the memory's content for temporal markers
2. Compare against current date
3. Flag memories older than a configurable threshold (default: 90 days) as review candidates
4. Cross-reference against recent daily logs — if the topic appears in recent logs with different information, flag as potentially stale

### 4.4 Wisdom Drift Signals

Compare WISDOM.md entries against recent behavior:

1. For each wisdom entry, generate a query embedding
2. Search recent memories (last 30–90 days) for behavioral evidence
3. Flag entries where:
   - No supporting evidence found (wisdom may be outdated)
   - Contradictory evidence found (behavior diverged from stated principle)
   - Strong supporting evidence found with additional nuance (wisdom may need refinement)

---

## 5. Candidate Scoring

Dream candidates are scored to prioritize what gets analyzed this session (LLM calls are expensive — budget them).

```
dream_score = w_freq × frequency_signal
            + w_diversity × query_diversity_signal
            + w_gap × gap_signal
            + w_staleness × staleness_signal
            + w_entity × entity_frequency_signal
```

Default weights:

| Signal | Weight | Rationale |
|--------|--------|-----------|
| **Hit frequency** | 0.25 | Heavily recalled memories deserve deeper analysis |
| **Query diversity** | 0.25 | Cross-cutting memories likely contain typed memory material |
| **Gap signal** | 0.20 | Unanswered queries reveal knowledge holes worth filling |
| **Staleness** | 0.15 | Outdated typed memories cause bad recommendations |
| **Entity frequency** | 0.15 | Recurring entities without typed memories are low-hanging fruit |

**Budget:** Each dreaming session processes at most `maxCandidates` (default: 20) clusters, prioritized by score. Unprocessed candidates carry over to the next session.

---

## 6. Output Formats

### 6.1 Insight File

```yaml
---
type: insight
date: 2026-04-11
theme: auth-middleware-evolution
sources:
  - memory/2026-01-15.md
  - memory/2026-03-22.md
  - memory/2026-04-08.md
  - memory/weekly/2026-W14.md
confidence: high
---

## Auth Middleware Evolution

The auth middleware has gone through three distinct phases:

1. **January:** Initial implementation using session tokens stored in cookies...
2. **March:** Legal flagged cookie-based storage for compliance...
3. **April:** Rewrite completed using JWT with httpOnly...

### Key Insight
The migration was compliance-driven, not performance-driven. Future auth decisions
should prioritize legal review before implementation begins.
```

Insight files are indexed in Vectra like any other memory file, making them searchable. Their `type: insight` metadata allows filtering them in or out of search results.

### 6.2 Contradiction File

```yaml
---
type: contradiction
date: 2026-04-11
---

## Contradictions Detected

### WISDOM.md: "Always use mocks for external API tests"
**Evidence against:** memory/2026-04-02.md records switching to integration tests
after mock-based tests failed to catch a migration bug. The team decided mocks are
insufficient for database-touching tests.

**Recommendation:** Update WISDOM.md to distinguish between external API mocks
(still valid) and database mocks (deprecated per April decision).
```

### 6.3 Dream Diary (DREAMS.md)

```markdown
# Dream Diary

## 2026-04-11

**Session duration:** ~45s  
**Candidates examined:** 12 of 20  
**LLM calls:** 8

### Insights Generated
- **auth-middleware-evolution** — Traced 3-phase auth migration across Jan–Apr.
  Compliance-driven, not performance. (3 source memories)
- **deployment-cadence-shift** — Weekly→daily deploys started March 15 after
  CI pipeline improvements. (5 source memories)

### Promotions
- `feedback_database-mocks.md` — "Don't mock the database in integration tests"
  (extracted from 2026-04-02 daily log, missed during weekly compaction)

### Contradictions
- WISDOM.md entry "Always use mocks for external API tests" conflicts with
  April database mock decision. Review recommended.

### Gaps Identified
- 3 queries about "rate limiting" returned no results. No memories cover this topic.
- February 10–17 has no daily logs (possible gap or quiet period).

---
```

---

## 7. File Layout

```
<memory-root>/
├── WISDOM.md
├── DREAMS.md                              # Dream diary (append-only)
├── memory/
│   ├── 2026-04-01.md                      # Daily logs (unchanged)
│   ├── type_topic.md                      # Typed memories (unchanged)
│   ├── weekly/                            # Weekly summaries (unchanged)
│   ├── monthly/                           # Monthly summaries (unchanged)
│   └── dreams/                            # Dreaming output
│       ├── insights/
│       │   ├── 2026-04-11-auth-evolution.md
│       │   └── 2026-04-11-deploy-cadence.md
│       └── contradictions/
│           └── 2026-04-11.md
└── .dreams/                               # Dreaming machine state (gitignored)
    ├── search-log.jsonl                   # Append-only search signal log
    ├── search-log-2026-03.jsonl.gz        # Rotated monthly archives
    ├── candidates.json                    # Carry-over candidates from last session
    └── dream-state.json                   # Last run metadata
```

### Gitignore Additions

`.dreams/` is machine state — transient and regenerable. Add to `.gitignore`:

```
.dreams/
```

Dreaming output (`memory/dreams/`) is committed — it contains durable knowledge.

---

## 8. Integration with Existing Systems

### 8.1 Search

- **Insight files** are indexed in Vectra with `contentType: "insight"`. They appear in search results alongside regular memories.
- **Contradiction files** are indexed with `contentType: "contradiction"`. They can be filtered via `QueryOptions.filter`.
- The `SearchService` requires no changes — insights and contradictions are just markdown files with frontmatter, same as typed memories.

### 8.2 Compaction

- Dreaming does not interfere with compaction. Both can run concurrently.
- Insights generated by dreaming are **not** compacted — they are already synthesized cross-temporal artifacts. They persist as-is.
- Typed memories promoted by dreaming follow the normal typed memory lifecycle (searchable, absorbable into wisdom).

### 8.3 Search Signal Logging

The `SearchService.search()` and `SearchService.multiSearch()` methods are extended to append to the search log:

```typescript
// Added to SearchService (internal, not public API)
private async logSearch(query: string, results: SearchResult[]): Promise<void> {
  // Append to .dreams/search-log.jsonl
}
```

This is opt-in via configuration (`DreamingConfig.logSearches`, default: `true` when dreaming is enabled).

### 8.4 Watch Mode

`recall watch` gains an optional `--dream` flag. When enabled, dreaming runs on the configured schedule alongside sync and compaction.

---

## 9. DreamEngine API

```typescript
export interface DreamingConfig {
  /** Enable dreaming (default: false) */
  enabled?: boolean;

  /** Cron schedule for automatic dreaming (default: "0 3 * * *" — 3 AM daily) */
  schedule?: string;

  /** Timezone for cron schedule (default: system timezone) */
  timezone?: string;

  /** Maximum candidates per dreaming session (default: 20) */
  maxCandidates?: number;

  /** Days of search log to analyze (default: 30) */
  signalWindowDays?: number;

  /** Days before typed memories are flagged as stale (default: 90) */
  stalenessThresholdDays?: number;

  /** Enable search signal logging (default: true when dreaming is enabled) */
  logSearches?: boolean;

  /** Candidate scoring weights */
  scoringWeights?: DreamScoringWeights;

  /** Analysis templates (override defaults) */
  analysisTemplates?: Partial<AnalysisTemplates>;
}

export interface DreamScoringWeights {
  hitFrequency?: number;     // default: 0.25
  queryDiversity?: number;   // default: 0.25
  gapSignal?: number;        // default: 0.20
  staleness?: number;        // default: 0.15
  entityFrequency?: number;  // default: 0.15
}

export interface AnalysisTemplates {
  crossReference: string;
  gapAnalysis: string;
  contradictionDetection: string;
  typedMemoryExtraction: string;
  themeSynthesis: string;
}
```

### DreamEngine Class

```typescript
export class DreamEngine {
  constructor(
    service: MemoryService,
    model: MemoryModel,
    config?: DreamingConfig
  );

  /** Run a full dreaming session (all three phases) */
  dream(options?: DreamOptions): Promise<DreamResult>;

  /** Phase 1 only — collect signals and score candidates */
  gatherSignals(): Promise<DreamCandidate[]>;

  /** Phase 2 only — analyze specific candidates */
  analyze(candidates: DreamCandidate[]): Promise<AnalysisResult[]>;

  /** Phase 3 only — write outputs */
  writeResults(results: AnalysisResult[]): Promise<DreamOutput>;

  /** Get dreaming status (last run, pending candidates, signal stats) */
  status(): Promise<DreamStatus>;
}

export interface DreamOptions {
  /** Override max candidates for this session */
  maxCandidates?: number;
  /** Dry run — report what would be examined without running LLM */
  dryRun?: boolean;
  /** Only run specific phases */
  phases?: ("gather" | "analyze" | "write")[];
}

export interface DreamResult {
  /** Insights generated */
  insights: InsightRecord[];
  /** Typed memories promoted */
  promotions: string[];
  /** Contradictions detected */
  contradictions: ContradictionRecord[];
  /** Gaps identified (queries with no good results) */
  gaps: GapRecord[];
  /** Candidates examined vs total */
  candidatesExamined: number;
  candidatesTotal: number;
  /** LLM usage */
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface InsightRecord {
  file: string;
  theme: string;
  sources: string[];
  confidence: "high" | "medium" | "low";
}

export interface ContradictionRecord {
  wisdomEntry: string;
  evidence: string[];
  recommendation: string;
}

export interface GapRecord {
  query: string;
  frequency: number;
  lastQueried: string;
}

export interface DreamCandidate {
  type: "entity_cluster" | "temporal_gap" | "stale_memory" | "wisdom_drift" | "high_frequency" | "null_query";
  score: number;
  uris: string[];
  description: string;
}

export interface DreamStatus {
  lastRun?: Date;
  nextScheduled?: Date;
  pendingCandidates: number;
  searchLogEntries: number;
  searchLogOldest?: Date;
}
```

---

## 10. CLI

### New Command: `recall dream`

```
recall dream                        # Run a full dreaming session
recall dream --dry-run              # Show what would be examined
recall dream --phase gather         # Only collect signals
recall dream --phase analyze        # Only analyze (requires prior gather)
recall dream --max-candidates 10    # Limit candidates this session
recall dream --agent claude         # Specify LLM agent for synthesis
```

### Updated Command: `recall watch`

```
recall watch --dream                # Enable dreaming on schedule
recall watch --dream --dream-schedule "0 3 * * *"  # Custom schedule
```

### New Command: `recall dream status`

```
recall dream status                 # Show last run, pending candidates, signal stats
recall dream status --json          # JSON output
```

---

## 11. Configuration in MemoryServiceConfig

```typescript
export interface MemoryServiceConfig {
  // ... existing fields ...

  /** Dreaming configuration */
  dreaming?: DreamingConfig;
}
```

---

## 12. Storage Budget Impact

### Signal Storage (.dreams/)

| Component | Size estimate (1 year) |
|-----------|----------------------|
| Search log (30 queries/day avg) | ~3.3 MB (pre-rotation) |
| Rotated archives (gzip) | ~0.4 MB/year |
| candidates.json | <10 KB |
| dream-state.json | <1 KB |

### Output Storage (memory/dreams/)

| Component | Size estimate (1 year) |
|-----------|----------------------|
| Insight files (~2/week avg) | ~100 KB |
| Contradiction files (~1/month avg) | ~12 KB |
| DREAMS.md diary entries | ~50 KB |

**Total additional storage:** ~3.9 MB/year for signals (gitignored), ~162 KB/year for output (committed). Negligible compared to the existing ~1.9 MB/year baseline.

---

## 13. Comparison: Recall Dreaming vs OpenClaw Dreaming

| Aspect | Recall Dreaming | OpenClaw Dreaming |
|--------|----------------|-------------------|
| **Trigger** | Scheduled + on-demand CLI | Scheduled cron only |
| **Input signals** | Search logs, entity scans, staleness, wisdom drift | Session transcripts, recall traces, daily notes |
| **Phases** | Gather → Analyze → Write | Light → REM → Deep |
| **LLM usage** | Phase 2 only (analysis) | Deep phase only (promotion ranking) |
| **Primary output** | Insight files + typed memory promotions + contradiction flags | MEMORY.md promotions + DREAMS.md diary |
| **Cross-temporal** | Yes — core design goal | Limited — focuses on recent signal accumulation |
| **Contradiction detection** | Built-in (wisdom drift analysis) | Not built-in |
| **Gap analysis** | Built-in (null query detection) | Not built-in |
| **Data model** | Append-only files (eidetic-compatible) | Signal store + promotion to MEMORY.md |
| **Raw memory impact** | None (never modifies raw memories) | None |
| **Host dependency** | None (standalone) | Requires OpenClaw session lifecycle |

---

## 14. Open Questions

| # | Question | Options | Notes |
|---|----------|---------|-------|
| 1 | Should insights be auto-indexed immediately, or on next sync? | (a) Immediate — DreamEngine calls `index.upsertDocument()` after writing (b) Deferred — `recall sync` picks them up naturally | (a) is faster for search; (b) is simpler |
| 2 | Should dreaming consume the same `MemoryModel` instance as compaction, or have its own? | (a) Shared — simpler config (b) Separate — different model/temperature for analytical vs summarization tasks | Analysis may benefit from higher temperature than compaction |
| 3 | Should search log rotation happen during dreaming or as a separate maintenance step? | (a) During dreaming gather phase (b) Separate `recall maintain` command | (b) is cleaner separation of concerns |
| 4 | What's the right carry-over strategy for unprocessed candidates? | (a) Simple FIFO — oldest candidates get priority next session (b) Re-score — all candidates re-evaluated each session | (a) is cheaper; (b) adapts to changing signals |
| 5 | Should the dream diary (DREAMS.md) have a max size / rolling window? | (a) Unlimited (append-only forever) (b) Cap at N entries, oldest removed (c) Archive annually | Affects readability of the diary file |

---

## 15. Acceptance Criteria

### Signal Collection

- [ ] Search log (`search-log.jsonl`) is populated on every search operation when dreaming is enabled
- [ ] Search log entries include query, result URIs, scores, and timestamp
- [ ] Search log is rotated monthly (old entries archived as `.jsonl.gz`)
- [ ] Entity frequency scan uses the existing salience extraction pipeline (NER + regex + vocabulary)
- [ ] Staleness detection flags typed memories older than configurable threshold
- [ ] Wisdom drift detection compares WISDOM.md entries against recent behavioral evidence

### Candidate Selection

- [ ] Candidates are scored using configurable weighted signals
- [ ] Scoring weights default to: frequency 0.25, diversity 0.25, gap 0.20, staleness 0.15, entity 0.15
- [ ] Candidates are capped at `maxCandidates` per session
- [ ] Unprocessed candidates carry over to the next session

### Synthesis

- [ ] Cross-reference analysis produces insight files with source tracing
- [ ] Gap analysis identifies queries with consistently poor results
- [ ] Contradiction detection compares WISDOM.md against recent memories
- [ ] Typed memory extraction finds decisions/feedback/references missed by compaction
- [ ] Theme synthesis traces entity or topic evolution across temporal boundaries
- [ ] All synthesis uses the `MemoryModel` abstraction (no hardcoded LLM)

### Output

- [ ] Insight files written to `memory/dreams/insights/` with frontmatter
- [ ] Promoted typed memories written to `memory/` in standard format (deduplicated)
- [ ] Contradiction files written to `memory/dreams/contradictions/`
- [ ] Dream diary entry appended to `DREAMS.md` with session stats
- [ ] All output files are indexed by Vectra (searchable)
- [ ] Dreaming never modifies or deletes existing memory files

### CLI

- [ ] `recall dream` runs a full session
- [ ] `recall dream --dry-run` shows candidates without LLM calls
- [ ] `recall dream --phase gather` runs only signal collection
- [ ] `recall dream status` shows last run and pending candidates
- [ ] `recall watch --dream` enables scheduled dreaming
- [ ] `--json` output supported on all dream commands

### Configuration

- [ ] Dreaming is opt-in (disabled by default)
- [ ] Schedule, timezone, max candidates, signal window, and staleness threshold are configurable
- [ ] Scoring weights are configurable
- [ ] Analysis prompt templates are overridable

---

## 16. Implementation Sequencing

### Phase A — Search Signal Infrastructure

1. Add search log writing to `SearchService`
2. Implement log rotation
3. Add `DreamingConfig` to `MemoryServiceConfig`
4. Create `.dreams/` directory management

**Can ship independently.** Begins accumulating signals even before analysis exists.

### Phase B — Signal Collection + Candidate Scoring

1. Implement `SignalCollector` — parse search logs, entity scan, staleness check, wisdom drift
2. Implement candidate scoring with configurable weights
3. Implement carry-over persistence (`candidates.json`)
4. CLI: `recall dream --dry-run`, `recall dream --phase gather`, `recall dream status`

### Phase C — Synthesis Pipeline

1. Implement analysis templates (5 prompt types)
2. Implement `DreamEngine.analyze()` with batched LLM calls
3. Implement output parsers for each analysis type

### Phase D — Output + Integration

1. Implement `OutputWriter` — insight files, typed memory promotions, contradictions, diary
2. Wire dreaming output into Vectra indexing
3. CLI: `recall dream` (full session)
4. Add `--dream` flag to `recall watch`

**Phases A and B can overlap. C depends on B. D depends on C.**
**Phase A should ship first — signal accumulation takes time, and analysis quality improves with more data.**

---

## 17. Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-11 | Initial draft — three-phase dreaming architecture, signal collection, candidate scoring, synthesis pipeline, output formats, CLI, integration with existing systems |
