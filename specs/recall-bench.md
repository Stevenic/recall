# Recall Bench — Agent Memory Benchmark Spec

**Status:** Draft  
**Author:** Scribe  
**Date:** 2026-04-06  
**Version:** 0.3

---

## 1. Overview

Recall Bench is a benchmark suite for evaluating agent memory systems. It measures how well a memory system can ingest, organize, compact, and retrieve information over long time horizons.

The benchmark consists of **synthetic agent personas**, each with **1,000 days of daily memories** and a corresponding set of **Q&A evaluation pairs** that probe the memory system's recall abilities across multiple dimensions.

### Goals

1. **Reproducible evaluation** — Deterministic dataset with versioned Q&A pairs so results are comparable across systems and over time
2. **Multi-dimensional scoring** — Measure recall across distinct axes (recency, temporal reasoning, cross-referencing, etc.) rather than a single aggregate number
3. **System-agnostic** — Any memory system that can ingest markdown files and answer natural-language queries can be benchmarked
4. **Realistic complexity** — Personas reflect the messy reality of long-running agent work: evolving projects, contradictory information, corrected decisions, recurring themes

### Non-Goals (for v1)

- Benchmarking write performance or ingestion speed
- Evaluating memory system UX or developer experience
- Multi-agent or shared-memory scenarios
- Real-time / streaming evaluation

---

## 2. Concepts

### 2.1 Persona

A **persona** is a synthetic agent identity with a defined role, domain, and behavioral profile. Each persona produces a coherent 1,000-day memory stream that reflects realistic work patterns.

A persona definition includes:

| Field | Description |
|---|---|
| `id` | Unique slug (e.g., `er-physician`, `backend-eng-saas`) |
| `name` | Human-readable name (e.g., "River", "Dana") |
| `role` | Job function — any professional domain (e.g., "Emergency Physician", "Backend Engineer") |
| `domain` | Work context (e.g., "Urban trauma center", "B2B SaaS platform") |
| `profile` | Background, expertise, communication style |
| `projects` | List of projects the persona works on over the 1,000 days |
| `arcs` | Narrative arcs that span multiple days (see §2.3) |

### 2.2 Memory Day

A **memory day** is a single daily log entry produced by the persona. Each day is a markdown file following the format:

```
memories/<persona-id>/day-NNNN.md
```

Where `NNNN` is the zero-padded day number (0001–1000).

Each memory day contains:

- **Date** — Synthetic calendar date (starting from a fixed epoch)
- **Summary** — What the persona did that day
- **Details** — Technical decisions, conversations, code changes, blockers, learnings
- **Typed memories** — Extracted facts, feedback, references (embedded as frontmatter-tagged sections)

Memory days vary in length and density — some days are quiet (1–2 paragraphs), some are packed (multiple sections, decisions, handoffs). This mirrors real agent usage.

### 2.3 Narrative Arc

A **narrative arc** is a multi-day storyline woven through the memory stream. Arcs create the temporal complexity that makes memory retrieval hard.

Arc types:

| Type | Description | Example |
|---|---|---|
| **Project** | A feature or initiative spanning weeks/months | "Migrate auth from sessions to JWT" |
| **Incident** | A production issue with investigation and resolution | "Database connection pool exhaustion" |
| **Decision** | A choice made, revisited, and possibly reversed | "Chose Redis, switched to Postgres after benchmarks" |
| **Learning** | A skill or concept the persona gradually masters | "Learning Kubernetes operators" |
| **Relationship** | Recurring interactions with other personas/people | "Ongoing code reviews with teammate Alex" |
| **Correction** | Information that was believed true, later corrected | "Thought the API was rate-limited to 100rps; actually 1000rps" |

Each persona has 15–25 overlapping arcs of varying duration (3 days to 200+ days).

### 2.4 Q&A Pair

A **Q&A pair** is a question about the persona's memory stream and its expected answer. Each pair is tagged with metadata for scoring:

