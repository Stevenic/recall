---
title: vs. MemoryBench
layout: default
parent: Recall Bench
nav_order: 4
description: "How MemoryBench (continual learning from user feedback) and Recall Bench (long-horizon recall fidelity) differ — and where they converge."
---

# Recall Bench vs. MemoryBench
{: .no_toc }

[MemoryBench](https://arxiv.org/abs/2510.17281) (THUIR / Tsinghua) and Recall Bench both call themselves "LLM memory benchmarks," but they measure two orthogonal faces of memory. **MemoryBench** asks whether a deployed LLM *system* can **learn and adapt from user feedback over time** (continual learning); **Recall Bench** asks whether a system can **remember accurately, without fabricating, as its memory grows to years of history** (recall fidelity). Despite the different framings, the two converge on the same uncomfortable conclusion: **today's sophisticated memory-abstraction layers underperform plain retrieval of the source data.** They are complementary, not competing — a genuinely capable agent-memory system would need to pass both.

<details markdown="block">
<summary>Table of contents</summary>

- TOC
{:toc}
</details>

---

## MemoryBench at a glance

**Full title:** *MemoryBench: A Benchmark for Memory and Continual Learning in LLM Systems* — Qingyao Ai, Yichen Tang, Changyue Wang, Jianming Long, Weihang Su, Yiqun Liu (THUIR, Tsinghua University).

**Thesis.** The interesting question about LLM "memory" is not *can it recall a fact* but **can a deployed LLM system get better at a task by learning from user feedback** — i.e. continual learning, not just retrieval.

### The core novelty — a user-feedback loop

MemoryBench's centerpiece is a **user-feedback simulator** (built on `Mistral-Small-3.2-24B-Instruct`). After the system answers, the simulator emits *implicit* feedback:

- a `satisfaction_score` (0–9),
- discrete `implicit_actions` (e.g. "like"),
- a `terminated` signal.

The harness then feeds batches of past cases **plus their feedback logs** back into the system and measures whether held-out test performance **improves with feedback vs. without**. Two settings are run: an **off-policy** protocol (primary results) and a costlier **on-policy** one.

### Design

| Dimension | Detail |
|---|---|
| Domains | 3 — Open-Domain, Academic & Knowledge, Legal |
| Languages | Bilingual — English + Chinese |
| Task shapes | 4, by **input × output length** at a **600-token** boundary: **LiSo, LiLo, SiLo, SiSo** (input = query + corpus; output = answer / generated text) |
| Corpus | A **meta-benchmark**: **28 datasets / ≈3,763 rows** repurposed from existing suites (DialSim, Locomo, LexEval, HelloBench, WritingBench, WritingPrompts, IdeaBench, JuDGE, NFCats, …) |
| Assistant model | Qwen3-8B generates the dialogue / assistant turns |
| Methods evaluated | 8 — Vanilla (no memory); BM25-M / BM25-S and Emb-M / Emb-S (lexical / dense retrieval at message- or session-level); and three "advanced" systems: **A-Mem, Mem0, MemoryOS** |
| Scoring | Task-specific quality metrics (e.g. **Rouge-L**) **plus an explicit efficiency axis** (memory time / cost) |

### Headline findings

- **Plain RAG wins.** *"None of the advanced memory-based LLM systems can consistently outperform RAG baselines."* The lexical / dense retrieval baselines beat the purpose-built memory frameworks.
- **The advanced systems are slow or brittle.** Mem0 and MemoryOS generalize poorly; **Mem0 cannot process long contexts in reasonable time**; **MemoryOS costs > 17 s per case**; A-Mem is efficient but ineffective.
- **The deep gap:** *"existing memory systems are not good at utilizing procedural knowledge to improve their performance"* — they store facts but do not actually *learn the skill* the feedback is teaching.
- Overall, existing baselines are "far from satisfying" on **both effectiveness and efficiency**.

---

## Recall Bench at a glance

Recall Bench evaluates **agent-memory systems** on **long-horizon recall**. Each synthetic persona accumulates up to **1,000 days** of daily agent memories (driven by overlapping narrative arcs — projects, decisions, corrections, relationships), and the system under test must **ingest → organize / compact → retrieve** that history.

- **10 recall categories**: factual-recall, temporal-reasoning, decision-tracking, contradiction-resolution, cross-reference, recency-bias-resistance, synthesis, negative-recall, plus two opt-in group-aware categories (group-session-attribution, information-boundary). See the [overview](./recall-bench.html).
- **Scoring** per answer: `correctness (0–3) + completeness (0–2) + hallucination (0–1)` → composite `0–6`, with **hallucination held as an independent dimension**, graded by an LLM judge plus an appellate judge.
- **Degradation tracking**: performance is measured at checkpoints as the corpus grows, exposing where each system erodes with scale.
- **Systems benchmarked**: Recall, OpenClaw, MemPalace — see the [published-runs postmortem](./results/postmortem-ea.html).

---

## Side-by-side comparison

| Axis | **MemoryBench** | **Recall Bench** |
|---|---|---|
| Core question | Does the system **learn / adapt** from user feedback? (continual learning) | Does the system **remember** accurately at scale? (recall fidelity) |
| What "memory" holds | User interactions + **feedback logs** | The agent's own **daily memory logs** (compacted hierarchically) |
| Time axis | Rounds → batches → episodes of feedback | **Up to 1,000 days** of accumulating memories |
| Feedback loop | **Yes** — simulated user satisfaction drives improvement | **No** — read-only Q&A over a fixed corpus |
| Data | 28 **repurposed** datasets, ≈3,763 rows, **EN + ZH**, 3 domains | **6 purpose-built** synthetic personas with narrative arcs, EN |
| Task taxonomy | 4 shapes by **input × output length** | **10 recall categories** (factual, temporal, contradiction, synthesis, information-boundary, …) |
| Scoring | Task-specific (Rouge-L, …) **+ efficiency / cost** | Composite **correctness + completeness + hallucination (0–6)**, LLM + appellate judge |
| Distinctive measure | **Procedural learning**; multilingual; latency / cost | **Hallucination** as an independent dimension; **degradation curve** as corpus grows |
| Systems benchmarked | Mem0, MemoryOS, A-Mem, BM25 / Emb, vanilla | Recall, OpenClaw, MemPalace |

---

## The striking convergence

Despite the different framings, both benchmarks independently land on the **same conclusion: sophisticated memory-abstraction layers underperform plain retrieval of the source.**

- **MemoryBench:** the "advanced" memory frameworks (Mem0, MemoryOS, A-Mem) lose to BM25 / embedding RAG.
- **Recall Bench:** the [published-runs postmortem](./results/postmortem-ea.html) found that Recall's **synthesized wiki / summary layer outranks the precise daily** that actually holds the answer (in 55–98 % of failures) — which is exactly *why* its wiki score-boost was cut to a deliberate **de-boost (0.9)**, and why **MemPalace's date-roomed retrieval of raw days beats Recall's dreaming-wiki baseline** at 180 days.

Both are saying the same thing in different vocabularies: **don't let a lossy synthesis layer answer in place of the source.**

---

## What each measures that the other doesn't

**Recall Bench tests what MemoryBench can't:**

- **Hallucination** as a first-class, independently-scored axis.
- Long **single-narrative continuity** — one coherent 1,000-day life, vs. MemoryBench's shorter per-dataset episodes.
- **Contradiction / supersession / temporal-reasoning** (tracking revisions of a fact over time) and **information-boundary** (per-session access control).
- An **appellate-judge + human re-grade** audit layer for grading trust.

**MemoryBench tests what Recall Bench can't:**

- The actual **learning loop** — the system can *change* in response to feedback, not merely be queried.
- **Multilingual** coverage (EN + ZH).
- **Efficiency / cost** as a headline axis.
- Standardized head-to-head comparison of **named SOTA frameworks** (Mem0, MemoryOS, A-Mem) across a broad task spread (QA, dialog, long-form writing, judgment).

---

## Bottom line

The two benchmarks are **complementary, not competing.** MemoryBench measures the **adaptation / personalization** face of memory — *"did feedback make it smarter?"* Recall Bench measures the **retention / retrieval** face — *"does it remember what happened, without fabricating?"* A genuinely capable agent-memory system would need to pass **both** — and, tellingly, both benchmarks currently agree that the field's elaborate memory layers are not beating the simple baselines.

---

## Sources & caveat

This write-up was reconstructed from the paper's **abstract**, its **ar5iv HTML rendering**, the **THUIR/MemoryBench GitHub README**, and the **HuggingFace dataset card** — the arXiv PDF would not extract cleanly in the working environment. The qualitative findings and design facts are corroborated across those sources; exact per-method score tables were **not** accessible, so the paper's qualitative claims are quoted rather than numeric results invented. Recall Bench figures are drawn from this repository's published runs and the [cross-system postmortem](./results/postmortem-ea.html).

- Paper: <https://arxiv.org/abs/2510.17281>
- Code: <https://github.com/THUIR/MemoryBench>
- Dataset: <https://huggingface.co/datasets/THUIR/MemoryBench>
- Project site: memorybench.thuir.cn
