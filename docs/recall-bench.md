# Recall Bench

Recall Bench is a benchmark harness for evaluating agent memory systems. It measures how well a memory system can **ingest**, **organize**, and **retrieve** information over long time horizons — up to 1,000 days of synthetic daily logs per persona.

## Why Recall Bench?

Most memory system evaluations test retrieval over small corpora or short time spans. Real-world agents accumulate months or years of context. Recall Bench fills that gap by simulating realistic, long-horizon memory workloads across diverse professional domains and measuring performance degradation as the corpus grows.

## How It Works

Recall Bench follows a three-phase evaluation loop:

```
┌──────────────────────────────────────────────────────────────────┐
│                     Benchmark Lifecycle                          │
│                                                                  │
│  For each (persona × time-range):                                │
│                                                                  │
│    1. SETUP        → adapter.setup()                             │
│    2. INGEST       → adapter.ingestDay(1..N)  [chronological]    │
│    3. FINALIZE     → adapter.finalizeIngestion()                 │
│    4. QUERY        → adapter.query(question)  [for each Q&A]    │
│    5. SCORE        → judge.score(question, ref, answer)          │
│    6. TEARDOWN     → adapter.teardown()                          │
│                                                                  │
│  Each time-range gets a FRESH lifecycle — no state leaks.        │
└──────────────────────────────────────────────────────────────────┘
```

**Phase 1 — Ingestion.** Daily memory logs (markdown) are fed to the system under test in chronological order. The system can index, embed, summarize, or store them however it likes.

**Phase 2 — Querying.** The harness poses natural-language questions grounded in specific days. Questions are filtered per time-range so the system is only asked about information it has actually seen.

**Phase 3 — Scoring.** A judge model compares each answer against a reference answer and scores it on three dimensions:

| Dimension | Scale | What it measures |
|---|---|---|
| **Correctness** | 0–3 | Does the answer contain the right facts? |
| **Completeness** | 0–2 | Does it include all relevant details? |
| **Hallucination** | 0–1 | Is it grounded in actual memories? (1 = yes) |

**Composite score** = correctness + completeness + hallucination → max **6.0** per question.

## Evaluation Dimensions

Scores are broken down across **8 categories** that probe different memory capabilities:

| Category | What it tests |
|---|---|
| `factual-recall` | Retrieving specific facts from past days |
| `temporal-reasoning` | Understanding when events happened and their order |
| `decision-tracking` | Remembering decisions and their rationale |
| `contradiction-resolution` | Detecting when later information supersedes earlier beliefs |
| `cross-reference` | Connecting information across unrelated arcs |
| `recency-bias-resistance` | Not favoring recent memories over equally relevant older ones |
| `synthesis` | Combining information from multiple days into a coherent answer |
| `negative-recall` | Correctly reporting that something did NOT happen |

## Time Ranges

Performance is measured at 5 corpus sizes to reveal how the system degrades as memory grows:

| Range | Days Ingested | Purpose |
|---|---|---|
| `30d` | 1–30 | Short-term recall baseline |
| `90d` | 1–90 | Quarter-scale |
| `6mo` | 1–180 | Half-year |
| `1y` | 1–365 | Full-year |
| `full` | 1–1000 | Complete corpus (~2.7 years) |

Each range gets a **completely fresh** adapter lifecycle. Q&A pairs are filtered so only questions whose `relevant_days` all fall within the cutoff are included.

## The Persona System

Recall Bench uses **personas** — synthetic identities with realistic professional backgrounds spanning 1,000 days of activity. Each persona has:

- **Identity** (`persona.yaml`) — name, role, domain, company, communication style
- **Story arcs** (`arcs.yaml`) — overlapping narrative threads (projects, incidents, decisions, learning, relationships, corrections) that drive what happens each day
- **Daily logs** (`memories/day-NNNN.md`) — 1,000 markdown files, one per day
- **Q&A pairs** (`qa/questions.yaml`) — evaluation questions with reference answers, categories, difficulty levels, and relevant day numbers

### Shipped Personas

The benchmark ships with 5 cross-domain personas to ensure the evaluation isn't biased toward any single profession:

| Persona | Role | Domain |
|---|---|---|
| `backend-eng-saas` | Senior Backend Engineer | B2B SaaS platform |
| `er-physician` | Emergency Physician | Urban trauma center |
| `litigation-attorney` | Litigation Attorney | Mid-size law firm |
| `research-scientist` | Research Scientist | University biology lab |
| `financial-advisor` | Financial Advisor | Wealth management firm |

### Story Arcs

Arcs create realistic complexity:

