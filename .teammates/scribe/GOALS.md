# Scribe — Goals

**Updated:** 2026-04-28

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
- [x] Day-generator spec v0.2 — reframed persona as the AI agent (not the human served); §3.1 agent-narrator template; `principal?` + `cast?` schema fields; `institution?` accepted; new §3.8 "What kind of work the agent does"; §4.1 third-person rule; §7.2 user-message variants with reinforcing trailing instruction; §12 example rewritten as Atlas/research-scientist log
- [x] Recall-bench spec v0.4 — added group chat and information disclosure scenarios. New §2.6 Chat Threads (chat IDs, primary/group/side/isolated chat types, isolation model). Two new evaluation categories (group chat attribution, information boundary) bringing total to 10. §3.4 stress map extended; Litigation Attorney + Financial Advisor identified as boundary-stressed personas. New §4.6 Group Chat Rendering and §4.7 Isolated Chat Generation. Q&A schema gains `query_chat` and `expected_disclosure`. Scoring adds Boundary Compliance dimension (composite max 6→7) plus disclosure leak rate / over-refusal rate as top-level metrics. Adapter interface extended with `ChatSegment[]` and `QueryContext`. 7 new open questions (Q6–Q12) and v0.4 acceptance bullets added.
- [x] Recall-bench spec v0.5 — full **chat → session** rename (`chat_id` → `sessionId`, `ChatSegment` → `SessionSegment`, `query_chat` → `query_session`, `forbidden_chats` → `forbidden_sessions`). New session model: principal-owned agent (one principal per persona; orphan-principal Q12 deferred to v1.1); explicit `kind: 1to1 \| group` (S1); `principal` reserved slug only (S3a); pre-H1 body = internal narration (S3b); optional `firstDay`/`lastDay` lifecycle (S4); empty sessions skipped (S5); `primarySession` + `referencedSessions[]` arc mapping (S2); 65/35 primary-session budget per persona; `sharedKnowledge:` block for non-sensitive global facts. **Day-file format resolved**: single file per day, `# session: <id>` H1 per active session. Adapter `SessionSegment[]` + `QueryContext` updated. Q6–Q12 all resolved or deferred. §10 acceptance bullets cover 65/35 split, `primarySession` declarations, day-file format, adapter shape.
- [ ] Reframe remaining personas to agent-narrator model — `backend-eng-saas`, `er-physician`, `financial-advisor`, `litigation-attorney` need their `persona.yaml` rewritten so `name`/`role` describe the agent (not the human), and need new `principal:` + `cast:` blocks. Without these, Pass 1 generation falls through to the generic agent-narrator framing and produces cleaner-than-before logs but loses the principal/cast richness. Owner: whoever runs `recall-bench generate` against those personas next.
- [ ] Add `sessions:` (with `kind`/`participants`/`isolated`/`firstDay`/`lastDay`/`sensitive_topics`) and `sharedKnowledge:` blocks to ALL v1 persona.yaml files — required for the v0.5 session model. **research-scientist done as test (2026-04-28)** — `principal` + `lab-meeting` + `course-staff` + `tenure-review` + isolated `collab-chen` (day 300–700, 4 sensitive topics) + 3-item sharedKnowledge. Remaining: `backend-eng-saas`, `er-physician`, `financial-advisor`, `litigation-attorney`. Litigation Attorney + Financial Advisor get 3–5 isolated sessions each; others get `principal` + 1–3 group sessions per §2.7 example tables.
- [ ] Update arcs.yaml for all v1 personas to declare `primarySession` (required) and `referencedSessions[]` (optional) per §2.3.1; verify the **65/35 primary-session split** holds across each persona's arc set. **research-scientist done (2026-04-28)** — 19 arcs, 12 principal-primary (63%), 7 group-primary (37%): 3 lab-meeting, 3 collab-chen, 1 course-staff, 1 tenure-review. Header comment updated from "21 arcs" to "19 arcs" (actual count). Remaining: 4 personas.
- [x] Update `specs/day-generator.md` to v0.3 — multi-session day rendering. Aligned with recall-bench v0.5 (§2.6, §2.7, §4.6, §4.7). §3.1.1 schema gains `sessions?` + `sharedKnowledge?`. §3.1.2 prompt template adds `# Sessions` + `# Shared knowledge` blocks and a new "How to partition the log by session" section (canonical ordering, internal narration, group attribution rules, isolated no-leak invariant, cross-session arc echoes). §3.3 active arcs include `primarySession` / `referencedSessions` / `echo_today`. §4 output format restructured (frontmatter `sessions:` derived; pre-H1 = internal; `# session:` H1 per active session). §4.3 NEW Session-Aware Rendering (codifies all session rules). §7.1 user message adds `Active sessions today` block. §12 example replaced with multi-session research-scientist day (principal + lab-meeting + collab-chen, with verbatim attribution, dissent capture, isolated-session enforcement, cross-session arc echo). Legacy single-session fallback documented for personas without `sessions:`.
- [ ] Hand off to @beacon for day-generator code update — extend `buildSystemPrompt`, `buildUserMessage`, and the multi-day pipeline to produce the multi-session output format. Single bundled handoff with adapter `SessionSegment[]` + `QueryContext` shape (recall-bench v0.5 §6.2). **Blocked on:** at least 1 boundary-stressed persona's sessions/arcs being ready (Litigation Attorney is the natural choice — 3–5 isolated sessions exercise the no-leak invariant in tests).
- [ ] Resolve v0.5 open questions with stevenic (v0.6 — only carry-forward Q1–Q5 remain; v0.5 itself introduces no new ones, so v0.6 round will likely focus on day-generator v0.3 review and persona content authoring)
- [ ] Create sample persona (1 of 5) for validation — generate day memories + Q&A pairs
- [ ] Q&A generation and validation pipeline (extend to support boundary-test pair generation per §5.3)
- [x] Draft `specs/information-disclosure-testing.md` v0.1 — focused companion to recall-bench v0.5 §2.5/§4.7/§5.3. Threat model with 10 failure modes (F1–F10: direct cross-session leak, topical pull, aggregation, authorized partial, over-refusal on principal, over-refusal on shared knowledge, authorized cross-flow, attribution-under-isolation, time-locked authorization, lifecycle leak). Scenario taxonomy with worked Litigation Attorney examples for each F-mode. Persona requirements (3–5 isolated sessions for stressed; 0–1 for non-stressed). Q&A generation pipeline + volume targets per persona. Adapter contract pointer to parent §6.2 plus backward-compat degradation. Boundary scoring rules (refuse / answer / partial with 0.5 over-cautious partial-credit). Disclosure leak rate + over-refusal rate as top-level metrics. Calibration via boundary-aware vs boundary-unaware reference adapters (≥40-point gap target). 9 acceptance criteria, 8 open questions (O1–O8 — judge prompt scope, partial-credit tuning, F8 strictness, scoped authorization, cross-persona namespacing, retrieval ambiguity, authorization phrasing grammar, generation cost).
- [ ] Resolve information-disclosure-testing open questions with stevenic (v0.2)
- [ ] Hand off to @lexicon for boundary-judge prompt template (`docs/prompts/boundary-judge.md`) — blocked on stevenic review of §7.4 methodology.

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
