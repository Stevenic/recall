# Recall

**Local-first agent memory** — from raw daily logs through compacted summaries to distilled wisdom, with semantic search over all of it — plus **Recall Bench**, a harness for evaluating *any* agent-memory system over a synthetic multi-year persona corpus.

📖 **Docs: [stevenic.github.io/recall](https://stevenic.github.io/recall/)**

> ⚠️ **Experimental & in-progress.** Recall is an exploratory research system, not a finished product. It exists to probe and prototype fixes for the failure modes that Recall Bench surfaces in other agent-memory systems (notably **OpenClaw**) — confident fabrication over honest refusal, temporal- and recency-reasoning collapse at scale, and lossy synthesis layers crowding out the source data. Internals change frequently; treat it as a lab notebook, not a release.

This repository is two things that grew up together:

| | What it is | CLI | Docs |
|---|---|---|---|
| **Recall** | The agent-memory system itself (`packages/core`) | `recall` | [Memory System →](https://stevenic.github.io/recall/memory-system/) |
| **Recall Bench** | A benchmark for evaluating agent-memory systems (`packages/recall-bench`) | `recall-bench` | [Recall Bench →](https://stevenic.github.io/recall/bench/) |

---

## Recall — the memory system

Recall keeps two views of memory side by side:

- A **temporal stream** — raw daily logs that are *never deleted* (eidetic), rolled up by **compaction** into weekly → monthly → wisdom layers, each regenerable from the source beneath it.
- A **topical wiki** — Karpathy-inspired cross-linked pages, one per subject, that the agent stubs in real time and an asynchronous **dreaming** pass synthesizes over time, with **supersession** to keep claims current as facts change.

Retrieval is a **two-phase hierarchical search** (coarse parent routing → precise reranking) over a hybrid semantic + BM25 index. There is **no recency decay** — a two-year-old memory ranks like yesterday's unless the query mentions time. The default backend runs **fully offline**: `transformers.js` embeddings and a CLI-agent subprocess (Claude/Codex/Copilot) for summarization — **no API keys required**. Storage, embeddings, index, and model are all swappable interfaces.

→ [Architecture](https://stevenic.github.io/recall/memory-system/architecture.html) · [The LLM Wiki & supersession](https://stevenic.github.io/recall/memory-system/wiki.html) · [vs. OpenClaw](https://stevenic.github.io/recall/memory-system/comparison-recall-vs-openclaw.html)

---

## Recall Bench — the benchmark

Most memory evaluations test small corpora over short spans. Recall Bench measures **long-horizon recall** instead: each synthetic persona accumulates up to **1,000 days** of daily agent memories driven by overlapping narrative arcs, and the system under test must **ingest → organize/compact → retrieve** that history.

- **Ten recall categories** — factual-recall, temporal-reasoning, decision-tracking, contradiction-resolution, cross-reference, recency-bias-resistance, synthesis, negative-recall, plus two opt-in group-aware categories (group-session-attribution, information-boundary).
- **Scoring** — `correctness (0–3) + completeness (0–2) + hallucination (0–1)` → composite `0–6`, with **hallucination as an independent dimension**, graded by an LLM judge + appellate judge.
- **Degradation tracking** — performance is measured at checkpoints as the corpus grows, exposing where each system erodes with scale.
- **System-agnostic** — any memory system that ingests markdown and answers questions can be benchmarked, via a TypeScript adapter or a gRPC server in any language.

Systems benchmarked so far: **Recall, OpenClaw, MemPalace**. The cross-system **[postmortem](https://stevenic.github.io/recall/bench/results/postmortem-ea.html)** is the most interesting read — and its headline finding (sophisticated memory layers underperform plain retrieval of the source) independently echoes [MemoryBench](https://stevenic.github.io/recall/bench/memorybench-vs-recall-bench.html).

→ [Overview & scoring](https://stevenic.github.io/recall/bench/recall-bench.html) · [Running with a coding agent](https://stevenic.github.io/recall/bench/running-with-a-coding-agent.html) · [Published results](https://stevenic.github.io/recall/bench/results/)

---

## Repository layout

```
packages/core/            # Recall — the memory service (`recall` CLI + library)
packages/recall-bench/    # Recall Bench — the benchmark harness (`recall-bench` CLI)
bench-harnesses/          # Adapters for systems under test (recall, mempalace, openclaw)
bench-results/            # Published per-system run artifacts (result.json, heatmap.png, …)
docs/                     # The documentation site (Jekyll / just-the-docs)
specs/                    # Design specifications
scripts/                  # Tooling (heatmap renderer, partial-result reconstructor, …)
bench-program.md          # Operator's playbook for running Recall Bench end-to-end
```

## Getting started

```bash
npm install
npm run build --workspaces --if-present
```

The full operator's guide for the benchmark — creating personas, generating corpora, running, and analyzing with a coding agent — is in [`bench-program.md`](./bench-program.md) and on the [docs site](https://stevenic.github.io/recall/bench/running-with-a-coding-agent.html).

## Status & license

Recall is **early, experimental, and actively changing** — APIs, file formats, and internals are not stable. Issues and discussion are welcome; treat anything here as subject to change. Open source under the **MIT License**.
