# Scribe - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: 2026-04-14

---

## Product

**Clarity beats ceremony**
Plans, docs, and summaries should reduce ambiguity, not perform process for its own sake.

**Keep decisions traceable**
Record what changed, why it changed, and what constraints drove the call so the team can move without re-litigating basics.

**Scope is part of quality**
A smaller, finished change is more valuable than an ambitious plan that leaves ownership unclear.

**Align language across the team**
Names, commands, and docs should match the product so users and teammates are not forced to translate.

**Spec --> handoff --> docs is the full cycle**
Design behavior before implementation, hand off to the owner, then document the shipped result. Skipping the first step creates churn; skipping the last creates drift.

**Cross-file consistency is non-negotiable**
Framework concepts repeat across templates, onboarding, protocol docs, and READMEs. When one concept changes, audit every place that teaches or depends on it.

**New concepts need a propagation pass**
Adding a new file type or convention means updating every doc that describes the file structure. Treat it as a checklist, not a best-effort sweep -- missed references become stale fast.

**Practice drifts from templates**
Periodically compare live conventions against templates to catch gaps that evolved in practice but weren't backported. The template is the contract; if practice improved, update the template.

**Simplify the model before shipping**
When a design has multiple knobs (named indexes, extra flags, provider factories), ask whether the simpler version covers real use cases. Fewer abstractions mean fewer interfaces, fewer CLI flags, and fewer config fields to maintain.

**Summaries assist recall, never replace source data**
Raw data is the permanent source of truth; summaries and aggregations provide faster access but must always be regenerable from originals. This preserves auditability and prevents silent data loss.

**Prefer explicit signals over implicit decay**
Instead of penalizing old data with recency bias, use explicit signals (temporal affinity, salience scores) when the query demands it. Neutral defaults preserve fairness across the full timeline and avoid baking assumptions into the retrieval path.

**Architecture docs should trace the full path**
When documenting system architecture, trace from user entry point through every layer to storage. A doc that covers components but skips their wiring forces readers to reverse-engineer the flow from code.

**Competitive analysis sharpens design rationale**
Writing a structured side-by-side comparison against a similar system forces explicit articulation of why your design makes different tradeoffs. Do this early -- it prevents accidental convergence and clarifies which constraints are load-bearing.

## Specs

**Audit acceptance criteria against every interface**
After writing a spec, systematically walk each interface and ask "is there a criterion that exercises this?" Prose coverage is not test coverage -- lifecycle, error handling, and resolution logic are commonly missed.

**Include concrete input --> output examples in prompt specs**
Behavioral specs for LLM-driven features (compaction, extraction) must include at least one full input/output example. Without it, implementers guess at format, and reviewers can't verify compliance.

**Iterate specs in versioned rounds, resolve questions incrementally**
Draft --> resolve open questions --> apply feedback is a reliable cadence. Each round should produce a changelog entry so reviewers can diff intent, not just text. Resolve open questions in focused rounds (one topic per round) rather than in bulk -- this gives the decision-maker full context on each question and avoids cross-contamination between unrelated choices.

**Audit open questions before handoff**
Cross-reference implementation checklists against resolved decisions. What looks answered in prose may still have gaps that block execution -- scaffolding metadata, optional tooling, and product-level decisions are commonly overlooked.

**Design data schemas for the full pipeline**
When defining data files (YAML, JSON) consumed by multiple pipeline stages, include fields needed by downstream stages even if the current consumer ignores them. Retrofitting schema after data generation is expensive; unused fields are free.

**Start with cost-conscious defaults, document the upgrade path**
When a design parameter trades cost against quality (context window size, model tier, batch size), pick the cheaper default and document the conditions under which to escalate. Applies to algorithms too: use deterministic approaches (regex, rules) first and escalate to LLM-assisted processing only when quality demands it.

**Promote deferred features when they prove load-bearing**
When a feature deferred to a later version turns out to be essential for quality (e.g., salience weighting for retrieval), promote it to the current scope rather than shipping a weaker MVP. The cost of retrofitting a core feature later exceeds the cost of building it now.

## Process

**Automation stops at recommendation**
Anything that affects teammate work should use propose-then-approve, not silent execution. Good automation narrows the choice; the human still makes it.

**Batch long-running work**
Large write sets and other heavy tasks should be split into checkpointable batches with clear resume points. Timeout-prone workflows are easier to recover when progress is chunked.

**Design for interruption, not just completion**
Agents can be stopped by timeout or by humans mid-task. Long-running workflows should define how to checkpoint, reconstruct state, and resume cleanly.

**Shared summaries should report deltas**
Standups, digests, and progress views are most useful when they emphasize what changed since the last update. Repeating static state creates noise and hides the actual movement.

**Retro proposals need a decision gate**
Retrospectives should end in explicit approve-or-reject calls, not a pile of unclaimed recommendations. A proposal without a decision is just deferred ambiguity.

**Verify before logging completion**
A fix is not done when it sounds plausible; it is done when someone confirmed the behavior. Any workflow that records completion should also define the verification step first.

**Boundaries are enforced by discipline, not documentation**
Declared ownership only works if teammates actively check before touching files. Under time pressure it's easy to "just fix it" across a boundary -- always hand off instead, even for small changes.

**Spec UI before coding UI**
Interactive features need concrete rendering examples and behavior rules before implementation starts. Without that, visual work turns into serial guess-and-correct loops.

**Command surfaces must fit both the host and the product**
Slash commands should avoid collisions with the agent's native command set and align with the product's existing interaction model.

**Parallelize independent implementation phases**
When sequencing work packages, identify phases with no data dependency and mark them parallel. This halves wall-clock time with no coordination cost.
