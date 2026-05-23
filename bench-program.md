# Bench Program — Operating Recall Bench

This document tells a coding agent how to operate Recall Bench end-to-end: create personas, generate the dataset, run the benchmark, manage long-running jobs, and recover the artifacts. It is the canonical operator's playbook for the `recall-bench` CLI.

Read top-to-bottom on first use; afterwards, jump to the workflow you need.

---

## What Recall Bench is

Recall Bench evaluates an **agent memory system** by ingesting 1,000 days of synthetic agent memories and scoring how well the system answers Q&A pairs about that history. The full design is in `specs/recall-bench.md`; the implementation is in `packages/recall-bench/`.

The agent's job is normally one of:

1. **Author or refresh a persona** — create the persona file, the arcs file, and the day-by-day corpus.
2. **Run a benchmark** — point the harness at a profile, monitor progress, recover artifacts.
3. **Compare results** — render heatmaps, diff against a baseline, inspect failure logs.

All work flows through `recall-bench <subcommand>`. There is no GUI and no hidden state; every artifact lives in a file you can read.

---

## Mental model: the generation pipeline

```
   persona.yaml  +  arcs-NNNd.yaml
        │              │
        └──────┬───────┘
               ▼
   Pass 1: generate          ──→  memories-NNNd/day-XXXX.md       (the agent's daily log)
               │
               ▼
   Pass 2: generate-conversations  ──→  conversations-NNNd/conv-XXXX.{md,json}
               │                                                   (the user↔agent turns
               ▼                                                    that produced the log)
   Pass 3: generate-tool-calls    ──→  tools-NNNd/day-XXXX.yaml   (memorySave calls the agent
               │                                                    would have emitted)
               ▼
   Pass 4: generate-qa            ──→  qa-NNNd/<category>/*.yaml   (Q&A pairs that grade
                                                                    the memory system)
```

Then the harness drives a memory system adapter through:

```
   bench profile (YAML)  +  adapter (gRPC or JS module from bench-harnesses/)
        │
        ▼
   recall-bench run     ──→  bench-results/{drafts|<system>}/<run-id>/
                                ├── result.json
                                ├── progress.jsonl
                                ├── failures.jsonl
                                └── heatmap.png
```

Each pass is independent: regenerate any pass without redoing the prior ones.

**Suffix convention.** A persona may host multiple stories of different lengths. Each story is anchored by an arcs file named `arcs-<NNN>d.yaml` (`arcs-180d.yaml`, `arcs-1000d.yaml`, etc.). Every downstream artifact directory mirrors the suffix: `memories-180d/`, `conversations-180d/`, `tools-180d/`, `qa-180d/`. The CLI derives the directory names automatically when you pass `--arcs`. Do not invent custom suffixes; use the arcs file as the source of truth.

---

## Workflow: starting from a blank persona

The linear A-to-Z, when there's nothing in the persona dir yet:

```bash
# 1. Author persona.yaml + arcs-1000d.yaml from a free-text description.
recall-bench create-persona \
  --prompt "An emergency physician working night shifts at a level-1 trauma center..." \
  --persona ./packages/recall-bench/personas/er-physician \
  --model azure:gpt-5.4

# 2. Hand-edit persona.yaml and arcs-1000d.yaml as needed (sessions, cast, sharedKnowledge,
#    arc primarySession assignments). create-persona gives you a draft, not a finished product.

# 3. Generate the daily memory corpus.
recall-bench generate \
  --persona ./packages/recall-bench/personas/er-physician \
  --model claude \
  --start 1 --end 180

# 4. Generate Pass 2 / Pass 3 / Pass 4 artifacts (see workflows below). Order is independent —
#    Pass 4 (Q&A) only needs the memories; Pass 2 and Pass 3 are siblings.
```

For a persona that already exists with a different arcs file, skip step 1 and pass `--arcs` to the downstream commands.

---

## Workflow: create a persona