```yaml
- id: "backend-eng-saas-q042"
  question: "What was the final decision on the caching layer, and why did the team reverse the original choice?"
  answer: "The team switched from Redis to Postgres-backed caching in week 23. The original Redis choice was reversed because benchmark results showed that for their read-heavy workload with complex queries, Postgres materialized views outperformed Redis by 3x while eliminating a separate infrastructure dependency."
  category: decision-tracking
  difficulty: medium
  temporal_scope: cross-arc
  relevant_days: [145, 147, 152, 158, 161]
  requires_synthesis: true
```

### 2.5 Evaluation Categories

Q&A pairs are organized into categories that measure distinct recall capabilities:

| Category | What it measures | Example question |
|---|---|---|
| **Factual recall** | Retrieving a specific fact from a specific day | "What port was the staging server running on during the March deployment?" |
| **Temporal reasoning** | Understanding when things happened and in what order | "Did the team adopt the new linting rules before or after the CI migration?" |
| **Decision tracking** | Following a decision through proposal, discussion, and resolution | "Why was the original database schema rejected?" |
| **Contradiction resolution** | Handling information that was corrected or superseded | "What is the current API rate limit?" (was stated as 100rps on day 50, corrected to 1000rps on day 200) |
| **Cross-reference** | Connecting information across multiple arcs or time periods | "Which two projects shared the same blocking dependency?" |
| **Recency bias resistance** | Correctly recalling old information that hasn't been mentioned recently | "What testing framework was used for the first project?" (day 12, never mentioned again) |
| **Synthesis** | Combining multiple memories to produce an answer not stated in any single entry | "What pattern emerges in how the team handles database migrations?" |
| **Negative recall** | Correctly identifying that something was NOT mentioned | "Did the persona ever work on mobile features?" |

---

## 3. Persona Catalog

The benchmark ships with personas spanning **diverse professional domains** — not just software engineering. This ensures the benchmark measures general-purpose memory capabilities rather than optimizing for a single field's terminology and patterns.

### 3.1 Design Principles for Persona Selection

- **Domain diversity** — Cover knowledge work, creative work, scientific work, caregiving, operations, and advisory roles
- **Memory pattern diversity** — Each persona should stress a different mix of the 8 evaluation categories (§2.5)
- **Arc type diversity** — Some domains are decision-heavy, others are incident-heavy, others are relationship-heavy
- **Terminology spread** — The benchmark should not reward systems that are pre-trained on or tuned for any single professional vocabulary

### 3.2 v1 Personas (ship 5)

| Persona ID | Role | Domain | Key challenge |
|---|---|---|---|
| `backend-eng-saas` | Backend Engineer | B2B SaaS platform | Long-running projects with deep technical decisions, config drift, and evolving architecture |
| `er-physician` | Emergency Physician | Urban trauma center | Shift-based episodic memory, patient handoffs, protocol updates, drug interaction tracking |
| `litigation-attorney` | Litigation Attorney | Mid-size law firm | Case law references, evolving legal strategy, court deadlines, witness contradictions |
| `research-scientist` | Research Scientist | University biology lab | Experiment logs, hypothesis evolution, grant cycles, peer review feedback |
| `financial-advisor` | Financial Advisor | Wealth management firm | Client portfolio tracking, market event responses, regulatory changes, risk reassessments |

### 3.3 v1.1 Expansion Personas (5 additional)

| Persona ID | Role | Domain | Key challenge |
|---|---|---|---|
| `k12-teacher` | High School Teacher | Public school district | Curriculum planning, student progress tracking, parent communications, policy changes |
| `investigative-journalist` | Investigative Journalist | Regional newspaper | Source tracking, story arc development, editorial corrections, fact verification chains |
| `construction-pm` | Construction Project Manager | Commercial builder | Permit timelines, subcontractor coordination, code compliance, weather delays, change orders |
| `clinical-psychologist` | Clinical Psychologist | Private practice | Patient session notes, treatment plan evolution, referral networks, therapeutic approach shifts |
| `supply-chain-analyst` | Supply Chain Analyst | Global manufacturer | Vendor performance tracking, disruption responses, lead time evolution, cost renegotiations |

