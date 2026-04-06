---
name: Recall MVP scope
description: MVP v0.1 scope and architecture decisions for the recall agent memory service
type: project
---

Recall is an agent memory service managing the full lifecycle of agent memory — daily logs through wisdom distillation — with semantic search. Spec lives at `specs/memory-service.md`.

**Why:** Standalone replacement for the teammates-recall module, owning the entire memory stack instead of just the Vectra index.

**How to apply:** All implementation work follows the spec's architecture: four pluggable abstractions (Storage, Embeddings, Index, Model), monorepo layout under `packages/core/`, CLI parity with programmatic API. Default implementations are local-first (no cloud deps). Model layer uses `CliAgentModel` that spawns a CLI coding agent — no API keys needed for v0.1.
