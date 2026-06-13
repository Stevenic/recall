---
title: Recall Bench
layout: default
nav_order: 3
has_children: true
permalink: /bench/
---

# Recall Bench

A benchmark harness for evaluating agent memory systems on long-horizon recall (up to 1,000 days of synthetic daily logs per persona).

## What's in this section

- **[Recall Bench overview](./recall-bench.html)** — The scoring dimensions, the ten recall categories, the persona corpus, the three-phase evaluation loop, and what each category measures.
- **[Recall vs. OpenClaw comparison](./comparison-recall-vs-openclaw.html)** — Side-by-side architectural and design comparison of the two memory systems Recall Bench currently scores.
- **Published results:**
  - **[OpenClaw EA benchmark — 180d + 500d](./results/openclaw-ea.html)** — Combined report covering both Executive-Assistant runs, with issue analysis pulled from the failure logs.

## What gets measured

Each Q&A pair is scored on three judged dimensions and tagged with one recall category:

```
correctness (0–3) + completeness (0–2) + hallucination (0–1) = composite score (0–6)
```

The hallucination dimension is held independently so a system can be **confidently wrong** (high recall, low hallucination grounding) or **accurately silent** (low recall, high hallucination grounding) — mixing them into one number hides which failure mode dominates.

**Eight core categories** tag each question: `factual-recall`, `temporal-reasoning`, `decision-tracking`, `contradiction-resolution`, `cross-reference`, `recency-bias-resistance`, `synthesis`, `negative-recall`. **Two group-aware categories** — `group-session-attribution` and `information-boundary` — add session-attribution and cross-session leakage tests for multi-session personas; they are opt-in via `--groups-enabled`. The harness reports per-category scores so you can see *which kind* of memory work degrades first as the corpus grows.

## Running the benchmark

Operator's playbook for running and managing benchmarks lives in the repo at [`bench-program.md`](https://github.com/Stevenic/recall/blob/main/bench-program.md). Per-harness build instructions (for harnesses that need to be built inside a sibling repo, like OpenClaw) live in each `bench-harnesses/<system>/harness-program.md`.
