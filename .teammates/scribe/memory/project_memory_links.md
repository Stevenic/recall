---
name: Memory Links — Generalized Pointer Pattern
description: Recall's pointer mechanism (hierarchical, wiki, associative) generalizes to a single [[ref]] syntax with namespace-aware resolution; back-pointers in daily logs are the high-leverage use case
type: project
---

stevenic identified that the breakthrough under Karpathy's wiki pattern is not the wiki itself but the more general pattern of **memories citing other memories with on-demand pointer chasing**. Wikis are one application; the more powerful one is **back-pointers in daily logs** — when an agent writes today's log and recalls relevant past work, it leaves a `[[YYYY-MM-DD]]` reference that future-recalls can chase.

**Why:** Recall has three distinct pointer mechanisms today:
- Structural (parent→child) in `specs/hierarchical-memory.md`
- Content (`[[slug]]` between wiki pages) in `specs/wiki.md`
- (Proposed) Associative pointers in any memory pointing to any other memory

These should unify under a single `[[ref]]` syntax with a namespace-aware resolver: date slugs (`[[2026-04-12]]`), ISO weeks (`[[2026-W15]]`), typed memory stems (`[[feedback_testing]]`), wiki slugs (`[[auth-middleware]]`). Pointer chasing already exists in hierarchical memory — this adds more lookup namespaces.

**How to apply:**
- When the user asks about back-pointers, memory cross-references, or "agents chasing memories," recognize this as a generalized pointer pattern, not wiki-specific.
- The wiki spec's `[[slug]]` should ultimately reference a foundational memory-links spec rather than define syntax independently.
- Daily-log back-pointers lower the bar for cross-temporal synthesis vs. wiki pages — agent-in-the-moment judgment vs. requiring topical formalization.
- Strengthens the case for WISDOM.md shrinking: associative threads can live inline in daily logs without needing a wiki page.
- Recommended placement: standalone `specs/memory-links.md` v0.1 (foundational, referenced by wiki + hierarchical-memory + dreaming) rather than folding into one of the existing specs. Decision pending stevenic confirmation as of 2026-04-26.
- Primary write model recommendation: agent writes back-pointers in real time during task work (high signal), with compaction/dreaming as a secondary source (uniform but lower judgment).
