# Recall Bench

A benchmark suite for evaluating agent memory systems. Measures how well a memory system can ingest, organize, and retrieve information over long time horizons (1,000 days of synthetic daily logs per persona).

## Overview

Recall Bench works by:

1. **Ingesting** synthetic daily memory logs into the system under test
2. **Querying** the system with questions grounded in specific days
3. **Scoring** answers against reference answers using a judge model

Scores are broken down across 8 evaluation categories (factual recall, temporal reasoning, decision tracking, contradiction resolution, cross-reference, recency bias resistance, synthesis, negative recall) and 5 time-range slices (30 days to full 1,000-day corpus).

Any memory system that can ingest markdown and answer natural-language queries can participate — either by implementing a TypeScript adapter or by running a gRPC server in any language.

## Installation

### Prerequisites

- Node.js >= 18
- npm

### From the monorepo

```bash
# Clone and install
git clone <repo-url>
cd recall
npm install

# Build
npm run build --workspace=packages/recall-bench

# Verify
npx recall-bench --help
```

### As a standalone package

```bash
npm install @recall/bench
```

## Quick Start

```bash
# List available personas in a dataset
npx recall-bench list --data ./personas

# Show available time ranges
npx recall-bench ranges

# Run a benchmark (gRPC adapter)
npx recall-bench run \
  --adapter grpc://127.0.0.1:50052 \
  --data ./personas \
  --ranges full

# Run a benchmark (JS module adapter)
npx recall-bench run \
  --adapter ./my-adapter.js \
  --data ./personas \
  --ranges 30d,90d,full \
  --json
```

## Datasets

A dataset is a directory of personas. Each persona contains daily memory logs and Q&A evaluation pairs.

### Directory Structure

```
dataset/
├── backend-eng-saas/
│   ├── persona.yaml           # Identity and profile
│   ├── arcs.yaml              # Narrative arc definitions
│   ├── memories/
│   │   ├── day-0001.md        # Daily memory logs
│   │   ├── day-0002.md
│   │   └── ...                # Up to 1,000 files
│   └── qa/
│       └── questions.yaml     # Q&A evaluation pairs
├── er-physician/
│   └── ...
└── ...
```

### Creating a Dataset

Recall Bench includes a generation pipeline that uses LLMs to create personas, story arcs, and daily memory logs.

#### Step 1 — Create a persona

Generate a persona definition and story arcs from a text prompt:

```bash
npx recall-bench create-persona \
  --prompt "A backend engineer at a B2B SaaS company working on auth migration and API redesign" \
  --model claude \
  --out ./dataset/my-persona
```

This creates `persona.yaml` and `arcs.yaml` in the output directory.

To generate arcs separately for an existing persona:

```bash
npx recall-bench create-persona \
  --arcs-only \
  --model claude \
  --out ./dataset/my-persona
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--prompt <text>` | required | Description of the persona to create |
| `--model <name\|path>` | required | `claude`, `codex`, `copilot`, or path to a JS module |
| `--out <dir>` | required | Output directory |
| `--epoch <date>` | `2024-01-01` | Starting date for the persona timeline |
| `--temperature <n>` | `0.7` | Generation temperature |
| `--max-tokens <n>` | `4000` | Max output tokens per LLM call |
| `--arcs-only` | `false` | Only generate arcs for an existing `persona.yaml` |
| `--json` | `false` | Output JSON summary |

#### Step 2 — Generate daily memories

Generate 1,000 days of daily memory logs (Pass 1):

```bash
npx recall-bench generate \
  --persona ./dataset/my-persona \
  --model claude \
  --out ./dataset/my-persona/memories \
  --start 1 \
  --end 1000
```

