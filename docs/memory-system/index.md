---
title: Recall Memory System
layout: default
nav_order: 2
has_children: true
permalink: /memory-system/
---

# Recall Memory System

Local-first agent memory: from raw daily logs through compacted summaries to distilled wisdom, with semantic search over all of it.

> **⚠️ Experimental & in-progress.** Recall is an exploratory research system, not a finished product. It exists to probe and prototype fixes for the failure modes that [Recall Bench](../bench/) surfaces in other agent-memory systems (notably **OpenClaw**) — confident fabrication over honest refusal, temporal- and recency-reasoning collapse at scale, and lossy synthesis layers crowding out the source data. Internals change frequently and not every idea here has earned its keep yet; treat it as a lab notebook, not a release.

## What's in this section

- **[Architecture](./architecture.html)** — System layers, file layout, search pipeline, compaction model, dreaming, and the four swappable interfaces (storage, embeddings, index, model).
- **[The LLM Wiki](./wiki.html)** — The topical knowledge layer: Karpathy-inspired cross-linked pages, the stub→synthesis lifecycle, and **supersession** for keeping pages current as facts change.
- **[vs. OpenClaw](./comparison-recall-vs-openclaw.html)** — Side-by-side comparison of Recall and OpenClaw's memory model — architectures, storage, search, and compaction trade-offs.
- **[Prompts](./prompts/)** — The LLM prompts that drive compaction, dreaming, query expansion, and wisdom distillation.

## Design philosophy in one paragraph

Recall keeps two views of memory side by side: a **temporal stream** (raw daily logs rolled up by compaction into week/month/wisdom layers) and a **topical [wiki](./wiki.html)** (cross-linked pages, one per subject, that the agent stubs in real time and dreaming synthesizes over time). It is **eidetic** — raw daily logs are never deleted, and every summary or wiki page is regenerable from them, so derived views never become a second source of truth. There is **no recency decay**: a two-year-old memory scores the same as yesterday's unless the query mentions time, in which case a temporal-affinity boost surfaces it. The default backend runs **fully offline** using `transformers.js` embeddings and a `CliAgentModel` (Claude/Codex/Copilot subprocess) — no API keys required.

For a side-by-side comparison against OpenClaw's promotion-based memory model, see [vs. OpenClaw](./comparison-recall-vs-openclaw.html).