### 3.4 Persona–Category Stress Map

Each persona is designed to stress different evaluation categories. The table shows **primary** (P) and **secondary** (S) stress for each:

| Category | Backend Eng | ER Physician | Litig. Attorney | Research Sci. | Financial Adv. |
|---|---|---|---|---|---|
| Factual recall | S | P | P | S | S |
| Temporal reasoning | S | P | S | P | S |
| Decision tracking | P | S | P | S | P |
| Contradiction resolution | S | S | P | P | P |
| Cross-reference | P | S | P | P | S |
| Recency bias resistance | S | P | S | S | P |
| Synthesis | P | S | S | P | S |
| Negative recall | S | S | S | S | P |

This ensures no single category lacks a persona that heavily exercises it.

---

## 4. Memory Generation

### 4.1 Generation Pipeline

Memories are generated using an LLM with structured prompts. The pipeline is:

```
Persona Definition
       │
       ▼
Arc Planner ──→ Arc Timeline (which arcs are active on which days)
       │
       ▼
Day Generator ──→ Raw daily memories (1,000 per persona)
       │
       ▼
Consistency Checker ──→ Flag contradictions that aren't intentional
       │
       ▼
Q&A Generator ──→ Draft Q&A pairs from the completed memory stream
       │
       ▼
Q&A Validator ──→ Human review + automated answer verification
       │
       ▼
Published Dataset
```

### 4.2 Arc Planner

The arc planner takes a persona definition and produces a **timeline grid** — a day-by-day matrix of which arcs are active, starting, or concluding. This ensures:

- No day has more than 3–4 active arcs (realistic cognitive load)
- Arcs overlap naturally (a new project starts before the old one fully wraps up)
- Correction arcs are placed with enough gap that the wrong information has time to "settle" in memory before being corrected
- Quiet periods exist (weekends, holidays, low-activity stretches)

### 4.3 Day Generator

For each day, the generator receives:

- The persona profile
- Active arcs and their current state
- The previous 3–5 days of generated memories (for continuity)
- Day-specific directives (e.g., "today the incident resolves", "today a new project kicks off")

The generator produces a daily memory in markdown format with realistic variation in length, detail level, and tone.

### 4.4 Consistency Checker

A separate LLM pass reads the full 1,000-day stream and flags:

- Unintentional contradictions (facts that change without a correction arc)
- Orphaned references (mentions of people, systems, or decisions that never appear elsewhere)
- Timeline impossibilities (e.g., referencing a result before the experiment ran)

Intentional contradictions (part of a Correction arc) are excluded from flagging.

### 4.5 Q&A Generation

Q&A pairs are generated after the full memory stream is complete. The generator:

1. Samples from each evaluation category (§2.5) to ensure coverage
2. Grounds each answer in specific `relevant_days`
3. Tags difficulty based on how many days must be consulted and how far apart they are
4. Ensures negative-recall questions have verifiably absent topics

**Target: 200 Q&A pairs per persona** distributed across all 8 categories.

### 4.6 Q&A Validation

Every Q&A pair must pass:

1. **Answer verification** — An independent LLM (different model or temperature) answers the question given full access to the memory stream. If it produces a substantially different answer, the pair is flagged for human review.
2. **Human spot-check** — At least 20% of pairs are manually verified by a human reviewer.
3. **Difficulty calibration** — Pairs are tested against a naive retrieval baseline (BM25 over raw files) to validate difficulty ratings.

---

## 5. Benchmark Protocol

### 5.1 Ingestion Phase

The system under test ingests daily memories up to the selected time-range cutoff (see §5.4). The benchmark runner feeds memories **one day at a time in chronological order**, simulating realistic usage.

The system may:
- Index memories
- Compact/summarize memories
- Build any internal data structures
- Run any background processing

The benchmark measures ingestion but does **not score** it — it's purely setup.

### 5.2 Query Phase

