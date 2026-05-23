---
title: Recall Memory System
layout: default
nav_order: 2
has_children: true
permalink: /memory-system/
---

# Recall Memory System

Local-first agent memory: from raw daily logs through compacted summaries to distilled wisdom, with semantic search over all of it.

## What's in this section

- **[Architecture](./architecture.html)** — System layers, file layout, search pipeline, compaction model, and the four swappable interfaces (storage, embeddings, index, model).
- **[Prompts](./prompts/)** — The LLM prompts that drive compaction, dreaming, query expansion, typed-memory extraction, and wisdom distillation.

## Design philosophy in one paragraph

Recall is **eidetic** — raw daily logs are never deleted, and structured summaries layer on top via temporal compaction (week/month/wisdom). There is **no recency decay**: a two-year-old memory scores the same as yesterday's unless the query mentions time, in which case a temporal-affinity boost surfaces it. The default backend runs **fully offline** using `transformers.js` embeddings and a `CliAgentModel` (Claude/Codex/Copilot subprocess) — no API keys required.

For a side-by-side comparison against OpenClaw's promotion-based memory model, see [Recall vs. OpenClaw](../bench/comparison-recall-vs-openclaw.html) in the Bench section.