The generator uses a sliding history window and arc state tracking to produce coherent, temporally consistent daily logs.

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--persona <dir>` | required | Directory containing `persona.yaml` and `arcs.yaml` |
| `--model <name\|path>` | required | `claude`, `codex`, `copilot`, or path to a JS module |
| `--out <dir>` | required | Output directory for `day-NNNN.md` files |
| `--start <n>` | `1` | Starting day number (for resuming interrupted runs) |
| `--end <n>` | `1000` | Ending day number |
| `--temperature <n>` | `0.7` | Generation temperature |
| `--max-tokens <n>` | `2000` | Max output tokens per day |
| `--history-window <n>` | `3` | Number of recent days included as context |
| `--json` | `false` | Output JSON summary |

#### Step 3 — Generate conversations (Pass 2)

Convert daily logs into user/assistant conversation turns:

```bash
npx recall-bench generate-conversations \
  --persona ./dataset/my-persona \
  --model claude \
  --days ./dataset/my-persona/memories \
  --out ./dataset/my-persona/conversations \
  --format markdown
```

**Options:**
| Flag | Default | Description |
|---|---|---|
| `--persona <dir>` | required | Directory containing `persona.yaml` |
| `--model <name\|path>` | required | `claude`, `codex`, `copilot`, or path to a JS module |
| `--days <dir>` | required | Directory containing `day-NNNN.md` files |
| `--out <dir>` | required | Output directory for conversation files |
| `--format <fmt>` | `markdown` | Output format: `markdown` or `json` |
| `--start <n>` | `1` | Starting day number |
| `--end <n>` | `1000` | Ending day number |
| `--json` | `false` | Output JSON summary |

#### Step 4 — Create Q&A pairs

Q&A pairs are stored in `qa/questions.yaml` inside each persona directory. Each pair follows this schema:

```yaml
- id: "my-persona-q001"
  question: "What was the final decision on the caching layer?"
  answer: "The team switched from Redis to Postgres-backed caching in week 23..."
  category: decision-tracking
  difficulty: medium
  relevant_days: [145, 147, 152, 158, 161]
  requires_synthesis: true
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier |
| `question` | string | The question to pose to the memory system |
| `answer` | string | Reference answer for scoring |
| `category` | string | One of the 8 evaluation categories (see below) |
| `difficulty` | string | `easy`, `medium`, or `hard` |
| `relevant_days` | number[] | Day numbers (1-based) containing the answer |
| `requires_synthesis` | boolean | Whether the answer spans multiple memories |

**Evaluation categories:**
`factual-recall`, `temporal-reasoning`, `decision-tracking`, `contradiction-resolution`, `cross-reference`, `recency-bias-resistance`, `synthesis`, `negative-recall`

### Shipped Personas

The benchmark ships with 5 cross-domain personas:

| ID | Role | Domain |
|---|---|---|
| `backend-eng-saas` | Backend Engineer | B2B SaaS platform |
| `er-physician` | Emergency Physician | Urban trauma center |
| `litigation-attorney` | Litigation Attorney | Mid-size law firm |
| `research-scientist` | Research Scientist | University biology lab |
| `financial-advisor` | Financial Advisor | Wealth management firm |

## Implementing a Test Harness

A test harness connects your memory system to Recall Bench. You can implement one in TypeScript (as a JS module) or in any language (via gRPC).

### Option A — TypeScript / JavaScript Module

Export a default object implementing the `MemorySystemAdapter` interface:

```typescript
// my-adapter.ts
import type { MemorySystemAdapter, DayMetadata } from '@recall/bench';

const adapter: MemorySystemAdapter = {
  name: 'My Memory System',

  async setup() {
    // Initialize to a clean state.
    // Called once per (persona × time-range) evaluation.
  },

  async ingestDay(day: number, content: string, metadata: DayMetadata) {
    // Ingest a single day's memory log.
    // Called in chronological order: day 1, day 2, ..., day N.
    //
    // metadata includes:
    //   dayNumber:  number    — same as `day`
    //   date:       string    — synthetic ISO 8601 date
    //   personaId:  string    — persona ID
    //   activeArcs: string[]  — narrative arc IDs active on this day
  },

  async finalizeIngestion() {
    // Signal that all days have been ingested.
    // Run any post-processing (index builds, compaction, etc.) here.
  },

  async query(question: string): Promise<string> {
    // Answer a natural-language question using ingested memories.
    // Return the answer as a string.
  },

  async teardown() {
    // Clean up resources (close connections, delete temp files, etc.).
  },
};

export default adapter;
```