- **4 max concurrent arcs** at any time — avoids overwhelming any single day
- **Arc types:** projects (long-running), incidents (short bursts), decisions (medium-length deliberation), learning (skill acquisition), relationships (interpersonal threads), corrections (belief revisions)
- **Correction arcs** are especially important — they test whether the system can track that a previously held belief was later corrected
- **Quiet periods** (vacations, breaks) are intentionally included to test behavior with temporal gaps

## Dataset Generation Pipeline

Datasets are generated using a **two-pass LLM pipeline**:

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: create-persona                                         │
│  Prompt → persona.yaml + arcs.yaml                              │
├─────────────────────────────────────────────────────────────────┤
│  Step 2: generate  (Pass 1)                                     │
│  Process arcs in order → generate day-by-day logs               │
│  • Arc-driven: each arc selects its active days                 │
│  • Merge: if two arcs overlap on the same day, content merges   │
│  • Context: sliding window of recent days + arc summaries       │
│  • Density hints: quiet / normal / busy / dense                 │
├─────────────────────────────────────────────────────────────────┤
│  Step 2b: Gap filling                                           │
│  Fill weeks with < 5 active days with routine filler            │
├─────────────────────────────────────────────────────────────────┤
│  Step 3: generate-conversations  (Pass 2, optional)             │
│  Convert daily logs → user/assistant conversation turns         │
├─────────────────────────────────────────────────────────────────┤
│  Step 4: Create Q&A pairs  (manual or LLM-assisted)             │
│  questions.yaml with reference answers + metadata               │
└─────────────────────────────────────────────────────────────────┘
```

**Pass 1** separates "what happened" from how it was communicated. **Pass 2** optionally reconstructs the conversations that would have produced those logs.

## Connecting Your Memory System

Any system that can ingest markdown and answer questions can participate. Two integration paths:

### TypeScript Adapter

```typescript
import type { MemorySystemAdapter, DayMetadata } from '@recall/bench';

const adapter: MemorySystemAdapter = {
  name: 'My Memory System',
  async setup() { /* clean state */ },
  async ingestDay(day: number, content: string, metadata: DayMetadata) { /* store */ },
  async finalizeIngestion() { /* build indexes */ },
  async query(question: string): Promise<string> { return answer; },
  async teardown() { /* cleanup */ },
};
export default adapter;
```

### gRPC Adapter (any language)

Implement the `MemoryBenchService` proto and point the harness at it:

```bash
npx recall-bench run --adapter grpc://127.0.0.1:50052 --data ./personas
```

The gRPC interface maps 1:1 to the TypeScript adapter. This lets you write adapters in Python, Go, Rust, Java, C#, or anything with gRPC support.

## Output: The Heatmap

The primary output is a **category × time-range heatmap** showing mean composite scores. This is the key artifact for understanding a memory system's strengths and weaknesses.

### Example Heatmap Output

```
═══════════════════════════════════════════════════════════════════════════
  AGGREGATE HEATMAP — Recall System v0.4 (5 personas)
═══════════════════════════════════════════════════════════════════════════
                               30d     90d     6mo      1y    full
───────────────────────────────────────────────────────────────────────────
  factual-recall              5.4     5.1     4.7     4.3     3.8
  temporal-reasoning          4.6     4.2     3.8     3.4     2.9
  decision-tracking           5.2     4.9     4.5     4.2     3.7
  contradiction-resolution     --      --     3.3     2.9     2.4
  cross-reference             4.8     4.4     3.9     3.5     3.1
  recency-bias-resistance     5.0     4.6     4.1     3.3     2.6
  synthesis                   4.2     3.9     3.5     3.1     2.7
  negative-recall             5.6     5.3     4.9     4.5     4.1
───────────────────────────────────────────────────────────────────────────
  OVERALL                     4.97    4.63    4.09    3.65    3.16
═══════════════════════════════════════════════════════════════════════════
  Hallucination rate:  1.2%    2.4%    4.1%    6.8%   10.3%