```bash
recall-bench create-persona \
  --prompt "<one-paragraph description of the role, domain, and challenge>" \
  --persona ./packages/recall-bench/personas/<id> \
  --model azure:gpt-5.4 \
  [--epoch 2026-01-01]                # default 2024-01-01; rarely set here
```

Produces `persona.yaml` + `arcs-1000d.yaml`. Both are drafts — the cast list, session topology, and arc directives almost always need a manual pass. Hand-editing rules of thumb:

- The `sessions:` block in `persona.yaml` declares the conversation surfaces — `principal` is the only reserved slug.
- The `sharedKnowledge:` block holds non-sensitive global facts the agent can reference from any session.
- Each arc in `arcs-1000d.yaml` should declare a `primarySession`. Echoes go in `referencedSessions[]`. The 65/35 split (principal vs. group) lives in `specs/recall-bench.md` §2.7.
- Epoch lives in the **arcs file**, not the persona file — different stories of the same persona anchor differently.

To re-generate arcs only against an existing persona, pass `--arcs-only`.

---

## Workflow: generate the memory corpus (Pass 1)

```bash
recall-bench generate \
  --persona ./packages/recall-bench/personas/<id> \
  --model claude \
  [--arcs arcs-180d.yaml] \
  --start 1 --end 180
```

Produces `memories-NNNd/day-XXXX.md` (multi-session markdown per `specs/recall-bench.md` §4.7). Files are written incrementally; re-running with the same `--start` overwrites those days. Resume by setting `--start` to the next missing day.

This is the longest pass — expect minutes per day on dense personas. Use the **background-task pattern** (see below) for anything over ~30 days. The `--model claude` selector spawns the local `claude` CLI; `azure:gpt-5.4` or `openai:gpt-5.4` go via API.

Useful flags:

| Flag | Use |
|---|---|
| `--days N` | Shorthand for `--start 1 --end N` |
| `--timeout <ms>` | Per-call timeout; default 600s for CLI agents. Lower it (~300s) to fail fast on hangs. |
| `--temperature <n>` | Default 0.7. Don't go below 0.4 — the day-generator needs some variety. |

---

## Workflow: generate conversations (Pass 2)

Optional. Used by benches that ingest dialog turns instead of (or in addition to) the agent's narration.

```bash
recall-bench generate-conversations \
  --persona ./packages/recall-bench/personas/<id> \
  --model azure:gpt-5.4 \
  --memories-dir memories-180d \
  --start 1 --end 180
```

Each `day-XXXX.md` is converted into a `conv-XXXX.{md,json}` of user ↔ assistant turns consistent with that day's log. Independent of Pass 1 once the memories exist.

---

## Workflow: generate tool calls (Pass 3)

For memory systems that expose a `memorySave(content)`-shaped API (Loki, OpenClaw, recall-with-tools). Each day becomes a YAML file of the **canonical save sequence** the agent would have emitted on that day — atomic items only, session-attributed, calendar-voiced.

```bash
recall-bench generate-tool-calls \
  --persona ./packages/recall-bench/personas/<id> \
  --model azure:gpt-5.4 \
  --arcs arcs-180d.yaml \
  --days 180
```

`--arcs` is the source of truth for the epoch; the date in each YAML file is computed from it. Outputs land in `tools-NNNd/day-XXXX.yaml`. The hand-authored `personas/executive-assistant/tools-180d/day-0001.yaml` is the reference for shape and voice.

Default behavior **skips existing files**. Pass `--overwrite` for a clean regen.

---

## Workflow: generate Q&A pairs (Pass 4)

```bash
# Standard mode — questions that grade ordinary recall (factual, temporal, decision-tracking, etc.)
recall-bench generate-qa \
  --persona ./packages/recall-bench/personas/<id> \
  --model azure:gpt-5.4 \
  --arcs arcs-180d.yaml

# Boundary mode — information-disclosure probes for isolated sessions
recall-bench generate-qa \
  --persona ./packages/recall-bench/personas/<id> \
  --model azure:gpt-5.4 \
  --arcs arcs-180d.yaml \
  --mode boundary \
  --query-session principal
```