Build and run:

```bash
# Compile your adapter
npx tsc my-adapter.ts --module nodenext --moduleResolution nodenext

# Run the benchmark
npx recall-bench run --adapter ./my-adapter.js --data ./dataset
```

### Option B — gRPC (any language)

Implement the `MemoryBenchService` defined in [`proto/memory_bench_service.proto`](proto/memory_bench_service.proto). This lets you write your adapter in Python, Go, Rust, Java, C#, or any language with gRPC support.

#### Proto Definition

```protobuf
service MemoryBenchService {
    rpc Setup(SetupRequest) returns (SetupResponse);
    rpc IngestDay(IngestDayRequest) returns (IngestDayResponse);
    rpc FinalizeIngestion(FinalizeIngestionRequest) returns (FinalizeIngestionResponse);
    rpc Query(QueryRequest) returns (QueryResponse);
    rpc Teardown(TeardownRequest) returns (TeardownResponse);
    rpc Healthcheck(HealthcheckRequest) returns (HealthcheckResponse);
}
```

The RPCs map 1:1 to the TypeScript `MemorySystemAdapter` interface. The `Healthcheck` RPC is optional — it lets the harness discover your system's name and verify connectivity before the run starts.

#### Key Messages

```protobuf
message IngestDayRequest {
    int32 day_number = 1;       // 1-1000
    string content = 2;         // Markdown content of the day's log
    DayMetadata metadata = 3;
}

message DayMetadata {
    int32 day_number = 1;
    string date = 2;            // ISO 8601 (e.g. "2024-03-15")
    string persona_id = 3;
    repeated string active_arcs = 4;
}

message QueryRequest {
    string question = 1;
}

message QueryResponse {
    string answer = 1;
}

message HealthcheckResponse {
    string name = 1;            // Human-readable system name
    bool ready = 2;
}
```

#### Python Example

```python
import grpc
from concurrent import futures

# Generate stubs: python -m grpc_tools.protoc -I proto --python_out=. --grpc_python_out=. proto/memory_bench_service.proto
import memory_bench_service_pb2 as pb2
import memory_bench_service_pb2_grpc as pb2_grpc

class MyMemorySystem(pb2_grpc.MemoryBenchServiceServicer):
    def Setup(self, request, context):
        # Initialize clean state
        self.memories = {}
        return pb2.SetupResponse()

    def IngestDay(self, request, context):
        self.memories[request.day_number] = request.content
        return pb2.IngestDayResponse()

    def FinalizeIngestion(self, request, context):
        # Build indexes, run compaction, etc.
        return pb2.FinalizeIngestionResponse()

    def Query(self, request, context):
        answer = self._search_and_answer(request.question)
        return pb2.QueryResponse(answer=answer)

    def Teardown(self, request, context):
        self.memories = {}
        return pb2.TeardownResponse()

    def Healthcheck(self, request, context):
        return pb2.HealthcheckResponse(name="My Memory System", ready=True)

    def _search_and_answer(self, question):
        # Your retrieval + generation logic here
        return "..."

server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
pb2_grpc.add_MemoryBenchServiceServicer_to_server(MyMemorySystem(), server)
server.add_insecure_port('[::]:50052')
server.start()
server.wait_for_termination()
```

#### Go Example

