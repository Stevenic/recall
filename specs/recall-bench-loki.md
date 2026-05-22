# Recall Bench — Loki Adapter Spec

**Status:** Draft
**Author:** stevenic
**Date:** 2026-05-22
**Version:** 0.2
**Spec:** [recall-bench.md](./recall-bench.md) (v0.5)

---

## 1. Overview

This spec defines the work to evaluate **Loki** — the .NET memory service in `C:\source\Asgard` — under Recall Bench. The end state is a single command:

```
recall-bench run --profile profiles/ea-180d-loki.yaml
```

…that ingests a persona's 1,000-day corpus into a fresh Loki instance and scores recall using the canonical Q&A pairs.

The work splits cleanly across two repos:

1. **`recall` repo (TypeScript)** — Add a **Pass 3 tool-call generator** that converts each day's memory log into a YAML file of `memorySave` invocations the agent *would* have emitted. The format is already prototyped at `packages/recall-bench/personas/executive-assistant/tools-180d/day-0001.yaml`.
2. **`Asgard` repo (C#)** — Build a **Loki adapter** that implements `recall.bench.MemoryBenchService` (existing gRPC contract), spawns Loki on a fresh synthetic AAD identity, and replays the tool-call YAML verbatim during ingest.

The split matters because corpus-shape decisions belong in `recall-bench` (one source of truth across adapters) and Loki-spawn / auth decisions belong in `Asgard` (where the service lives).

### Goals

1. **Honest measurement.** Ingest exercises Loki through its production GraphQL surface (`memorySave` / `memoryDelete` / `memoryDeleteAll`; `memories(prompt, limit)` / `memory(id)`) with real AAD auth.
2. **Atomic ingest from a canonical source.** Each `memorySave` represents one durable fact / decision / preference / milestone — what an agent backed by Loki would actually save — sourced from a generated YAML, not from ad-hoc adapter splitting.
3. **Plug-and-play.** Loki participates via the same harness, personas, judge, and reporting flow as the in-process Recall adapter and the OpenClaw adapter.
4. **Reproducible.** Each run spins up a fresh Loki against a synthetic AAD identity so persona corpora never collide and no manual cleanup is needed.
5. **Asgard-owned adapter.** Adapter code lives next to Loki so it ships and tests with the service.

### Non-Goals (v0.1)

- Measuring Loki's ingestion throughput, latency budget, or cost — Recall Bench only scores query quality.
- Group-session attribution / information-boundary categories — Loki's store is scoped per-user with no per-session ACL. Run with `groupsEnabled: false`; those heatmap rows stay gray.
- Wiring Loki to a production Cosmos DB tenant — adapter assumes dev defaults (lokidev, dev Annotation Store, synthetic AAD identities).
- The "agent" answer mode (LLM drives `memory_search` / `memory_get` as tools). Ships in v0.2 once synthesis baseline is stable.

---

## 2. Architecture

```
recall repo                                 │  Asgard repo
                                            │
┌──────────────────────────────────────┐    │   ┌──────────────────────────────┐
│  recall-bench generate-tool-calls    │    │   │  Microsoft.Loki              │
│  (Pass 3 generator, TypeScript)      │    │   │  .RecallBench.Adapter.exe    │
│  ─ reads memories-NNNd/day-XXXX.md   │    │   │  ─ gRPC server :50053        │
│  ─ writes tools-NNNd/day-XXXX.yaml   │    │   │  ─ spawns Loki child process │
└──────────────────────────────────────┘    │   │  ─ DAT auth + GraphQL client │
                  │                         │   └──────────────┬───────────────┘
                  ▼                         │                  │
┌──────────────────────────────────────┐    │                  ▼
│  personas/<id>/tools-NNNd/           │    │   ┌──────────────────────────────┐
│    day-0001.yaml  ──┐                │    │   │  Microsoft.Loki.Service       │
│    day-0002.yaml    │  (canonical    │    │   │  (ASP.NET, GraphQL @ :5001)   │
│    ...              │   ingest       │    │   │  ─ Cosmos: lokidev            │
└─────────────────────┼─────────────────┘   │   └──────────────────────────────┘
                      │                      │
                      ▼                      │
┌──────────────────────────────────────┐    │
│  recall-bench run (TypeScript CLI)   │    │
│  ─ GrpcMemoryAdapter                 │────┘  gRPC :50053
│  ─ for each day:                     │      ─────────────▶
│      send calls[] over IngestDay     │
│  ─ Query → judge → report            │
└──────────────────────────────────────┘
```

The harness already supports gRPC adapters (`packages/recall-bench/src/grpc-memory-adapter.ts` + `proto/memory_bench_service.proto`). The Loki adapter is a gRPC server that implements that proto in C#, so it can use existing Asgard libraries (Loki GraphQL client, DAT, ASP.NET hosting) directly.

**Process boundaries.**

1. **Node harness** — `recall-bench` CLI on the user's machine. Loads the profile, instantiates `GrpcMemoryAdapter`, talks gRPC to the adapter.
2. **Adapter process** — `Microsoft.Loki.RecallBench.Adapter` (new project, Asgard). Owns the lifecycle of the Loki service, replays tool-call YAML through Loki's GraphQL, synthesizes answers via an Azure/OpenAI model.
3. **Loki service** — `Microsoft.Loki.Service` (existing). Started by the adapter on a free port; talks to Cosmos and Annotation Store with dev credentials.

For fast inner-loop development the adapter can be run in-process with Loki (skipping the child-process step). v0.1 default is the two-process model.

---

## 3. Pass 3 — Tool-Call Generator

The generator lives in `packages/recall-bench/` and ships as a new CLI subcommand `recall-bench generate-tool-calls`. It runs after Pass 1 (memories) and Pass 2 (conversations), and is independent of any specific memory system — every adapter that exposes a `memorySave`-shaped call (Loki, OpenClaw, recall-with-tools) can consume the same output.

### 3.1 Output schema

One YAML file per day at `personas/<id>/tools-NNNd/day-NNNN.yaml`:

```yaml
day: 1
date: 2026-01-01
day_of_week: Thursday
persona: executive-assistant

calls:
  - session: principal
    tool: memorySave
    content: |
      Jamie Park's morning briefing preference (provisional baseline,
      established at onboarding 2026-01-01): 7:00 AM weekday Teams DM.
      Flagged as provisional — I'll validate against her actual morning
      behavior in live use and correct if she pushes back.

  - session: principal
    tool: memorySave
    content: |
      Jamie's calendar discipline rules captured at onboarding: ...

  - session: project-condor
    tool: memorySave
    content: |
      Project Condor (bolt-on M&A acquisition) kicked off 2026-01-01. ...
```

The exemplar at `personas/executive-assistant/tools-180d/day-0001.yaml` is the canonical reference. Schema rules (lifted from that file's header comments):

- **`content` is plain free-text** — Loki's own extractor classifies and stores it. No structure inside `content` beyond what an agent would naturally write.
- **One call per durable item** — facts, preferences, decisions, hard rules, status milestones. Process narrative ("I opened the thread", "I documented the cadence") is **not** saved.
- **Session attribution is authoritative** — `session` matches a `# session: <id>` from the day's memory log, or `internal` for pre-H1 narration that nonetheless captures a durable fact (rare).
- **Calendar voice** — `content` references real dates ("2026-01-01", "by end of January", "in Q1"), never arc-day numbers or simulation bookkeeping. The agent doesn't know it lives inside a bounded corpus.
- **Order within `calls[]` is significant** — the harness replays in order, simulating the agent's intra-day save sequence.

### 3.2 CLI

```
recall-bench generate-tool-calls \
  --persona ./packages/recall-bench/personas/executive-assistant \
  --model azure:gpt-5.4-mini \
  --memories-dir memories-180d \
  --tools-dir tools-180d \
  --start 1 --end 180
```

Flags follow the convention already set by `generate-conversations`:

| Flag | Default | Notes |
|---|---|---|
| `--persona <dir>` | required | Persona directory (must contain `persona.yaml` + memories dir) |
| `--model <spec>` | required | CLI agent name, OpenAI/Azure/Anthropic spec, or JS module path |
| `--memories-dir <name>` | derived from `--arcs` suffix or `memories-1000d` | Input dir |
| `--tools-dir <name>` | derived (`memories-180d` → `tools-180d`) | Output dir |
| `--start <n>` / `--end <n>` | 1 / 1000 | Range to generate |
| `--days <n>` | — | Shorthand for `--start 1 --end <n>` |
| `--temperature <n>` | 0.7 | Generation temperature |
| `--max-tokens <n>` | 4000 | Per-day output budget |
| `--timeout <ms>` | 120000 | Per-call timeout |
| `--json` | false | JSON summary instead of progress text |

### 3.3 Generator prompt (sketch)

System prompt:

> You are converting a persona agent's daily memory log into the **tool calls** that agent would have made into a long-term memory store. The store has one tool: `memorySave(content: string)`. Each call captures **one durable item** — a fact, preference, decision, hard rule, or status milestone — that the agent would want to recall on a future day.
>
> Rules:
>
> 1. Only durable items. Process narrative ("I opened the thread", "I documented the cadence") is NOT saved.
> 2. One `memorySave` per atomic item. Do not pack multiple unrelated facts into one call.
> 3. Attribute each call to a session (`session: <id>`). Use the `# session: <id>` H1 the item lives under in the memory log. Pre-H1 internal narration is rare for durable items; use `session: internal` only when unavoidable.
> 4. Content uses real calendar dates ("2026-01-01", "by end of January"), never arc-day numbers. Write in the agent's own first-person voice, as the agent saving for its own future use.
> 5. Output YAML matching this schema exactly: `day`, `date`, `day_of_week`, `persona`, `calls: [{ session, tool: memorySave, content }]`. Output ONLY the YAML body — no markdown fences, no commentary.

User-message context per day:
- Persona profile (name, role, domain, communication style)
- Day number + calendar date + day-of-week
- The full memory log for that day (`memories-NNNd/day-NNNN.md`)
- The previous 1–2 days' tool calls (for voice continuity)

Implementation reuses the existing `GeneratorModel` abstraction and matches the structure of `conversation-generator.ts`.

### 3.4 Validation

Generated files are checked at write time for:

- Valid YAML.
- Required top-level keys (`day`, `date`, `persona`, `calls`).
- Each call has `session`, `tool`, `content`; `tool` is exactly `memorySave` (the only tool in v0.1).
- `content` is non-empty, no markdown fences, no day-number references (regex `day[- ]\d+`).
- Sessions referenced in `calls[]` are declared in `persona.yaml`.

Malformed days are written to a sidecar `tools-NNNd/day-NNNN.errors.yaml` for inspection rather than failing the whole run.

---

## 4. Adapter Ingest Strategy

Because Pass 3 has already produced the canonical save sequence, the Loki adapter's ingest path is mechanical:

For each `ingestDay(day, content, metadata)` the harness calls into the adapter:

1. **Locate the tool-call file.** The harness passes the persona dir + `--tools-dir` name through the profile; the adapter receives the YAML body via gRPC (see §4.1). The adapter does not look at `content` (the markdown day log) at all — it's only there for adapters that don't speak tool calls.
2. **Replay calls in order.** For each entry in `calls[]`:
   - Build the GraphQL mutation `memorySave(input: { content })`. (v0.1 sends one call per network round-trip; can batch later if cost becomes a concern.)
   - Add the synthetic auth headers (bearer token + `X-On-Behalf-Of: <synthetic-aadObjectId>`; see §6.2).
   - Send to the running Loki at `https://localhost:$LOKI_PORT/api/v2/graphql`.
   - Capture the returned memory IDs into a per-run side log keyed by `(day, callIndex, session)` for failure analysis.
3. **No splitting.** The adapter does not chunk, paragraph-split, or reformat `content`. Whatever Pass 3 wrote is what Loki sees.

The session label travels in the YAML but is not currently passed to Loki — Loki has no per-session storage in v0.1. The label is preserved in the adapter's side log so post-hoc analysis can attribute Loki's retrieval errors to specific sessions.

### 4.1 Proto extension

The current `IngestDayRequest` carries `day_number`, `content`, and `metadata`. To pass tool-call YAML cleanly, we extend `DayMetadata` with an optional `tool_calls` field:

```proto
message DayMetadata {
    int32 day_number = 1;
    string date = 2;
    string persona_id = 3;
    repeated string active_arcs = 4;

    // Pass 3 output: the tool calls the agent would have made on this day.
    // When present, adapters that speak tool calls SHOULD use this and ignore
    // `content`. When absent, fall back to ingesting `content`.
    repeated ToolCall tool_calls = 5;
}

message ToolCall {
    string session = 1;        // session id, e.g. "principal"
    string tool = 2;           // "memorySave" in v0.1
    string content = 3;        // free-text payload for the tool
}
```

The Node harness fills `tool_calls` by reading `tools-NNNd/day-NNNN.yaml` when present; if the file is missing, the field is empty and existing adapters (Recall, OpenClaw) continue to ingest from `content` unchanged.

This is a backward-compatible field addition. Existing adapters that don't read `tool_calls` keep working.

---

## 5. Query / Answer Synthesis

Loki is **retrieval-only**: `memories(prompt: "...", limit: N)` returns ranked `Memory` objects but never an answer string. The adapter mirrors the Recall adapter's retrieve-then-synthesize pattern (`bench-harnesses/recall/src/index.ts:182`):

1. Run `memories(prompt: question, limit: searchK)` against Loki. Default `searchK = 8`.
2. Concatenate returned `content` fields into a prompt-sized excerpt block (default budget 8000 chars, drop lowest-ranked first).
3. Call Azure / OpenAI / Anthropic per config with:
   - System prompt: same answer-from-excerpts prompt the Recall adapter uses (`bench-harnesses/recall/src/index.ts:115`).
   - User prompt: `Question: <q>\n\nMemory excerpts:\n<excerpts>\n\nAnswer:`.
4. Return model text as the adapter's answer; surface retrieval entries through the optional `QueryDetail` for the harness's failure log.

**Why not agent mode in v0.1?** Wiring tool-calling against Loki's GraphQL (`memory_search` → `memories`, `memory_get` → `memory`) is straightforward but doubles the surface area we have to validate. Baseline with synthesis mode (parity with Recall adapter), confirm Loki numbers look sane, then layer agent mode in v0.2.

---

## 6. Connection & Lifecycle

### 6.1 Spawning Loki

`Setup` RPC performs:

1. Pick a free port pair for HTTP / HTTPS.
2. Generate a fresh synthetic `aadObjectId` (GUID v4) and the fixed dev `tenantId`.
3. Launch `dotnet run --project src/services/loki/Microsoft.Loki.Service` with:
   - `ASPNETCORE_URLS=http://localhost:$LOKI_HTTP_PORT;https://localhost:$LOKI_HTTPS_PORT`
   - any required dev flags (e.g., `LOKI_BENCH_MODE=1` if we end up adding one) so Redis / Service Bus / anomaly detection are short-circuited.
4. Poll `/health` (or a trivial `__typename` GraphQL query) until healthy or a 60 s budget expires.
5. Call `memoryDeleteAll` against the new synthetic identity for belt-and-suspenders cleanup.

`Teardown` sends `SIGTERM`, waits up to 10 s, then `SIGKILL`s. Temp dirs (logs, identity dumps) are removed.

### 6.2 Auth — DAT token + synthetic identity

Loki requires `Authorization: Bearer <AAD-token>`. v0.1 reuses the developer auth tool (DAT) the team already runs:

- Adapter shells out to DAT (path via `$ASGARD_DAT_PATH`, sane default), parses token + expiry from stdout.
- Token cached; refreshed when within 5 minutes of expiry.
- Synthetic `aadObjectId` is propagated via `X-On-Behalf-Of` (or whatever Loki's `IIncomingRequestContext` honors in dev — confirmed during Phase 1 spike).

Fallback paths if Loki rejects spoofed identity in dev:
- Add a Loki dev-mode flag that trusts `X-Bench-User: <guid>`.
- Pre-provision N synthetic AAD accounts and rotate.

### 6.3 Per-run isolation

The synthetic `aadObjectId` is the isolation unit. Loki's Cosmos partition key is `/tenantId/aadObjectId`, so each run is a brand-new partition with no carryover. `memoryDeleteAll` at setup is belt-and-suspenders.

`FinalizeIngestion` is a no-op on Loki's side (no compaction phase). The adapter implements it idempotently per the harness contract.

---

## 7. Configuration

Recall Bench profile (lives in `recall` repo):

```yaml
# packages/recall-bench/profiles/ea-180d-loki.yaml
persona:
  id: executive-assistant
  dir: ../personas/executive-assistant
  arcs: arcs-180d.yaml
  toolsDir: tools-180d        # NEW — tells the harness to load Pass 3 YAML

env:
  file: ../../../.env

models:
  judge: azure:gpt-5.4-mini
  appellateJudge: azure:gpt-5.4
  generation: azure:gpt-5.4-mini

harness:
  # Adapter binary started separately by tools/recall-bench-loki/run.ps1.
  adapter: grpc://127.0.0.1:50053

run:
  ranges:
    start: 6
    end: 180
    step: 6
  seed: 42
  timeout: 60000
  parallelism: 1
  sample: 50
  judgeMemoryWindow: 1
  groupsEnabled: false        # Loki has no per-session ACL in v0.1
```

Adapter binary config (lives in Asgard, alongside the project):

```json
{
  "Name": "Loki",
  "GrpcPort": 50053,
  "Loki": {
    "ProjectPath": "src/services/loki/Microsoft.Loki.Service",
    "HealthTimeoutSeconds": 60,
    "Cosmos": "lokidev",
    "TenantId": "<dev-tenant-guid>"
  },
  "Auth": {
    "DatPath": "tools/dat/dat.exe",
    "TokenRefreshSkewSeconds": 300
  },
  "Synthesis": {
    "Provider": "azure",
    "Model": "gpt-5.4-mini",
    "SearchK": 8,
    "ContextBudget": 8000
  }
}
```

A wrapper script (`tools/recall-bench-loki/run.ps1`) starts the adapter binary, then the Node harness, in the right order.

---

## 8. Project Layout

### 8.1 recall repo (TypeScript)

```
recall/
├── packages/
│   └── recall-bench/
│       ├── src/
│       │   ├── cli.ts                              # add: generate-tool-calls command
│       │   ├── tool-call-generator.ts              # NEW — Pass 3 generator
│       │   ├── generator-types.ts                  # add: ToolCallFile, ToolCallEntry types
│       │   ├── dataset.ts                          # add: loadToolCalls(personaDir, toolsDir, day)
│       │   └── grpc-memory-adapter.ts              # add: include tool_calls in IngestDayRequest
│       ├── proto/
│       │   └── memory_bench_service.proto          # add: ToolCall, DayMetadata.tool_calls
│       ├── profiles/
│       │   └── ea-180d-loki.yaml                   # NEW
│       └── personas/
│           └── executive-assistant/
│               └── tools-180d/                     # populated by Pass 3
│                   ├── day-0001.yaml               # existing exemplar
│                   ├── day-0002.yaml               # generated
│                   └── ...
└── specs/
    └── recall-bench-loki.md                        # this file
```

### 8.2 Asgard repo (C#)

```
Asgard/
└── tools/
    └── recall-bench/
        └── Microsoft.Loki.RecallBench.Adapter/
            ├── Microsoft.Loki.RecallBench.Adapter.csproj
            ├── Program.cs                          # host bootstrap, gRPC server
            ├── MemoryBenchService.cs               # gRPC service impl
            ├── LokiProcessHost.cs                  # spawn / health / teardown
            ├── LokiGraphQlClient.cs                # GraphQL wrappers
            ├── DatTokenProvider.cs                 # DAT shell-out + caching
            ├── SynthesisClient.cs                  # Azure/OpenAI answer call
            ├── proto/
            │   └── memory_bench_service.proto      # copied at build from recall (SHA pinned)
            ├── appsettings.recall-bench.json
            └── tests/
                └── Microsoft.Loki.RecallBench.Adapter.Tests/
```

The canonical proto lives in `recall/packages/recall-bench/proto/memory_bench_service.proto`. The adapter copies it via an msbuild task at build time; a CI check pins the SHA to the canonical version so the two stay in sync.

---

## 9. Work Breakdown

### Phase 0 — Pass 3 generator (recall repo, ~2 days)

1. Define `ToolCallFile` / `ToolCallEntry` types in `generator-types.ts`.
2. Implement `tool-call-generator.ts` mirroring `conversation-generator.ts`.
3. Wire `recall-bench generate-tool-calls` subcommand in `cli.ts`.
4. Write the system + user prompts (§3.3); seed against the hand-authored day-0001 to anchor voice.
5. Validation pass — schema checks, malformed-day sidecar (§3.4).
6. Smoke: regenerate `tools-180d/day-0001.yaml` from the existing memory log; eyeball-compare against the hand-authored exemplar; iterate on prompt until structurally equivalent.
7. Acceptance: `recall-bench generate-tool-calls --days 10` produces 10 valid YAML files for the executive-assistant persona that pass §3.4 validation.

### Phase 1 — Proto + harness wiring (recall repo, ~1 day)

1. Extend `memory_bench_service.proto` with `ToolCall` + `DayMetadata.tool_calls` (§4.1).
2. Update `GrpcMemoryAdapter.ingestDay` to read `tools-<suffix>/day-NNNN.yaml` when `toolsDir` is set in the persona profile and stuff it into `metadata.tool_calls`.
3. Confirm backward compat — Recall and OpenClaw adapters ignore the new field and still ingest from `content`.
4. Acceptance: end-to-end run with the Recall adapter against the executive-assistant persona produces identical scores before and after the proto change (no regressions from the wire schema bump).

### Phase 2 — Loki adapter spike (Asgard, ~3 days)

1. Stand up `Microsoft.Loki.RecallBench.Adapter` skeleton — `Program.cs`, gRPC server, `Healthcheck` RPC only.
2. Spike: from C#, start `Microsoft.Loki.Service` as a child process, wait for healthy, call `memorySave` and `memories` with a DAT-issued token, tear down.
3. Resolve auth: confirm `X-On-Behalf-Of` works in dev, or fall back to a `LOKI_BENCH_MODE` flag. Document the decision.
4. Acceptance: `dotnet run` against the spike ingests one synthetic day's tool-call YAML (provided as a fixture) and retrieves a relevant memory.

### Phase 3 — Adapter implementation (Asgard, ~4 days)

1. `LokiProcessHost` — spawn, health-poll, teardown, port allocation, log capture.
2. `LokiGraphQlClient` — typed wrappers for `memorySave`, `memoryDelete`, `memoryDeleteAll`, `memories`, `memory`.
3. `DatTokenProvider` — shell out, parse, cache with skew refresh.
4. `MemoryBenchService` — implement the six RPCs against the above. `IngestDay` replays `tool_calls[]` in order (no markdown parsing).
5. `SynthesisClient` — Azure OpenAI client for answer synthesis.
6. Local smoke: run a 5-day persona slice end-to-end, score with the harness.

### Phase 4 — Profile + plumbing (recall repo, ~1 day)

1. Add `packages/recall-bench/profiles/ea-180d-loki.yaml`.
2. Write `tools/recall-bench-loki/run.ps1` (Asgard) that starts the adapter binary then invokes `recall-bench run --profile ...`.
3. README in the adapter project covering local prerequisites (DAT, Cosmos access).

### Phase 5 — Validation run (~2 days)

1. Regenerate the full `tools-180d/` for the executive-assistant persona using Phase 0's generator.
2. Run `ea-180d-loki.yaml` against the full 180-day corpus.
3. Compare heatmaps against `ea-180d-recall-baseline.yaml` and the OpenClaw run.
4. File issues for any category where Loki under/over-performs unexpectedly. Capture in a results-summary doc.

### Phase 6 — Stretch (v0.2, optional)

1. Agent answer mode — tool-calling loop with `memory_search` / `memory_get` against Loki, mirroring real EA usage.
2. CI job that runs a 30-day smoke profile (`ea-30d-loki.yaml`) on each Loki PR.
3. Pass 3 generator extended for other personas (research-scientist, financial-advisor, etc.) — currently EA-only.

**Total estimate:** ~13 days for v0.1, sequenced as Phase 0 → 1 (recall) // Phase 2 (Asgard spike) → 3 → 4 → 5. Phases 0–1 and Phase 2 can run in parallel after the schema is agreed.

---

## 10. Open Questions

1. **Auth spoofing in dev.** Will Loki's `IIncomingRequestContext` accept a spoofed `aadObjectId` against a DAT token, or do we need a Loki dev-mode shim? _Resolved in Phase 2._
2. **Pass 3 prompt quality.** The hand-authored `day-0001.yaml` is dense and well-judged. Can an LLM hit that bar consistently on a $0.001–$0.01 per-day budget, or do we need a stronger model + manual review for v0.1? _Measured during Phase 0 smoke._
3. **Cosmos provisioning.** Does running 30 bench checkpoints against `lokidev-cosmosdb` blow the RU budget? Measure during Phase 5; possibly request a dedicated container.
4. **Synthesis model parity.** Should the Loki adapter default to the same model the Recall adapter uses (`openai:gpt-4o-mini`) for apples-to-apples comparison, or to whatever Loki's production EA actually uses? _Recommendation: configurable, default to Recall baseline for comparison clarity._
5. **Service teardown reliability.** Killing a Cosmos-connected ASP.NET process leaves sockets in TIME_WAIT. Verify 30+ spawn/teardown cycles in one bench run don't exhaust ports or hit Cosmos throttling.
6. **Tool-call generator scope.** Should Pass 3 generate for all personas in this scope of work, or only EA? _Recommendation: EA-only for v0.1; other personas as Phase 6 once the prompt is calibrated._

---

## 11. Success Criteria

The work is ready to ship when:

- [ ] `recall-bench generate-tool-calls --persona ./personas/executive-assistant --model azure:gpt-5.4-mini --days 180` produces 180 valid YAML files passing §3.4 validation.
- [ ] A spot-check of 20 generated days shows tool-call selection matching the durable-vs-narrative heuristic from the hand-authored exemplar (manual review).
- [ ] `recall-bench run --profile ea-180d-loki.yaml` completes end-to-end without manual intervention beyond `az login` / DAT sign-in.
- [ ] Each checkpoint runs against a fresh synthetic `aadObjectId` with no cross-run contamination (verified by re-running the same profile twice and getting structurally identical results).
- [ ] Setup→ingest→query→teardown completes within 1.5× the wall time of the Recall in-process adapter on the same persona slice.
- [ ] The full 180-day executive-assistant persona produces a heatmap whose categories (excluding the two group-aware rows) are within the same order of magnitude as the Recall baseline — no order-of-magnitude regressions that point at adapter bugs rather than Loki recall quality.
- [ ] All six gRPC RPCs are covered by C# unit tests against a stubbed `LokiGraphQlClient`.
- [ ] Existing adapter runs (Recall, OpenClaw) score identically before and after the proto extension — backward compatibility verified.

---

## Changelog

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-05-22 | Initial draft — adapter splits markdown day files into paragraph-level `memorySave` calls; spawns Loki via `dotnet run`; DAT auth; synthetic AAD object ID per run. |
| 0.2 | 2026-05-22 | **Reshaped around a Pass 3 tool-call generator.** Adapter no longer splits markdown — it replays canonical tool-call YAML produced by `recall-bench generate-tool-calls`. Added §3 (Pass 3 generator: schema, CLI, prompt sketch, validation), §4.1 (proto extension for `tool_calls`), §8.1 / §8.2 split (recall repo vs Asgard work), new Phase 0 / Phase 1 / Phase 4 in §9. Open question on prompt quality (Q2). Acceptance bullet added for generator validation. |