Generates incrementally in checkpoint windows. Resume-safe — re-running picks up where it left off. Output lands in `qa-NNNd/<category>/*.yaml`.

Boundary mode is only meaningful for personas with isolated sessions (Litigation Attorney, Financial Advisor, Executive Assistant in v1).

---

## Workflow: run the benchmark

Before invoking the CLI: open the profile, read its `harness.adapter:` value, and if it resolves into `bench-harnesses/<system>/`, open that package's `harness-program.md` and follow it through to the "point the profile at the dist" step. Skip this only for harnesses with no such file (e.g., `bench-harnesses/recall/`, which builds in place).

The minimum:

```bash
recall-bench run \
  --profile packages/recall-bench/profiles/<name>.yaml \
  --json-out bench-results/drafts/<run-id>/result.json
```

The profile bundles persona, adapter, judge models, ranges, sampling, and timeouts. Use the existing profiles (`ea-180d-vector.yaml`, `ea-180d-openclaw.yaml`, `ea-180d-recall-baseline.yaml`) as templates rather than authoring `--adapter` / `--ranges` / `--judge` flags by hand.

The convention is **one directory per run**. Point `--json-out` at `<some-dir>/<run-id>/result.json` and the bench writes canonical siblings into the same directory:

| File | Contents |
|---|---|
| `result.json` | Final `BenchmarkResult` (all per-question scores, aggregates, heatmap data) |
| `progress.jsonl` | Per-checkpoint progress as JSON lines, written live |
| `failures.jsonl` | One record per appellate-reviewed failure (Q, ref, system answer, retrieval) |
| `heatmap.png` | Heatmap rendered at end of run |

Override anything in the profile with explicit flags. Common overrides:

| Flag | Use |
|---|---|
| `--personas <ids...>` | Limit to a subset of personas |
| `--ranges 30d 90d full` | Pick which checkpoints to evaluate |
| `--sample 50` | Per-checkpoint historical sample cap (new questions always evaluated) |
| `--groups-enabled` | Turn on `group-session-attribution` and `information-boundary` categories. Only flip when the adapter claims session ACLs. |
| `--judge-memory-window 1` | Give the judge ±N days of grounding around each Q&A. Eliminates "elaboration ≠ hallucination" noise. |

---

## Workflow: resume an interrupted run

A bench run is the longest operation in the system — full 180-day, 30-checkpoint, EA-with-appellate is ~1–3 hours. Always set `--json-out` so artifacts exist when you need to resume.

To pick up where the previous run stopped:

```bash
recall-bench run \
  --profile packages/recall-bench/profiles/<name>.yaml \
  --json-out bench-results/drafts/<same-run-id>/result.json \
  --resume bench-results/drafts/<same-run-id>/progress.jsonl
```