```go
package main

import (
    "context"
    "log"
    "net"

    "google.golang.org/grpc"
    pb "your-module/proto"
)

type server struct {
    pb.UnimplementedMemoryBenchServiceServer
    memories map[int32]string
}

func (s *server) Setup(ctx context.Context, req *pb.SetupRequest) (*pb.SetupResponse, error) {
    s.memories = make(map[int32]string)
    return &pb.SetupResponse{}, nil
}

func (s *server) IngestDay(ctx context.Context, req *pb.IngestDayRequest) (*pb.IngestDayResponse, error) {
    s.memories[req.DayNumber] = req.Content
    return &pb.IngestDayResponse{}, nil
}

func (s *server) FinalizeIngestion(ctx context.Context, req *pb.FinalizeIngestionRequest) (*pb.FinalizeIngestionResponse, error) {
    // Build indexes, etc.
    return &pb.FinalizeIngestionResponse{}, nil
}

func (s *server) Query(ctx context.Context, req *pb.QueryRequest) (*pb.QueryResponse, error) {
    answer := searchAndAnswer(s.memories, req.Question)
    return &pb.QueryResponse{Answer: answer}, nil
}

func (s *server) Teardown(ctx context.Context, req *pb.TeardownRequest) (*pb.TeardownResponse, error) {
    s.memories = nil
    return &pb.TeardownResponse{}, nil
}

func (s *server) Healthcheck(ctx context.Context, req *pb.HealthcheckRequest) (*pb.HealthcheckResponse, error) {
    return &pb.HealthcheckResponse{Name: "My Memory System", Ready: true}, nil
}

func main() {
    lis, _ := net.Listen("tcp", ":50052")
    s := grpc.NewServer()
    pb.RegisterMemoryBenchServiceServer(s, &server{})
    log.Fatal(s.Serve(lis))
}
```

#### Running with gRPC

```bash
# Start your gRPC server (any language)
python my_server.py  # or ./my-server, etc.

# Point recall-bench at it
npx recall-bench run \
  --adapter grpc://127.0.0.1:50052 \
  --data ./dataset \
  --ranges 30d,90d,full
```

The default gRPC port is **50052**. Per-RPC timeout defaults to 120 seconds and can be changed with `--grpc-timeout <ms>`.

## Running Tests

### Basic Run

```bash
npx recall-bench run \
  --adapter grpc://127.0.0.1:50052 \
  --data ./personas
```

With no `--ranges` flag, all 5 ranges are evaluated (30d, 90d, 6mo, 1y, full). Each range gets a fresh adapter lifecycle: `setup()` → ingestion → `finalizeIngestion()` → queries → `teardown()`.

### Selecting Personas and Ranges

```bash
# Run only two personas at two ranges
npx recall-bench run \
  --adapter grpc://127.0.0.1:50052 \
  --data ./personas \
  --personas backend-eng-saas er-physician \
  --ranges 30d,full
```

### Output Formats

```bash
# Human-readable text report (default)
npx recall-bench run --adapter ... --data ...

# Machine-readable JSON
npx recall-bench run --adapter ... --data ... --json

# Heatmap grid only (JSON)
npx recall-bench run --adapter ... --data ... --heatmap
```

### Configuring the Judge

The judge model scores each answer on three dimensions:

| Dimension | Scale | Description |
|---|---|---|
| Correctness | 0–3 | Does the answer contain the right information? |
| Completeness | 0–2 | Does the answer include all relevant details? |
| Hallucination | 0–1 | Is the answer free of hallucinated content? (1 = grounded) |

**Composite score** = correctness + completeness + hallucination (max 6).

Provide a judge module that exports a `JudgeModel`:

```typescript
// my-judge.ts
import type { JudgeModel, JudgeScore } from '@recall/bench';

const judge: JudgeModel = {
  async score(question: string, referenceAnswer: string, systemAnswer: string): Promise<JudgeScore> {
    // Call your LLM to compare systemAnswer against referenceAnswer
    return {
      correctness: 3,   // 0-3
      completeness: 2,   // 0-2
      hallucination: 1,  // 0-1
      reasoning: 'Answer matches reference exactly.',
    };
  },
};

export default judge;
```

