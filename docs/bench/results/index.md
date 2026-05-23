---
title: Results
layout: default
parent: Recall Bench
nav_order: 3
has_children: true
---

# Published bench results

Each result page bundles one or more bench runs for the same memory system, with heatmaps, aggregate score tables, and an analysis of the failure modes pulled from the per-question logs.

| Report | System | Persona | Corpus |
|---|---|---|---|
| [OpenClaw — Executive Assistant](./openclaw-ea.html) | OpenClaw (vector mode, agent answer-loop) | Executive Assistant (Jordan) | 180-day + 500-day |

The raw per-run artifacts (`result.json`, `progress.jsonl`, `failures.jsonl`, `heatmap.png`) live in the repository under `bench-results/<system>/<run-id>/`. The reports here summarize and interpret them.