Resumed checkpoints skip the eval phase entirely (they're loaded from the JSONL). The adapter still re-ingests the corpus up to the resumed cutoff so subsequent uncached checkpoints see the right state — that's required, not wasted work.

Caveats:

- Per-question results inside a resumed checkpoint are not restorable (only aggregates are). The failure log from the prior run still has them.
- The resumed run appends to the same JSONL; it does not start a fresh file.

---

## Where outputs go

All bench runs land under `bench-results/` at the repo root:

```
bench-results/
├── drafts/                       # gitignored; new runs land here by default
│   └── <run-id>/                 # one folder per run
│       ├── result.json
│       ├── progress.jsonl
│       ├── failures.jsonl
│       └── heatmap.png
├── recall/                       # published runs, per memory system
│   └── <persona>-<corpus>-<variant>/
│       └── ...                   # same four files; README.md by convention
├── openclaw/
│   └── ...
└── ...                           # one folder per memory system tested
```

**Three tiers:**

1. **Drafts** (`bench-results/drafts/<run-id>/`) — gitignored. New runs default here. Anything ad-hoc, scratch, or system-private (e.g., Loki) stays here permanently.
2. **Published** (`bench-results/<system>/<run-id>/`) — committed. Curated results for public memory systems (Recall, OpenClaw). One folder per canonical run; add a `README.md` to summarize.
3. **Private memory systems** — same as drafts. Loki and other internal-only systems never leave the gitignored draft tier.

**Promotion is `git mv`** — when a draft is good enough to publish, move the folder into the system's published directory and commit. There is no `recall-bench publish` subcommand; the file path is the promotion.

**Adapter packages** live under `bench-harnesses/` at the repo root (in-house adapters) or in sibling repos (external systems like Loki). The profile's `harness.adapter:` path resolves the connection.

**Before running any profile whose `harness.adapter:` points at a `bench-harnesses/<system>/` package, check that directory for a `harness-program.md` and follow it first.** Not every harness builds and runs in place — some (notably OpenClaw) vendor their source here but must be copied into a sibling repo to compile against that system's workspace links. The harness-specific playbook is the source of truth for build steps, adapter dist paths, and env vars; this document is the source of truth for everything from the bench profile outward. If no `harness-program.md` exists, the harness builds and runs from this repo via its own `package.json` (e.g., `bench-harnesses/recall/`).

---

## Profiles in one minute

A profile is the canonical bundle. Treat it as the unit of "what I am benchmarking, with what, against what." Hand-editing the profile is preferred over piling CLI flags.

```yaml
persona:
  id: executive-assistant
  dir: ../personas/executive-assistant
  arcs: arcs-180d.yaml
  toolsDir: tools-180d              # only for adapters consuming Pass 3 output

env:
  file: ../../../.env               # AZURE_OPENAI_API_KEY etc.

models:
  judge: azure:gpt-5.4-mini         # primary judge — every evaluation
  appellateJudge: azure:gpt-5.4     # only invoked on primary failures
  generation: azure:gpt-5.4-mini    # adapter-side synthesis

harness:
  adapter: grpc://127.0.0.1:50053   # OR a path to a JS module exporting a factory
  factory: createOpenClawAdapter    # only when adapter is a module path
  config:                           # adapter-specific knobs
    ...

run:
  ranges: { start: 6, end: 180, step: 6 }   # OR a list like [30d, 90d, full]
  seed: 42
  parallelism: 1
  timeout: 60000
  sample: 50
  judgeMemoryWindow: 1
  groupsEnabled: false
```

Profiles live in `packages/recall-bench/profiles/`. Naming convention: `<persona-id>-<corpus-len>-<adapter-name>.yaml`.

---

## Running long jobs in the background

The CLI is designed for foreground use. For anything an agent should let run while doing other work, treat it as a background task:

- **Always set `--json-out`** when running the bench. Without it, you cannot resume and you have to re-run from scratch on interrupt. Point it at `bench-results/drafts/<run-id>/result.json`.
- **Stream progress.** The sibling `progress.jsonl` is the live signal. Tail it for per-checkpoint emissions or just count lines to gauge progress.
- **Capture stderr.** Generation passes write per-day failures to stderr (`[tool-call-generator] day N failed: ...`). Redirect to a file (`2>&1 | tee run.log`) so you can grep failures after.
- **Plan for resume.** If anything kills the run — `ctrl-C`, machine restart, API throttling — pick up with `--resume bench-results/drafts/<run-id>/progress.jsonl` rather than starting over.
- **Don't poll silently.** When a long job is running and an agent is doing other work, set a milestone or error filter that emits actionable events. Watch for completion *and* failure modes — silent watching never tells you a process crashed.
- **Cost-aware.** Bench runs and corpus generation both burn tokens. Sample sizes (`--sample`), range step (`run.ranges.step`), and `groupsEnabled` all multiply spend.

The pattern: kick off the bench in the background, watch the JSONL for new checkpoint records, surface errors as they happen, and report the final heatmap PNG when done.

---

## Models and env vars

Model selectors accepted everywhere `--model` / `--judge` / `--appellate-judge` is taken:

| Selector | Backed by | Env required |
|---|---|---|
| `claude`, `codex`, `copilot` | Local CLI agent subprocess | The CLI itself must be installed and signed in |
| `openai` or `openai:<model-id>` | OpenAI API | `OPENAI_API_KEY` |
| `anthropic:<model-id>` | Anthropic API | `ANTHROPIC_API_KEY` |
| `azure:<deployment>` or `azure:<deployment>;<endpoint>` | Azure Foundry / Azure OpenAI | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` |
| `<path/to/module.js>` | A JS module default-exporting a `GeneratorModel` / `JudgeModel` | Whatever the module needs |

Env vars are loaded automatically when a profile names an `env.file:`. For ad-hoc CLI use, source the `.env` yourself before invoking.

`azure:gpt-5.4` and `azure:gpt-5.4-mini` are the in-house defaults. Use `gpt-5.4-mini` for high-volume work (generation, primary judge) and `gpt-5.4` for the appellate judge and final-quality generation passes.

---

## Verifying outputs

After each pass, do the cheap check before moving on:

| After | Check |
|---|---|
| `create-persona` | `persona.yaml` and `arcs-NNNd.yaml` exist; the `sessions:` block and arc `primarySession` assignments look right. |
| `generate` | `ls memories-NNNd/day-*.md \| wc -l` matches `--end - --start + 1`. Spot-check a dense day for valid `# session:` H1s and no duplicate session headers. |
| `generate-conversations` | One `conv-XXXX.{md,json}` per memory day. |
| `generate-tool-calls` | One `day-XXXX.yaml` per memory day, valid YAML, each `calls[]` entry has `session` + `tool: memorySave` + non-empty `content`. |
| `generate-qa` | At least the §5.4 per-range minimums (`30d` ≥ 30, `90d` ≥ 60, `6mo` ≥ 100, `1y` ≥ 150, `full` ≥ 200) when running against arcs-1000d. |
| `run` | All four files exist in the run folder (`result.json`, `progress.jsonl`, `failures.jsonl`, `heatmap.png`); `progress.jsonl` has a `type: "summary"` record at the end; `heatmap.png` is non-empty. |

---

## When things go wrong

- **Day generation hangs.** Lower `--timeout` so it fails fast (300000ms is reasonable for CLI agents). Re-run with the same `--start`; failures are skipped silently and you can backfill.
- **`generate-tool-calls` writes empty `calls: []`.** The LLM returned malformed JSON. The generator logs `[tool-call-generator] day N produced no parseable calls; skipping write.` Re-run for that day with `--start N --end N --overwrite`.
- **Azure content-filter rejection.** A specific day's content tripped a policy. Either tweak the persona to soften the language, drop a `--temperature` notch, or hand-author that one day.
- **Bench run errors mid-checkpoint.** Resume with `--resume <progress.jsonl>`. If it errors again at the same checkpoint, narrow down with `--ranges <that-cutoff>` and a small sample.
- **Heatmap rows are all gray.** `groupsEnabled` is off (default) for `group-session-attribution` and `information-boundary`. Flip it on only when the adapter claims session-level support.

---

## Where the canonical references live

| Topic | File |
|---|---|
| Recall Bench design spec | `specs/recall-bench.md` |
| Day generator spec | `specs/day-generator.md` |
| Tool-call generator + Loki adapter | `specs/recall-bench-loki.md` |
| Heatmap renderer | `packages/recall-bench/scripts/generate-heatmap.mjs` (resolved automatically by `--json-out`) |
| Existing profiles | `packages/recall-bench/profiles/` |
| Per-harness build/run playbooks | `bench-harnesses/<system>/harness-program.md` (when present) |
| Hand-authored exemplars | `packages/recall-bench/personas/executive-assistant/tools-180d/day-0001.yaml` |

When this playbook and a spec disagree, the spec wins — it's the design source of truth, this is the operator's view.