After ingestion completes, the benchmark runner poses each eligible Q&A pair's question to the system under test. A Q&A pair is eligible when **all** of its `relevant_days` fall within the active time range (§5.4). The system returns a natural-language answer.

**Constraints:**
- Questions are posed in random order (not chronological)
- The system has no access to the Q&A pairs during ingestion
- Each question is independent — no multi-turn conversations
- The system may use any retrieval strategy (semantic search, keyword search, full scan, etc.)

### 5.3 Scoring

Each answer is evaluated by a **judge model** (a strong LLM) that compares the system's answer against the reference answer.

Scoring dimensions per answer:

| Dimension | Scale | Description |
|---|---|---|
| **Correctness** | 0–3 | Does the answer contain the right information? (0 = wrong, 1 = partially correct, 2 = mostly correct, 3 = fully correct) |
| **Completeness** | 0–2 | Does the answer include all relevant details from the reference? (0 = missing key info, 1 = partial, 2 = complete) |
| **Hallucination** | 0–1 | Does the answer introduce facts not present in the memory stream? (0 = hallucinated content, 1 = grounded) |

**Composite score per question:** `correctness + completeness + hallucination` (max 6)

**Aggregate scores reported:**

- Overall score (mean across all questions)
- Per-category score (mean within each of the 8 categories)
- Per-difficulty score (easy / medium / hard breakdown)
- Hallucination rate (% of questions with hallucination = 0)
- Per-range score (mean at each time-range cutoff — see §5.4)

### 5.4 Time-Range Subsetting

The benchmark supports running against subsets of the full 1,000-day corpus. This reveals how memory system performance changes as corpus size grows — a critical dimension for systems that compact or prune old memories.

**Named ranges:**

| Key | Days ingested | Description |
|---|---|---|
| `30d` | 1–30 | Short-term recall |
| `90d` | 1–90 | Quarter-scale recall |
| `6mo` | 1–180 | Half-year recall |
| `1y` | 1–365 | Full-year recall |
| `full` | 1–1000 | Complete corpus |

**Behavior:**

1. For each selected range, the harness performs a **fresh** adapter lifecycle: `setup()` → `ingestDay()` × cutoff → `finalizeIngestion()` → query → `teardown()`.
2. Only days 1 through the range cutoff are ingested.
3. Only Q&A pairs whose **all** `relevant_days` fall within the cutoff are evaluated. A pair referencing days [5, 200] is evaluated at `1y` and `full` but skipped at `30d`, `90d`, and `6mo`.
4. Results are reported per-range so users can compare performance at each corpus size.

Users may select any subset of ranges to run (e.g., `--ranges 30d,1y`) or run all five. The default is `full` only (preserving backward-compatible behavior).

**Q&A pair coverage guidance:** Because filtering by range reduces the eligible question pool, persona datasets should ensure adequate Q&A coverage at every range cutoff. The recommended minimums per range bucket:

| Range | Minimum eligible Q&A pairs per persona |
|---|---|
| `30d` | 30 |
| `90d` | 60 |
| `6mo` | 100 |
| `1y` | 150 |
| `full` | 200 |

To meet these minimums, the current target of 200 Q&A pairs per persona may need to increase to **300–350 pairs** with `relevant_days` intentionally distributed across the full 1,000-day span, with heavier concentration in early days. The Q&A generation pipeline (§4.5) should enforce these minimums as a validation gate.

---

## 6. Dataset Format

### 6.1 Directory Structure

