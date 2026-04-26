# Scribe — Goals

**Updated:** 2026-04-26

---

## Active

### Hierarchical Memory
- [x] Draft hierarchical memory spec v0.1 — eidetic storage, pointer nodes, two-phase recall, BM25 hybrid
- [ ] Resolve open questions with stevenic (v0.2)
- [ ] Create implementation plan for @beacon (sequenced work packages)
- [ ] Update compaction prompt spec for pointer-aware output

### Recall Bench
- [x] Draft benchmark spec v0.1 — personas, Q&A framework, scoring, adapter interface
- [ ] Resolve open questions with stevenic (v0.2)
- [x] Define persona story arcs for all 5 v1 personas (107 arcs total)
- [x] Spec day-generator prompt structure (Pass 1 of two-pass pipeline)
- [ ] Create sample persona (1 of 5) for validation — generate day memories + Q&A pairs
- [ ] Q&A generation and validation pipeline

### Spec Finalization
- [x] Draft memory-service spec (v0.1)
- [x] Resolve open questions with stevenic (v0.2)
- [x] Apply feedback round (v0.3 — enriched CompletionResult, simplified file layout, language bindings)
- [x] Final review pass — ensure acceptance criteria in §12 fully cover all interfaces defined in the spec

### Project Documentation
- [ ] Write project README.md — overview, quickstart, architecture summary
- [ ] Write packages/core/README.md — API usage, configuration examples
- [ ] Write developer onboarding guide (docs/getting-started.md)

### Implementation Handoff
- [x] Create implementation plan breaking MVP (§12) into sequenced work packages for @beacon
- [ ] Write CLI spec detail for `recall watch` (filesystem watcher behavior, debounce edge cases)
- [x] Define compaction prompt templates (daily→weekly, weekly→monthly, wisdom distillation) for @lexicon

### Dreaming System
- [x] Draft dreaming spec v0.1 — signal collection, candidate scoring, synthesis pipeline, output formats
- [ ] Resolve open questions with stevenic (v0.2 — must absorb wiki integration changes from §10 of wiki spec)
- [ ] Create implementation plan for @beacon (sequenced work packages)
- [ ] Define dreaming prompt templates (cross-reference, gap analysis, contradiction, theme synthesis) for @lexicon

### Wiki System
- [x] Draft wiki spec v0.1 — page format, categories, cross-references, lifecycle, search/dreaming/WISDOM integration, surface area separation rule
- [x] Wiki spec v0.2 — collapse typed memories into wiki (stub vs synthesized model, per-category templates, typed-memory migration)
- [ ] Resolve remaining open questions with stevenic (v0.3 — Q1 scoreBoost default, Q2 chunking strategy, Q3 Knowledge Map location, Q4 access control, Q6 link resolution timing, Q7 multimedia, Q8 WISDOM migration, Q9 slug collisions, Q10 stub re-indexing latency)
- [ ] Revise dreaming spec to v0.2 — make wiki edits the canonical synthesis output (replaces standalone insight files); add stub enrichment to dreaming pipeline
- [ ] Update WISDOM.md compaction prompt — read from wiki pages (not typed memories) post-migration; push topical content toward wiki layer
- [ ] Define wiki prompt templates (stub generation, page synthesis, merge, regeneration) for @lexicon
- [ ] Create implementation plan for @beacon (sequenced work packages — Phases A-E in §20; typed-memory migration sub-phase parallelizable with B/C/D)

### Milestone Tracking
- [ ] Set up acceptance criteria checklist (§12 MVP) as trackable artifact
- [ ] Define v0.2 / v0.3 scope boundaries and prerequisites

---

## Blocked / Waiting

_None_

---

## Completed

- [x] Migration v0.0.0 → v0.8.0 (2026-04-02)
- [x] Memory-service spec v0.1–v0.3 (2026-04-02)
