---
title: Published Runs — Postmortem
layout: default
parent: Results
grand_parent: Recall Bench
nav_order: 2
description: "Cross-system postmortem of all nine published Recall Bench runs against the Executive Assistant persona — Recall, MemPalace, and OpenClaw — with failure triage and code-level findings per the bench-program grading methodology."
---

# Published Runs — Postmortem (Executive Assistant)
{: .no_toc }

A postmortem covering **all nine published Recall Bench runs** against the Executive Assistant ("Jordan") persona, across three memory systems: **Recall**, **MemPalace**, and **OpenClaw**. It follows the grading methodology in [`bench-program.md`](https://github.com/Stevenic/recall/blob/main/bench-program.md) — every failure cluster was re-graded against the corpus, classified (judge error vs. Q&A defect vs. real failure), and traced to a specific source `file:line`.

For the OpenClaw deep-dive, see the dedicated [OpenClaw — Executive Assistant](./openclaw-ea.html) report; this postmortem summarizes it and focuses the new analysis on the Recall and MemPalace runs.

<details markdown="block">
<summary>Table of contents</summary>

- TOC
{:toc}
</details>

---

## ⚠️ Read this first: which numbers to trust

Four of the nine runs are **reconstructed, partial** artifacts (`metadata.reconstructed: true`). They were killed before writing a final `result.json`, and their results were rebuilt from `progress.jsonl` + `questions.jsonl` (see [`scripts/result-from-progress.mjs`](https://github.com/Stevenic/recall/blob/main/scripts/result-from-progress.mjs)). The per-checkpoint aggregates are exact, but they cover **only the checkpoints that completed**:

| Run | Status |
|---|---|
| `recall/ea-500d-recall-dreaming` | **partial** — 10 of 50 checkpoints (days 10–100 only) |
| `recall/ea-60d-recall-supersession-on` | **partial** — 4 checkpoints (6d–24d) |
| `recall/ea-60d-recall-rerank-on` | **partial** — 3 checkpoints (6d–18d) |
| `recall/ea-60d-recall-rerank-off` | **partial** — 1 checkpoint (6d), 6 evals |

Treat the three 60-day ablation runs as **directional at best** — their per-checkpoint N is 6–79 evals, so every cross-run difference is within noise (see [Ablations](#ablations-directional-only-underpowered)).

---

## TL;DR

| Run | System | Checkpoints | Evals | Overall (Q1→Q4) | Halluc (Q1→Q4, peak) |
|---|---|---:|---:|---|---|
| `openclaw/ea-180d-openclaw` | OpenClaw (vector+agent) | 19 (72–180d) | 1,212 | 5.58 → 5.31 | 5.4% → 10.8% (13.1%) |
| `openclaw/ea-500d-vector` | OpenClaw (vector+agent) | 50 (10–500d) | 3,168 | 5.24 → 4.98 | 13.6% → 17.6% (27.1%) |
| `recall/ea-180d-recall-baseline` | Recall — **no dreaming/wiki** | 30 (6–180d) | 1,639 | **4.88 → 4.46** | 8.9% → 17.9% (25.8%) |
| `recall/ea-500d-recall-dreaming` | Recall — dreaming+wiki | 10 (10–100d)¹ | 562 | 5.11 → 4.90 | 12.2% → 13.0% (16.7%) |
| `recall/ea-60d-recall-baseline` | Recall — dreaming+wiki | 10 (6–60d) | 423 | 5.83 → 5.04 | 0% → 16.6% (21.3%) |
| `recall/ea-60d-recall-supersession-on` | Recall — dreaming+wiki | 4 (6–24d)¹ | 79 | 6.00 → 5.41 | 0% → 10.8% (12.5%) |
| `recall/ea-60d-recall-rerank-on` | Recall — dreaming+wiki | 3 (6–18d)¹ | 39 | 6.00 → 5.05 | 0% → 19.0% (19.0%) |
| `recall/ea-60d-recall-rerank-off` | Recall — dreaming+wiki | 1 (6d)¹ | 6 | 5.00 | 16.7% |
| `mempalace/ea-180d-mempalace-baseline` | MemPalace | 30 (6–180d) | 1,639 | 5.18 → 5.02 | 7.6% → 14.6% (21.3%) |

¹ reconstructed/partial.

**The one finding that explains most of the Recall failures:** across *every* Recall run, the **lossy aggregate layer outranks the precise daily that holds the answer.** In the no-dreaming baseline it's the weekly/monthly **summary** (98% of failures top-hit a summary; ~39% retrieve no daily at all). In the dreaming runs it's the **wiki page** (55–57% of failures retrieve *only* wiki pages, never a daily). Same structural bug, two layers. The agent then either fabricates a plausible-but-wrong specific or falsely refuses — **the fact was verbatim in a daily it never read.**

**The cross-system pattern:** when any of the three systems is wrong, it is **confidently wrong, not silently wrong** — 56–93% of failures are fabrications (`hallucination = 0`), only 7–30% are honest "I checked memory and didn't find it" refusals. And all three break on the same stressor: the corpus deliberately **revises** the Project Condor deal figures around day 13–14, and date-blind retrieval returns the wrong revision.

**Judge calibration is sound** — false-negative rates of 1.3–4.7% across runs (all under the bench-program 5% escalation bar), zero false positives found. The headline scores are trustworthy.

---

## The 180-day head-to-head

`recall-180d-baseline` and `mempalace-180d-baseline` use the **identical** checkpoint ladder (30 checkpoints, 6d–180d, 1,639 evals each), so they compare cleanly. OpenClaw's 180d run uses a different ladder (19 checkpoints, 72d–180d) and is reported separately.

| Category | Recall (no dreaming) | MemPalace | Winner |
|---|---:|---:|---|
| `factual-recall` | 4.47 | **4.92** | MemPalace |
| `temporal-reasoning` | 4.18 | **5.73** | MemPalace |
| `decision-tracking` | 4.04 | **4.75** | MemPalace |
| `contradiction-resolution` | 4.79 | **5.27** | MemPalace |
| `cross-reference` | **4.91** | 4.26 | Recall |
| `recency-bias-resistance` | 5.45 | **5.73** | MemPalace |
| `synthesis` | 3.28 | **4.09** | MemPalace |
| `negative-recall` | 5.32 | **5.66** | MemPalace |
| **Overall (Q1→Q4)** | 4.88 → 4.46 | **5.18 → 5.02** | MemPalace |

**MemPalace wins seven of eight categories** at 180 days. But this is *not* a like-for-like verdict on the two architectures: the Recall run published here is the **non-dreaming baseline** (plain hierarchical retrieval, no wiki), while Recall's dreaming variant — the configuration meant to be competitive — has no published 180-day run. The recall *dreaming* runs at 60d and 500d score `synthesis` **5.14 / 3.75** and `factual-recall` **5.25 / 4.90**, well above the baseline's 3.28 / 4.47, so dreaming materially lifts exactly the categories where the baseline is weakest. **The single most important gap in the published set is a 180-day Recall-dreaming run** to put alongside MemPalace and OpenClaw.

---

## Recall: the aggregate layer outranks the daily

This is the spine of every Recall failure. The system stores raw dailies plus a derived aggregate layer (compacted summaries in the baseline; synthesized wiki pages with dreaming). Retrieval is supposed to surface the daily that holds a date-pinned atom; instead the aggregate wins, and the atom is either compressed away or never read.

### In the no-dreaming baseline: summaries crowd out dailies

The `ea-180d-recall-baseline` triage found a **summary as the top retrieval hit in ~98% of the 462 failures, and no daily retrieved at all in ~39%.** Of 456 real failures, **56% are confident fabrications** (a wrong number/name/date stated as fact) and only 16% are honest refusals.

Three compounding causes, all traced to source:

1. **Summaries are double-counted in scoring.** A `#summary` candidate inherits the parent's full vector score (`search.ts:495`) *and* then receives the parent boost again in phase-2 reranking (`search.ts:562–565`, `wParent·pScore`). Against an un-dated topical query, the summary's dense digest outscores any single daily — so the daily never reaches the top-K.
2. **Compaction discards the atom before retrieval even runs.** The weekly prompt targets ~30% of input length and its KEEP list (`compactor.ts:733–738`) preserves decisions/outcomes/names but **not specific numbers, dollar figures, or dates** — and explicitly drops "entries repeated across days," which is exactly how standing figures (a valuation, a synergy estimate) read. Verified directly: the W03 summary retrieved for `q007` contains none of the `$420M/$475M/$490M` atoms the question asks for.
3. **The corrective levers are off.** Temporal affinity only fires when a date is parsed *from the query* (`search.ts:576`), so un-dated factual questions get no era disambiguation; and the grounding/staleness penalty that could downrank a lossy aggregate is commented out (`search.ts:595`).

Add a 700-character snippet cap in the answer loop (`agent-loop.ts:627`, applied at `:742`/`:765`) and atoms buried deeper in a long multi-session daily are invisible even when the right file *is* retrieved (e.g. `q019` — "Northstar Gridworks" sits at line 111, past the slice, so the agent fabricated "Northstar Components").

### In the dreaming runs: wiki pages crowd out dailies

With dreaming + wiki enabled (the 60d and 500d runs), the *same* failure recurs one layer up: **55–57% of failures retrieve only wiki pages and never open a daily.** The plain baseline, which has no wiki layer, retrieved an all-wiki failure **0 times** — direct evidence the wiki layer is the proximate cause of this miss mode.

- **Wiki gets a score boost and the staleness penalty is disabled.** At run time wiki pages carried a positive multiplier (`DEFAULT_WIKI_SCORE_BOOST` at `search.ts:111`, applied at `:217`, then 1.1–1.3×) while the `wikiStale`/`wikiUnverified` penalty was commented out (`search.ts:595–610`). A stale Condor synergy page ranked as the #1 hit with zero penalty for being stale.
- **Reranking is turned off for date-pinned queries** (`search.ts:232–238`) — exactly the queries (temporal-reasoning) where a generic wiki page should *not* outrank the date-anchored daily. This is why `temporal-reasoning` is the standout-weak category in the dreaming runs (3.00, collapsing to 1.00 in the 500d window) but *healthy* (4.5–6.0) in the no-wiki baselines.
- **Supersession misses leave stale facts live.** The dreaming run's wiki froze early Condor figures (`$18M/$26M` synergies) and never overwrote them with the day-14 truth (`$28M/$38M`). Root causes: the dedup gate is a hard cosine ≥ 0.8 with no fact-level fallback (`dream-engine.ts:938`); an unparseable LLM merge silently falls back to plain append, keeping the old paragraph (`dream-engine.ts:816`); and `page.updated` is restamped to today even on an append-only merge (`dream-engine.ts:1652`), so a stale page masquerades as fresh. The temporal tag uses the page's *consolidation* date, not the source-window date (`temporal-tag.ts:21–33`), so "current X" embeds toward the latest revision even for a day-7 question.
- **The "verify against the daily" rule is prose, not a gate.** The answer-loop prompt explicitly says "wiki pages are syntheses — always `memory_get` at least one daily" (`agent-loop.ts:149`), and even names the synergy-revision trap — yet 41/74 (60d) and 41/72 (500d) failures never called `memory_get`. The boosted wiki snippet already "looks like" a confident answer, so the model commits to it.

> **This closes a loop with the design docs.** These dreaming runs predate the wiki score-boost being cut from 1.5 → 1.1 → **0.9** (a deliberate *de-boost*, see [The LLM Wiki](../../memory-system/wiki.html#retrieval-and-the-score-boost)). The wiki-substitution failures documented here **are the empirical basis for that tuning.** A re-run at the current 0.9 default — and/or with the grounding penalty re-enabled at a calibrated, capped multiplier — is the single highest-value Recall experiment outstanding. (Note: the in-code `search.ts` fallback constant is still `1.1`, out of sync with the authoritative `0.9` — worth aligning before the re-run so the boost is unambiguous.)

### Does dreaming help? (partial evidence)

Over days 10–100, the dreaming variant scores **higher on broad synthesis and factual recall** than the no-dreaming baseline (`synthesis` 5.14 vs 3.28; `factual-recall` 5.25 vs 4.47) — the wiki layer genuinely helps aggregate questions. But it **actively harms date-pinned recall** via the wiki-substitution and supersession-miss mechanisms above. Net: dreaming trades temporal precision for synthesis breadth. Whether that trade nets positive at 180–500 days is **unknown** — the dreaming run never reached past day 100.

---

## MemPalace: revision contamination on date-blind retrieval

MemPalace is the strongest 180d run, and the triage explains why: it files each day as a date-roomed "drawer," so HNSW reliably lands in the right day-cluster, and its anti-guess synthesis prompt hedges instead of wildly fabricating on the easy half. Several of its categories actually *improve* as the corpus grows (`decision-tracking` +0.55, `contradiction-resolution` +0.44, `temporal-reasoning` +0.38 across quartiles) — more context helps its retrieval rather than drowning it.

Its dominant remaining failure is **revision contamination**: 67% of its 310 failures are confident-wrong, and the largest single cluster (~65 failures) is **the right fact from the wrong revision date.** The corpus revises Condor across days 3–7 → 14, and date-blind cosine retrieval can't pin to the queried date, so synthesis confidently blends two revisions (`q007` answers the day-14 range for a days-3–7 question; `q020` does the mirror image).

Crucially, **the fixes already exist but are disabled in the published baseline profile.** `answerMode`, `dayRollup`, and `tightenSynthesis` are all unset in `ea-180d-mempalace.yaml` (they live in the *tuned* profile). So:

- The synthesis prompt shows each chunk's source date (`synthesis.ts:68`) but never tells the model to *filter* on it (`synthesis.ts:33–37`) — hence the revision blending.
- There is no date-aware retrieval path: an explicit `YYYY-MM-DD` in the question doesn't trigger a room-scoped search (`adapter.ts:312`, `:368`), so 47% of failures retrieved zero relevant days, and weakly-embedded calendar bullets are missed entirely.
- The anti-elaboration clause that would cap over-confident padding is only appended when `tightenSynthesis` is set (`synthesis.ts:39–45`, gated at `adapter.ts:297`).

MemPalace's weak categories (`cross-reference` 4.26, `synthesis` 4.09) are precisely what `dayRollup` + `answerMode: agent` were built to fix. **The most valuable MemPalace next step is simply publishing the tuned profile alongside this baseline.**

---

## OpenClaw (summary)

Covered in full in the [OpenClaw — Executive Assistant report](./openclaw-ea.html). Headline: strong, stable `factual-recall` even at 1.5 years of corpus, but **`temporal-reasoning` and `recency-bias-resistance` collapse past the 6-month mark** (temporal-reasoning 3.89 at 500d), and the hallucination rate roughly doubles between the 180d and 500d runs (peak 27.1%). Its signature failure is **entity contamination** — "Jamie" (the most-mentioned entity) answers questions about everyone — plus confident fabrication over honest refusal (≈90% of failures). Same family of problems as Recall and MemPalace, different surface.

---

## Cross-cutting failure modes

Three patterns recur in **all three systems**, independent of architecture:

1. **Confident fabrication ≫ honest refusal.** Fabrication share of failures: Recall-baseline 56%, MemPalace 67%, Recall-dreaming 74–82%, OpenClaw ≈90%, ablations 93%. Every system would rather invent a specific than say "I didn't find it." For an executive assistant this is the most costly failure direction, and it is the largest single score lever everywhere.

2. **Revision contamination on the Project Condor arc.** The corpus deliberately revises Condor on day 13–14 (valuation `$420–475M → $620–760M`, floor `$490M → $650M`, synergy `$18M/$26M cost → $28M/$38M EBITDA`, target `Northstar Components → Gridworks`, leverage `2.8x → 3.2x`). **Every system fails this in both directions** — returning the revised value for an early-window question and the early value for a revised-window question — because none reliably anchors retrieval to the question's date window. This is the single best torture test in the corpus; the early/revised question pairs (`q007/q008/q009` vs `q020/q022/q035`) should be a standing canary set.

3. **`temporal-reasoning` is the universal cliff.** It is the weakest or near-weakest category for every system at scale: OpenClaw 3.89 (500d), Recall-dreaming 3.00→1.00 (a genuine wiki-substitution failure — the references check out, see [below](#qa-corpus-re-grading-found-it-largely-sound)), Recall-baseline 4.18, with MemPalace holding up only because its date-rooms partially anchor it. Date-pinned recall over a long, revised corpus is the unsolved problem across the board.

---

## Judge-calibration audit

Per the bench program, the score is only meaningful if the judge is. Re-grading found the judge **well-calibrated** on every run:

| Run | Judge false negatives | False positives | Note |
|---|---:|---:|---|
| recall-180d-baseline | 6 / 462 (1.3%) | 0 | appellate recovered them |
| mempalace-180d | 14 / 310 (4.5%) | 0 | all `q017`-shaped (see below) |
| recall-500d-dreaming | 3 / 72 | 0 | |
| recall-60d-baseline | 2 / 74 | 0 | |
| ablations | 0 / 15 | 0 | |

All false-negative rates are under the 5% escalation bar, and **no false positives** were found in the sampled perfects. No judge-model change is warranted before the next round.

---

## Harness accounting bug: `failures.jsonl` over-counts

`failures.jsonl` logs a record whenever the **appellate judge was invoked** (i.e. the *primary* judge flagged it), not when the **final** score is a failure (`harness.ts:560`). So questions the appellate judge *restored* to a passing composite still appear in the failure log. In the MemPalace run this inflates the apparent failure count by ~4.5% (310 logged → 296 real); `q017` alone appears 12 times despite a final composite of 6/6.

**Consumers should filter `failures.jsonl` on `appellateScore` composite < 6**, and the per-question `q017` cluster is itself a useful standing *primary-judge* false-negative canary (a verbatim-but-extra phrasing note being scored as invented content).

---

## Q&A corpus: re-grading found it largely sound

A first triage pass flagged several references as "defects," but a corpus re-check (below) **cleared almost all of them** — the Q&A corpus holds up well. Two points are worth recording for `verify-qa-corpus.mjs` follow-up, and one is a cautionary note about cross-story verification.

**Verification correction (important).** The `arcs-180d` and `arcs-500d` corpora are *different stories of the same persona*, not a short-vs-long cut of one story — Riley's conference is 2026-01-23 in the 180d story but **2026-01-14 in the 500d story**. An initial triage re-verified the 500d run's references against the 180d dailies by mistake and wrongly flagged `q010`, `q117`, and `q009` as fabricated. Re-checked against the run's own `memories-500d`, all three are **correct**: `day-0007` records "checked Riley's status on 2026-01-07 … portal posted a conference window for Wednesday, 2026-01-14," and `day-0070` lists the exact `earnings/q1_fy27_*` file paths `q117` asks for. **No 500d Q&A defect stands.** Consequently, the recall-500d `temporal-reasoning` collapse (3.00→1.00) is a **genuine wiki-substitution failure**, not a corpus artifact — which strengthens that finding.

The Condor valuation/financing pairs (`q007`, `q008`, `q009`, `q020`, `q021`, `q028`, …) are likewise **correct, not defective** — their references were verified against `memories-180d` and are high-signal temporal-discrimination tests. `q007` is undated and therefore *hard* (the corpus legitimately holds an early and a revised range), but the reference is right; it correctly exposes the systems' revision-contamination weakness. **Keep them.**

Genuine candidates for light cleanup (both minor, judgment-call ambiguities, both verified against the correct corpus):

| Q&A id | Issue | Fix |
|---|---|---|
| `q205` (mempalace) | Ref `2026-04-30` for a fact journaled in the `2026-04-29` daily — date-of-event vs. date-of-record ambiguity. | Accept both dates, or disambiguate the question wording. |
| `q060` (recall-60d) | "Was a family date *added* on 2026-02-04" — the conference exists that day but as a pre-existing commitment; "added vs. already-present" is ambiguous. | Reword to "newly created (not previously on calendar)"; keep ref "No". |

Separately, `q032`/`q036`/`q114`/`q176` are **not** reference defects but a recurring **product** "citation hallucination" shape — a correct yes/no padded with a fabricated supporting date — worth a judge-rubric note that separates a correct answer from an unsupported citation.

---

## Ablations: directional only, underpowered

The three 60-day ablation runs are reconstructed/partial with tiny N. **No conclusion is statistically supported**; the value is in the direction and the failure traces, not the deltas.

- **Supersession on:** at the four checkpoints it shares with the 60d baseline (6d/12d/18d/24d), it runs flat-to-slightly-better (overall 6.00/5.67/5.42/5.41 vs baseline 6.00/5.67/4.58/4.81; identical hallucination at 18d/24d). **Weakly positive, well within noise** — the d18/d24 gains are a 2–3 question swing on 24–37 evals.
- **Cross-encoder rerank on vs off:** the arms share **only the 6d checkpoint** (rerank-on 6.00/0% vs rerank-off 5.00/16.7%, a one-failure difference on 6 evals). **Indeterminate.** Worse, rerank-on's own trajectory degrades with depth (6.00 → 5.05, hallucination 0 → 19%) as the cross-encoder pulls token-similar revised/wiki pages to the top.

**A properly-powered re-run** must: use the *same* checkpoint ladder and per-checkpoint sample for every arm (≥ 60 evals/checkpoint, out to 60d), run non-reconstructed (`reconstructed: false`), vary *only* the ablated flag, and pair each early-frame Condor question with its revised-frame mirror so an arm that just "always returns latest" is penalized symmetrically.

---

## What to test next (ranked by expected lift)

1. **Publish a 180-day Recall-*dreaming* run.** The biggest gap in the set — without it there is no fair Recall-vs-MemPalace-vs-OpenClaw comparison at the medium horizon.
2. **Re-run Recall-dreaming at `wikiBoost = 0.9` with the grounding penalty re-enabled** (calibrated `×0.6–0.7` when `wikiStale > 0`). Targets the 55–57% all-wiki failure share head-on; first align the stale `search.ts` fallback constant to 0.9.
3. **Make Recall compaction atom-preserving** — add "KEEP every specific number, dollar figure, date, time, and named entity verbatim" to the weekly/monthly prompts (`compactor.ts:705/744`), and drop the summary parent-boost double-count (`search.ts:495/562–565`). Directly attacks the baseline's factual/synthesis collapse.
4. **Gate Recall's "verify against the daily" rule in the harness, not the prompt** — for value/date/name/quote questions, reject a final answer whose only retrieval is a wiki/summary; force one `memory_get`. Converts confident fabrications into correct answers or honest refusals — the biggest single score lever.
5. **Publish MemPalace's tuned profile** (`dayRollup` + `answerMode: agent` + `tightenSynthesis` + date-aware retrieval). Built specifically to close its `cross-reference`/`synthesis` gaps.
6. **Add the Condor early/revised pairs as a standing canary set** (`q007`/`q008`/`q009` vs `q020`/`q022`/`q035`) and lightly disambiguate `q205`/`q060`. Re-grading otherwise found the Q&A corpus sound — no reference rewrite is needed before drawing the temporal-reasoning conclusions above.
7. **Re-run the ablations powered** (see above) — current artifacts cannot adjudicate supersession or rerank.

---

## Reproduce & provenance

Every number here comes from the committed artifacts under `bench-results/<system>/<run-id>/` (`result.json`, `progress.jsonl`, `failures.jsonl`, `heatmap.png`). The four reconstructed runs were rebuilt with [`scripts/result-from-progress.mjs`](https://github.com/Stevenic/recall/blob/main/scripts/result-from-progress.mjs) and carry `metadata.reconstructed: true`; their per-checkpoint aggregates are exact but cover only the checkpoints reached. The operator playbook, including the re-grade methodology this postmortem follows, is [`bench-program.md`](https://github.com/Stevenic/recall/blob/main/bench-program.md).
