---
title: Home
layout: default
nav_order: 1
description: "Recall — local-first agent memory, plus Recall Bench for evaluating agent memory systems."
permalink: /
---

# Recall

Local-first agent memory — from raw logs to distilled wisdom, with semantic search over all of it. Comes with **Recall Bench**, a benchmark harness for evaluating any agent memory system (Recall, OpenClaw, Loki, your own) against a synthetic multi-year persona corpus.

This site is organized into two sections so you can dive into the one you care about and ignore the other:

## [Recall Memory System →](./memory-system/)
Architecture, the four-level compaction pipeline (daily → weekly → monthly → wisdom), the two-phase hierarchical search, dreaming and contradiction detection, and the prompts that drive it.

## [Recall Bench →](./bench/)
The benchmark itself — the 8+1 scoring dimensions, the persona corpus, harness adapters, published runs and heatmaps for each memory system tested, and a head-to-head comparison of Recall vs. OpenClaw.

---

## Quick links

- **For developers picking a memory system:** [Recall vs. OpenClaw comparison](./bench/comparison-recall-vs-openclaw.html)
- **For developers evaluating a memory system:** [Recall Bench overview](./bench/recall-bench.html) and the [OpenClaw EA benchmark report](./bench/results/openclaw-ea.html)
- **For developers building on Recall:** [Memory system architecture](./memory-system/architecture.html)

---

*Recall is an open-source project. Source: [github.com/Stevenic/recall](https://github.com/Stevenic/recall).*
