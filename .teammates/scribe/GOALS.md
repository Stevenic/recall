# Scribe — Goals

**Updated:** 2026-04-27

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
- [x] Memory-service v0.4 — added §3.5 Identity (`IdentityConfig`, `ResolvedIdentity`, fallback rules); threaded `identity?` into `MemoryServiceConfig`; exposed `service.identity`; new §15 Changelog

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
- [x] Dreaming spec v0.2 — threaded identity through Phase 2 synthesis (Identity-framed design principle, `<IDENTITY>` block in every analysis prompt, 2 new acceptance criteria); wiki integration deferred to v0.3
- [ ] Resolve open questions with stevenic (v0.3 — must absorb wiki integration changes: insights → wiki edits; stub enrichment in dreaming pipeline)
- [ ] Create implementation plan for @beacon (sequenced work packages)
- [ ] Define dreaming prompt templates (cross-reference, gap analysis, contradiction, theme synthesis) for @lexicon

### Wiki System
- [x] Draft wiki spec v0.1 — page format, categories, cross-references, lifecycle, search/dreaming/WISDOM integration, surface area separation rule
- [x] Wiki spec v0.2 — collapse typed memories into wiki (stub vs synthesized model, per-category templates, typed-memory migration)
- [x] Wiki spec v0.3 — shared wikis for group knowledge sharing (private + shared model, per-target Vectra index, federated search, member/reader roles, `recall wiki promote`, qualified `[[name:slug]]` links, Phase F sequencing)
- [x] Wiki spec v0.4 — added §11 Identity (one- or two-sentence role description threading into all synthesis prompts via `<IDENTITY>` block; `IDENTITY.md` file at memory root; per-agent, not per-wiki)
- [ ] Resolve remaining open questions with stevenic (v0.5 — Q1 scoreBoost default, Q2 chunking strategy, Q3 Knowledge Map location, Q6 link resolution timing, Q7 multimedia, Q8 WISDOM migration, Q9 slug collisions, Q10 stub re-indexing latency, Q11 shared index location, Q12 concurrent writes, Q13 dreaming targets shared, Q14 cross-wiki contradictions, Q15 promote history)
- [ ] Revise dreaming spec to v0.2 — make wiki edits the canonical synthesis output (replaces standalone insight files); add stub enrichment to dreaming pipeline
- [ ] Update WISDOM.md compaction prompt — read from wiki pages (not typed memories) post-migration; push topical content toward wiki layer
- [ ] Define wiki prompt templates (stub generation, page synthesis, merge, regeneration) for @lexicon
- [ ] Create implementation plan for @beacon (sequenced work packages — Phases A-F in §22; typed-memory migration sub-phase parallelizable with B/C/D; Phase F shared-wikis parallel with C/D/E once A/B stable; Identity loader threaded through MemoryService at construction)
- [x] Update memory-service spec to add `identity` to `MemoryServiceConfig` (landed in v0.4 §3.5 + acceptance criteria)
- [x] Update dreaming spec v0.2 to thread identity into synthesis prompts (landed — Identity-framed principle + Phase 2 prompt note + acceptance criteria)

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