```
recall-bench/
├── personas/
│   ├── backend-eng-saas/
│   │   ├── persona.yaml          # Persona definition
│   │   ├── arcs.yaml             # Arc definitions and timeline
│   │   ├── memories/
│   │   │   ├── day-0001.md
│   │   │   ├── day-0002.md
│   │   │   └── ...               # 1,000 files
│   │   └── qa/
│   │       ├── questions.yaml    # All Q&A pairs
│   │       └── by-category/
│   │           ├── factual-recall.yaml
│   │           ├── temporal-reasoning.yaml
│   │           └── ...
│   ├── data-scientist-ml/
│   │   └── ...
│   └── ...
├── runner/
│   ├── ingest.ts                 # Ingestion harness
│   ├── query.ts                  # Query harness
│   ├── judge.ts                  # Scoring harness
│   └── report.ts                 # Report generator
├── adapters/
│   ├── recall-adapter.ts         # Adapter for our recall service
│   └── adapter-interface.ts      # Interface for plugging in other systems
├── results/
│   └── ...                       # Generated result files
├── bench.config.yaml             # Benchmark configuration
└── README.md
```

### 6.2 Adapter Interface

Any memory system can participate by implementing a simple adapter:

```typescript
export interface MemorySystemAdapter {
  /** Human-readable name of the system under test */
  name: string;

  /** Initialize the memory system (clean state) */
  setup(): Promise<void>;

  /** Ingest a single day's memory. Called in chronological order. */
  ingestDay(day: number, content: string, metadata: DayMetadata): Promise<void>;

  /** Signal that ingestion is complete. System may do final processing. */
  finalizeIngestion(): Promise<void>;

  /** Ask a question and get an answer */
  query(question: string): Promise<string>;

  /** Clean up resources */
  teardown(): Promise<void>;
}

export interface DayMetadata {
  dayNumber: number;          // 1-1000
  date: string;               // Synthetic calendar date (ISO 8601)
  personaId: string;
  activeArcs: string[];       // IDs of arcs active on this day
}
```

### 6.3 Configuration

```yaml
# bench.config.yaml
personas:
  - backend-eng-saas
  - er-physician
  - litigation-attorney
  - research-scientist
  - financial-advisor

judge:
  model: "claude-sonnet-4-6"    # Model used for scoring
  temperature: 0                 # Deterministic scoring

runner:
  parallelism: 1                 # Questions evaluated sequentially by default
  timeout_per_question_ms: 30000
  shuffle_seed: 42               # Fixed seed for question order reproducibility
  ranges:                        # Time-range subsets to evaluate (default: [full])
    - 30d
    - 90d
    - 6mo
    - 1y
    - full

output:
  format: "json"                 # json | markdown | both
  dir: "./results"
  heatmap: true                  # Include category × range heatmap (default: false)
```

---

## 7. Reporting

The benchmark produces a structured report:

```
Recall Bench Report — recall v1.0.0
Personas: 5 | Questions: 1000 | Date: 2026-04-15

Overall Score:     4.2 / 6.0 (70.0%)
Hallucination Rate: 3.2%

Category Breakdown:
  Factual recall ............. 4.8 / 6.0 (80.0%)
  Temporal reasoning ......... 3.9 / 6.0 (65.0%)
  Decision tracking .......... 4.1 / 6.0 (68.3%)
  Contradiction resolution ... 3.2 / 6.0 (53.3%)
  Cross-reference ............ 4.0 / 6.0 (66.7%)
  Recency bias resistance .... 3.5 / 6.0 (58.3%)
  Synthesis .................. 4.4 / 6.0 (73.3%)
  Negative recall ............ 5.1 / 6.0 (85.0%)

Difficulty Breakdown:
  Easy ..... 5.2 / 6.0 (86.7%)
  Medium ... 4.1 / 6.0 (68.3%)
  Hard ..... 3.0 / 6.0 (50.0%)
```

Machine-readable JSON output includes per-question scores for detailed analysis.

### 7.1 Heatmap Report

When multiple time ranges are evaluated, the benchmark produces a **category × time-range heatmap matrix**. This is the primary visualization for understanding how recall degrades (or holds) across topics as corpus size grows.

**Text rendering:**

