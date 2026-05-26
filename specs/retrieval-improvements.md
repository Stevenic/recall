# Retrieval improvements: spec for deferred items

This spec covers two items that benefit from upfront design rather than
direct implementation:

- **§1** — Self-consistency check on disagreement (task #53)
- **§2** — Self-improving wiki via search-log feedback (task #54, "the big one")

Both share an architectural shape: cheap signals collected during normal
operation feed a higher-quality decision when the system would otherwise
guess.

---

## §1 — Self-consistency check on disagreement

### Problem

The agent loop produces a single answer per question. When that answer
has a specific numeric value, date, or named entity, there's no
verification step to catch a stale or hallucinated claim. The bench's
recurring failure mode is the agent returning an early-window value
because it read a wiki page that the merge step didn't fully refresh.

A naive fix is "answer the question twice with different retrieval
paths and tiebreak on disagreement," but that doubles inference cost
on every question. The real opportunity is to spend extra inference
**only when the system has a cheap signal that the first answer might
be wrong.**

### Design

A `consistencyGuard` step runs after the agent loop's first answer and
decides whether to spend a second pass.

```
[agent loop]
  ↓ answer A
[consistencyGuard.shouldVerify(A, trace)]
  ↓ true → re-run with daily-first preamble
  ↓ false → return A
[compare A and B; if disagree, return the one matching memory_timeline's [latest mention]]
```

### Cheap signals that gate the second pass

The guard runs over the agent's first answer + its tool-call trace and
returns `true` only when at least one of these fires:

1. **Numeric-value answer with no daily source.** The answer text
   contains a `$X` / `X%` / `X.Yx` token, AND the trace shows only
   `memory_get` calls on `memory/wiki/...` paths. This is the q021
   failure pattern verbatim: agent read wiki, returned a number, never
   touched a daily.

2. **Date-pinned question with no exact-date `memory_get`.** Question
   contains `as of YYYY-MM-DD` / `on YYYY-MM-DD` / `recorded on`, AND
   the trace has no `memory_get memory/YYYY-MM-DD.md`. Agent skipped
   the obvious primary source.

3. **Multi-fact question with single-cluster retrieval.** The decomposer
   produced sub-queries but the trace shows search hits clustered
   around only one of them. Likely missing the other fact.

4. **Hedging phrase in answer.** Regex over the answer for "couldn't
   find", "no record of", "not surfaced", "closest match", "I checked
   memory and didn't". When present, agent is signaling low confidence.

None of these require an extra LLM call to evaluate; pure regex + trace
inspection, runs in microseconds.

### The verification pass

When the guard fires, run a second agent loop with a different
preamble shape:

- **No wiki preamble.** Force the agent to find evidence in dailies.
- **Front-loaded `memory_timeline`.** The first tool call is
  pre-computed: timeline of the question's topic, top 5 entries
  newest-first.
- **Same iteration cap.** ~3-4 turns is enough when the agent starts
  with the timeline.

The guard returns answer B.

### Tiebreaking

Compare A and B with a small LLM call (`gpt-5.4-mini`):
- If A and B express the same fact (different wording, same value): return A.
- If A and B disagree on a value: return B (the daily-grounded path) unless
  B itself hedges, in which case return A.
- If both hedge: return whichever cites a `(Source: YYYY-MM-DD)` more
  recent than the other.

### Expected impact

The cheap signals will fire on roughly 15-30% of questions in the EA
bench (most factual-recall and decision-tracking pairs). Per-question
cost on those:
- 1 small LLM call (guard's tiebreaker) — ~0.5s
- 1 full agent loop (verification pass) — ~5-15s

Total amortized cost: ~25-50% more inference per checkpoint, focused
on the questions that would otherwise score low. Lifts the partial-
completeness cluster (q010, q017, q022) from 4/6 → 6/6 in the cases
where the daily evidence is unambiguous.

### Where it lives

- `consistencyGuard.ts` in `bench-harnesses/recall/src/` — extracts
  signals from the agent's trace, returns a `VerifyDecision`.
- A second `runAgentLoop` invocation in `index.ts:runQueryDetail`,
  gated on the decision.
- The tiebreaker LLM call uses `cfg.model` (the agent model), so the
  comparison runs in the same model class as the answer itself.

### Why not implement now

Two reasons to spec first:

1. **The guard's signals overlap heavily with what reranking + grounding
   demotion already address.** If the wiki page never makes it into the
   agent's preamble (because rerank found a better daily), the signal
   never fires. We should measure the impact of #49 + #50 first, then
   see what residual failures remain — those are the ones self-
   consistency should target.

2. **The verification pass shape depends on the residual.** If it's
   mostly date-pinned misses, the verification pass should be a
   targeted `memory_get YYYY-MM-DD.md`. If it's mostly multi-fact, it
   should be a forced-decomposition pass. We'd over-engineer if we
   pick the wrong shape before seeing data.

---

## §2 — Self-improving wiki via search-log feedback

### The problem this solves

Neither OpenClaw nor MemPalace has anywhere for *retrieval quality
signals* to land. OpenClaw is stateless; MemPalace's knowledge graph
is built from synthesis prompts, not from observed usage. Recall has
the wiki + dreaming pipeline already — adding feedback closes the loop
between "what the wiki claims" and "what the agent actually finds
useful."

Over enough usage, the wiki should converge on the agent's actual
demand surface — which pages get hit, which get discarded, which
dailies get read after a wiki hit. That convergence is a different
optimization target than "what looks plausible to the synthesis LLM"
and it's the move that would put Recall in a different league.

### Signals to collect

Every retrieval already passes through `SearchService` and (when
dreaming is enabled) gets logged to `SearchLogger`. We extend the log
with three new event types:

1. **`wiki_hit_followed`** — A wiki page was in the agent's preamble or
   search results, AND the agent's *next* tool call was a `memory_get`
   on a daily cited by that wiki page. Positive signal: the wiki
   surfaced a relevant pointer.

2. **`wiki_hit_discarded`** — A wiki page was in the agent's preamble
   or search results, AND the agent never `memory_get`'d it, AND the
   final answer doesn't cite the page's slug. Negative signal: the
   page was noise.

3. **`wiki_hit_overridden`** — A wiki page WAS read by the agent, AND
   the agent's final answer contains a value or date that doesn't
   appear in the wiki page. Strong negative signal: the agent
   actively disagreed with the wiki and went to dailies to override.

The signals are written to `memory/.dreams/usage-log.jsonl` from the
adapter's `runQueryDetail` post-answer hook. Each entry: `{ts, slug,
event, question, answeredFromWiki: bool}`.

### Per-page quality score

`WikiEngine.computeQualityScore(slug, window)` aggregates the usage log
over a configurable window (default: last 30 days) and emits per-slug:

```ts
interface PageQuality {
  slug: string;
  hits: number;         // total times the page was in agent context
  followed: number;     // wiki_hit_followed count
  discarded: number;    // wiki_hit_discarded count
  overridden: number;   // wiki_hit_overridden count
  // Composite: positive for useful pages, negative for harmful ones.
  // followRate - 0.5*discardRate - 2*overrideRate, clipped to [-1, 1].
  score: number;
  lastDecided: string;  // ISO date the score was last computed
}
```

The score lives in the page's frontmatter under `quality:`. Retrieval
reads it from index metadata (same pattern as `grounding`) and applies
a multiplier — positive scores boost, negative scores demote.

### How this feeds back into dreaming

The next dream pass uses page quality to drive three decisions:

1. **Which pages to rebuild from sources.** Pages with `quality.score < -0.5`
   get a full rebuild: clear the body, re-synthesize from the same
   cited sources, run grounding verification. If the rebuild produces
   a page with similar score, archive the topic — it's not synthesis-
   amenable.

2. **Which dailies to promote to wiki content.** A daily that the agent
   reads repeatedly *after* discarding a wiki hit on the same topic
   is a strong signal that the wiki is missing what the daily has.
   Dreaming creates a new wiki page or updates the existing one with
   the daily's content.

3. **Which wiki pages to merge or split.** A page that gets `overridden`
   frequently with values from one specific source might be conflating
   two topics that should be separate pages. A page with `discarded` >
   `hits/2` may need merging into a broader page.

### Bootstrapping concern

Search-log feedback requires usage. A cold-start system has no signal.
For the bench, the bootstrap is: the agent's tool-call trace IS the
signal — every question produces a trace, every trace is one
observation. After ~50 questions (one bench checkpoint), there's
enough data to start scoring pages.

For production, the bootstrap is the same: every user query produces
trace data. The system doesn't need an initial training run; it learns
from its first day of real usage.

### Cost

Storage: ~200 bytes per signal × ~3 signals per question × ~50 questions
per day = 30 KB/day. Even at 5 years that's 55 MB. Negligible.

Compute: aggregation runs once per dream pass (already a heavy step
relative to log read). Per-pass overhead ~100ms.

LLM: zero. The scoring is pure aggregation.

### Where it lives

- `usage-logger.ts` in `packages/core/src/` — appends usage events
  from the adapter via a new method on `SearchLogger`.
- `wiki-engine.ts` adds `computeQualityScore(slug, window)`.
- `dream-engine.ts` `_gatherSignals` adds a new candidate type:
  `low_quality_wiki` — signals from `quality.score < -0.5`.
- `signal-collector.ts` already has the candidate-scoring pattern;
  the new candidate type slots in with existing weights.

### Why this is the categorical-better move

Both OpenClaw and MemPalace optimize at build-time: their abstractions
are fixed once written. OpenClaw doesn't build any abstractions (its
strength). MemPalace builds them via synthesis prompts (its weakness
when the synthesis is wrong).

Recall with usage feedback is the only system in this comparison that
*improves with use*. Every question makes the wiki slightly more
useful, because the next dream pass has signal that wasn't available
before. That compounds. Over a year of usage, the wiki should converge
to a state where almost every page that exists is one the agent
actually consults, and almost every page the agent needs exists.

That's not a knob you can match by tuning OpenClaw's retrieval or by
making MemPalace's prompts better. It's a different system design.

### Sequencing

1. Wire up `wiki_hit_followed` / `_discarded` / `_overridden` signal
   emission from the adapter (~80 lines).
2. Aggregator in `wiki-engine.ts` (~50 lines).
3. Index-metadata + search penalty mirror of the grounding pattern
   (~30 lines).
4. New dream-engine candidate type + signal-collector integration
   (~60 lines).
5. New analysis template that consumes quality signals + emits
   rebuild / merge / split wiki_ops (~prompt + parser).

Total: ~250 lines + one new prompt template. The pieces are small;
the design is what's load-bearing.
