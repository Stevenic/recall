---
title: Running with a coding agent
layout: default
parent: Recall Bench
nav_order: 2
description: "How to drive the full Recall Bench pipeline — create persona, generate the corpus, run, and analyze — using a coding agent like Claude, Codex, or Copilot."
---

# Running Recall Bench with a coding agent
{: .no_toc }

Recall Bench is built to be operated end-to-end by a **coding agent**. There is no GUI and no hidden state — every command is a `recall-bench` subcommand, every artifact is a file on disk, and the agent can drive each step, inspect the output, and recover from failures itself. This page is the quick orientation; the full operator's playbook is **[`bench-program.md`](https://github.com/Stevenic/recall/blob/main/bench-program.md)** in the repo.

<details markdown="block">
<summary>Table of contents</summary>

- TOC
{:toc}
</details>

---

## Why a coding agent

A full benchmark is a long, failure-prone, multi-step job: author a persona, generate ~1,000 days of synthetic memories (hundreds of LLM calls), build Q&A pairs, then ingest-and-query a memory system at dozens of checkpoints. A coding agent is the right operator because it can:

- **Run the pipeline** — invoke each `recall-bench` subcommand and check the result before moving on.
- **Recover** — every long step writes incrementally and is resume-safe; the agent re-runs from where it stopped.
- **Grade** — act as an out-of-band audit layer over the LLM judge (see [The agent is the grader](#the-agent-is-the-ultimate-grader)).

---

## Model selectors

The same selector syntax works everywhere a model is taken (`--model`, `--judge`, `--appellate-judge`):

| Selector | Backed by | Env required |
|---|---|---|
| `claude`, `codex`, `copilot` | A local **CLI coding agent** subprocess | The CLI installed and signed in — **no API keys** |
| `openai` or `openai:<model-id>` | OpenAI API | `OPENAI_API_KEY` |
| `anthropic:<model-id>` | Anthropic API | `ANTHROPIC_API_KEY` |
| `azure:<deployment>[;<endpoint>]` | Azure OpenAI / Foundry | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` |
| `<path/to/module.js>` | A JS module exporting a `GeneratorModel` / `JudgeModel` | Whatever the module needs |

> **Coding-agent quirk.** The local CLI agents (`claude`, `codex`, `copilot`) **ignore `--temperature` and `--max-tokens`** — the pipeline strips those flags before invoking them. Configure generation parameters through the agent's own config instead. Those flags are honored only for API model specs and JS modules.

---

## The pipeline

```
persona.yaml + arcs-NNNd.yaml
   │
   ├─ Pass 1: generate              → memories-NNNd/day-XXXX.md     (daily logs)
   ├─ Pass 2: generate-conversations → conversations-NNNd/          (user↔agent turns, optional)
   ├─ Pass 3: generate-tool-calls    → tools-NNNd/                  (memorySave calls, optional)
   └─ Pass 4: generate-qa            → qa-NNNd/                     (graded Q&A pairs)
                                                │
   bench profile + adapter ──→ recall-bench run ──→ bench-results/<run>/
                                                       result.json · progress.jsonl
                                                       failures.jsonl · heatmap.png
```

Each pass is independent — regenerate any one without redoing the others.

### 1. Author the persona

```bash
recall-bench create-persona \
  --prompt "An emergency physician working night shifts at a level-1 trauma center..." \
  --persona ./packages/recall-bench/personas/er-physician \
  --model azure:gpt-5.4
```

Produces a draft `persona.yaml` + `arcs-1000d.yaml`. Both usually need a hand-edit pass (sessions, cast, arc `primarySession` assignments) before generation.

### 2. Generate the corpus (Pass 1)

```bash
recall-bench generate \
  --persona ./packages/recall-bench/personas/er-physician \
  --model claude \
  --start 1 --end 180
```

The longest step — minutes per day on dense personas. Files are written **as each day is produced**, so a crash at day 437 leaves 436 days on disk; resume with `--start 437`. Run it as a background job and tail progress.

### 3. Conversations / tool-calls (Passes 2–3, optional)

`generate-conversations` reconstructs the dialog turns that would have produced each day; `generate-tool-calls` emits the `memorySave(...)` sequence an agent would have made. Use these for systems that ingest transcripts or a tool loop rather than raw markdown.

### 4. Author Q&A (Pass 4)

```bash
# Standard recall questions
recall-bench generate-qa --persona <dir> --model azure:gpt-5.4 --arcs arcs-180d.yaml
# Information-boundary probes for multi-session personas
recall-bench generate-qa --persona <dir> --model azure:gpt-5.4 --arcs arcs-180d.yaml --mode boundary
```

Generated incrementally in checkpoint windows; resume-safe.

### 5. Run the benchmark

```bash
recall-bench run \
  --profile packages/recall-bench/profiles/ea-180d-recall-baseline.yaml \
  --json-out bench-results/drafts/<run-id>/result.json
```

A [**profile**](https://github.com/Stevenic/recall/blob/main/bench-program.md#profiles-in-one-minute) bundles persona, adapter, judge models, ranges, sampling, and timeouts — prefer editing a profile over piling on CLI flags. Pointing `--json-out` at a per-run directory makes the bench write the canonical siblings (`heatmap.png`, `progress.jsonl`, `failures.jsonl`) alongside it.

> **Always set `--json-out`.** Without it you can't resume — a killed run starts over. Resume with `--resume bench-results/drafts/<run-id>/progress.jsonl`.

---

## The agent is the ultimate grader

The LLM judge (`models.judge` / `models.appellateJudge`) makes calibration errors in both directions. Left alone, the bench measures the judge as much as the system. The coding agent is the **out-of-band audit layer**: after each checkpoint lands in `progress.jsonl`, read that checkpoint's questions from `questions.jsonl` and re-grade — classifying each disagreement as a **judge false negative**, a **judge false positive**, a **Q&A defect** (the reference is wrong), or a **real system failure**. Only the last should drive iteration.

Every run gets a **`notes.md`** in its results directory that the agent owns and the user reads — a per-checkpoint log plus an end-of-run analysis that explains *why* the scores look the way they do, with source `file:line` citations for failure clusters. The bar: "scores were bad because the cross-encoder over-promotes token-similar dailies on date-pinned queries, see `search.ts:495`" — not "scores were bad."

See the [published-runs postmortem](./results/postmortem-ea.html) for a worked example of this grading methodology across nine runs.

---

## Long jobs in the background

- **Set `--json-out`** so artifacts exist for resume.
- **Stream `progress.jsonl`** — tail it for per-checkpoint records, or count lines to gauge progress.
- **Capture stderr** (`2>&1 | tee run.log`) — generation passes log per-day failures there.
- **Plan for resume** — `--resume <progress.jsonl>` rather than restarting on any interruption.
- **Watch for failure, not just completion** — silent watching never tells you a process crashed.

---

## Where the canonical references live

| Topic | File |
|---|---|
| Full operator's playbook | [`bench-program.md`](https://github.com/Stevenic/recall/blob/main/bench-program.md) |
| Benchmark design spec | [`specs/recall-bench.md`](https://github.com/Stevenic/recall/blob/main/specs/recall-bench.md) |
| Per-harness build/run steps | `bench-harnesses/<system>/harness-program.md` (when present) |
| Existing profiles | `packages/recall-bench/profiles/` |
| Scoring & categories | [Recall Bench overview](./recall-bench.html) |