```
Category × Range Heatmap (mean score / 6.0)

                              30d     90d     6mo      1y    full
────────────────────────────────────────────────────────────────────
factual-recall                4.8     4.5     4.2     4.0     3.8
temporal-reasoning            3.9     3.7     3.5     3.2     3.0
decision-tracking             5.0     4.8     4.3     4.1     3.9
contradiction-resolution       --      --     3.1     2.8     2.5
cross-reference                --     3.5     3.2     3.0     2.8
recency-bias-resistance       4.2     4.0     3.6     3.1     2.7
synthesis                     4.5     4.3     4.0     3.8     3.5
negative-recall               5.4     5.2     5.0     4.9     4.8
```

Cells show `--` when fewer than 3 eligible Q&A pairs exist for that category/range combination (insufficient data for a meaningful score).

**Structured output (`HeatmapGrid`):**

```typescript
export interface HeatmapGrid {
  /** Row labels — the 8 evaluation categories */
  categories: string[];

  /** Column labels — the time ranges evaluated */
  ranges: TimeRangeKey[];

  /** Mean scores in row-major order: scores[catIdx * ranges.length + rangeIdx] */
  scores: (number | null)[];

  /** Q&A pair counts in row-major order (same layout as scores) */
  counts: number[];
}
```

A `null` in `scores` indicates insufficient data (fewer than 3 pairs). The `counts` array lets consumers decide their own minimum-count threshold.

CLI flag: `--heatmap` outputs only the heatmap grid (text or JSON depending on `--format`).

---

## 8. Leaderboard (Future)

A public leaderboard where memory system authors can submit results. Out of scope for v1 but the dataset format and scoring methodology are designed to support it.

Requirements for future leaderboard:
- Results must include adapter source code (for reproducibility)
- Self-reported results are marked differently from CI-verified results
- Dataset version is tracked (results are only comparable within the same dataset version)

---

## 9. Open Questions

1. **Synthetic vs. semi-real data** — Should any persona be based on anonymized real agent logs, or is fully synthetic better for IP/privacy reasons? _Recommendation: fully synthetic for v1._

2. **Judge model selection** — Should the judge be the same model used for generation, or a different one? Using a different model reduces circular bias but may introduce inconsistency. _Recommendation: use a strong model (Opus-class) regardless of generation model._

3. **Compaction evaluation** — Should the benchmark separately score systems that compact memories vs. those that keep raw files? Compaction is a feature of some systems but not others. _Recommendation: don't score compaction separately — the Q&A results implicitly measure whether compaction preserved the right information._

4. **Multi-turn queries** — Some memory systems support conversational retrieval. Should v1 include multi-turn Q&A sequences? _Recommendation: no, keep v1 single-turn. Add multi-turn in v2._

5. **Cost tracking** — Should the benchmark report token usage / API costs? Useful for comparing efficiency but adds complexity. _Recommendation: yes, track tokens in/out for both ingestion and query phases._

---

## 10. Success Criteria

The benchmark is ready to ship when:

- [ ] At least 5 personas are fully generated and validated
- [ ] Each persona has 1,000 days of memories passing consistency checks
- [ ] Each persona has 300+ Q&A pairs with validated answers, meeting per-range minimum coverage (§5.4)
- [ ] At least 20% of Q&A pairs have been human-verified
- [ ] The adapter interface has been tested with at least 2 memory systems (recall + one other)
- [ ] The judge model produces consistent scores (kappa > 0.8 on a 50-question re-score test)
- [ ] A naive baseline (BM25 keyword search) has been scored to calibrate difficulty ratings
- [ ] Report generation produces correct aggregate statistics, including heatmap grid
- [ ] Time-range subsetting produces correct results at all 5 named ranges
- [ ] The full benchmark runs end-to-end in under 2 hours per persona (all ranges)

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-04-06 | Initial draft |
| 0.2 | 2026-04-06 | Broadened persona catalog beyond software — 5 cross-domain personas for v1, 5 expansion personas for v1.1, added stress map |
| 0.3 | 2026-04-06 | Added time-range subsetting (§5.4) with 5 named ranges (30d–full), heatmap reporting (§7.1) with `HeatmapGrid` structured output, Q&A pair scaling guidance (300+ pairs/persona), updated config and CLI flags |
