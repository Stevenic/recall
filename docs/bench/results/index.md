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
| [Published Runs — Postmortem](./postmortem-ea.html) | **All systems** (Recall, MemPalace, OpenClaw) | Executive Assistant (Jordan) | 60d–500d, 9 runs |
| [OpenClaw — Executive Assistant](./openclaw-ea.html) | OpenClaw (vector mode, agent answer-loop) | Executive Assistant (Jordan) | 180-day + 500-day |

The **postmortem** is the cross-system retrospective covering all nine published runs with failure triage and code-level findings; the per-system reports (like OpenClaw's) go deeper on a single system.

The raw per-run artifacts (`result.json`, `progress.jsonl`, `failures.jsonl`, `heatmap.png`) live in the repository under `bench-results/<system>/<run-id>/`. The reports here summarize and interpret them.