═══════════════════════════════════════════════════════════════════════════
```

### Reading the Heatmap

**Columns** represent time-range slices. Reading left to right shows how performance degrades as the corpus grows. A system with good long-term recall will show a gentle slope; a system that relies heavily on recency will show steep drop-offs.

**Rows** represent evaluation categories. Each cell is the mean composite score (0.0–6.0) across all personas and eligible questions for that category/range combination.

Key patterns to look for:

- **Steep left-to-right drop** in `recency-bias-resistance` → system over-weights recent memories
- **`--` cells** in `contradiction-resolution` at short ranges → correction arcs haven't started yet (by design — corrections take time to develop)
- **Low `synthesis` scores** across all ranges → system struggles to combine information from multiple memories
- **High `negative-recall`** → system correctly avoids fabricating answers to questions about events that didn't happen
- **Rising hallucination rate** → system fills gaps with fabricated content as the corpus grows and retrieval becomes harder

### Visual Heatmap (Color-Coded)

When rendered visually, the heatmap uses color to make patterns immediately obvious:

```
                          30d    90d    6mo     1y   full
                        ┌──────┬──────┬──────┬──────┬──────┐
  factual-recall        │ ███  │ ██▓  │ ██░  │ █▓░  │ █░░  │
  temporal-reasoning    │ ██▓  │ ██░  │ █▓░  │ █░░  │ ▓░░  │
  decision-tracking     │ ███  │ ██▓  │ ██░  │ █▓░  │ █░░  │
  contradiction-resol.  │  --  │  --  │ █▓░  │ █░░  │ ▓░░  │
  cross-reference       │ ██▓  │ ██░  │ █▓░  │ █░░  │ █░░  │
  recency-bias-resist.  │ ███  │ ██░  │ █▓░  │ █░░  │ ▓░░  │
  synthesis             │ ██░  │ █▓░  │ █░░  │ █░░  │ ▓░░  │
  negative-recall       │ ███  │ ███  │ ██▓  │ ██░  │ █▓░  │
                        └──────┴──────┴──────┴──────┴──────┘

  Legend:  ███ = 5.0-6.0 (excellent)    ██▓ = 4.0-5.0 (good)
           ██░ = 3.0-4.0 (adequate)     █▓░ = 2.0-3.0 (weak)
           █░░ = 1.0-2.0 (poor)         ▓░░ = 0.0-1.0 (failing)
            -- = insufficient data (< 3 eligible questions)
```

The characteristic "cooling gradient" from left to right is expected — all memory systems degrade with scale. What matters is *how steep* the gradient is and *which categories* degrade fastest.

## CLI Reference

### Running a Benchmark

```bash
npx recall-bench run \
  --adapter grpc://127.0.0.1:50052 \
  --data ./personas \
  --judge ./my-judge.js \
  --personas backend-eng-saas er-physician \
  --ranges 30d,full \
  --json
```

| Flag | Default | Description |
|---|---|---|
| `--adapter <url\|path>` | required | gRPC URL or JS adapter module |
| `--data <dir>` | required | Dataset directory |
| `--judge <path>` | stub (zeros) | JS judge module |
| `--personas <ids...>` | all | Subset of personas to run |
| `--ranges <ranges...>` | all 5 | Time ranges to evaluate |
| `--seed <n>` | 42 | Shuffle seed for question order |
| `--timeout <ms>` | 30000 | Per-question timeout |
| `--grpc-timeout <ms>` | 120000 | Per-RPC timeout |
| `--parallelism <n>` | 1 | Concurrent queries |
| `--json` | false | Full JSON output |
| `--heatmap` | false | Heatmap grid only (JSON) |

### Generating Datasets

```bash
# Step 1: Create persona + arcs
npx recall-bench create-persona \
  --prompt "A backend engineer at a B2B SaaS company" \
  --model claude --out ./dataset/my-persona

# Step 2: Generate 1,000 days
npx recall-bench generate \
  --persona ./dataset/my-persona --model claude

# Step 3: (Optional) Generate conversations
npx recall-bench generate-conversations \
  --persona ./dataset/my-persona --model claude --format markdown
```

### Utility Commands

```bash
# List available personas
npx recall-bench list --data ./personas

# Show time-range definitions
npx recall-bench ranges
```

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                       recall-bench                            │
├───────────────┬──────────────────┬────────────────────────────┤
│   CLI Layer   │  Harness Engine  │   Generation Pipeline      │
│  (commander)  │  (orchestration) │  (LLM-driven)              │
├───────────────┼──────────────────┼────────────────────────────┤
│ cli.ts        │ harness.ts       │ persona-creator.ts         │
│               │ types.ts         │ generator.ts               │
│               │ report.ts        │ conversation-generator.ts  │
│               │ dataset.ts       │ generator-types.ts         │
├───────────────┴──────────────────┴────────────────────────────┤
│                     Adapter Layer                             │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │  JS Module Adapter  │    │  gRPC Adapter (any language)  │ │
│  │  (direct import)    │    │  (proto/memory_bench_service) │ │
│  └─────────────────────┘    └──────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## Programmatic API

All functionality is available as a library:

```typescript
import {
  BenchmarkHarness,
  formatTextReport,
  formatJsonReport,
  toHeatmapGrid,
  loadPersona,
  filterQAByRange,
  listPersonas,
  DayGenerator,
  PersonaCreator,
  GrpcMemoryAdapter,
} from '@recall/bench';
```