```bash
npx recall-bench run \
  --adapter ./my-adapter.js \
  --data ./personas \
  --judge ./my-judge.js
```

If no judge is provided, a stub judge is used that returns zero scores (useful for dry-run testing of the adapter).

### All CLI Options for `run`

| Flag | Default | Description |
|---|---|---|
| `--adapter <url\|path>` | required | gRPC URL (`grpc://host:port`) or path to JS adapter module |
| `--data <dir>` | required | Path to dataset directory |
| `--judge <path>` | stub (zero scores) | Path to JS judge module |
| `--personas <ids...>` | all | Persona IDs to benchmark |
| `--ranges <ranges...>` | all 5 | Time ranges: `30d`, `90d`, `6mo`, `1y`, `full` |
| `--seed <n>` | `42` | Shuffle seed for question order (0 = no shuffle) |
| `--timeout <ms>` | `30000` | Per-question timeout |
| `--grpc-timeout <ms>` | `120000` | Per-RPC timeout for gRPC adapter |
| `--parallelism <n>` | `1` | Max concurrent queries |
| `--json` | `false` | Output JSON report |
| `--heatmap` | `false` | Output only the heatmap grid (JSON) |

### Reading Results

**Text report** shows per-persona, per-range scores with category breakdowns:

```
Recall Bench Report — My Memory System
Personas: 5 | Ranges: 30d, 90d, 6mo, 1y, full

───────────────────────────────────────────────────────────
Persona: backend-eng-saas
───────────────────────────────────────────────────────────
  [30d]  Days: 30  | Questions: 35  | Score: 4.80/6.0 (80.0%) | Hallucination: 2.1%
  [full] Days: 1000 | Questions: 210 | Score: 3.90/6.0 (65.0%) | Hallucination: 5.3%
```

**Heatmap** shows how performance degrades across categories as corpus size grows:

```
                              30d     90d     6mo      1y    full
──────────────────────────────────────────────────────────────────
factual-recall                4.8     4.5     4.2     4.0     3.8
temporal-reasoning            3.9     3.7     3.5     3.2     3.0
decision-tracking             5.0     4.8     4.3     4.1     3.9
contradiction-resolution       --      --     3.1     2.8     2.5
```

Cells show `--` when fewer than 3 eligible Q&A pairs exist for that combination.

## Programmatic API

All harness functionality is available as a library:

```typescript
import {
  BenchmarkHarness,
  formatTextReport,
  toHeatmapGrid,
  loadPersona,
  filterQAByRange,
  listPersonas,
} from '@recall/bench';
import type { MemorySystemAdapter, JudgeModel, HarnessConfig } from '@recall/bench';

// Set up your adapter and judge
const adapter: MemorySystemAdapter = { /* ... */ };
const judge: JudgeModel = { /* ... */ };

// Run the full benchmark
const harness = new BenchmarkHarness(adapter, judge, './dataset', {
  personas: ['backend-eng-saas'],
  ranges: ['30d', 'full'],
  shuffleSeed: 42,
  questionTimeoutMs: 30000,
  parallelism: 1,
});

const result = await harness.run();
console.log(formatTextReport(result));

// Or run a single persona + range
const rangeResult = await harness.runSingleRange('backend-eng-saas', '30d');
```

## Time Ranges

The benchmark supports subsetting the corpus to measure how performance changes with scale:

| Key | Days Ingested | Description |
|---|---|---|
| `30d` | 1–30 | Short-term recall |
| `90d` | 1–90 | Quarter-scale recall |
| `6mo` | 1–180 | Half-year recall |
| `1y` | 1–365 | Full-year recall |
| `full` | 1–1000 | Complete corpus |

Each range gets a **fresh** adapter lifecycle — the adapter is set up, ingests only the days in range, runs queries, and tears down. Q&A pairs are filtered so only questions whose `relevant_days` all fall within the cutoff are evaluated.

## License

MIT
