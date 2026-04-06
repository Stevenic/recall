# Compaction Prompt Templates — Spec

**Status:** Final — prompt text delivered  
**Author:** Scribe (spec), Lexicon (prompts)  
**Date:** 2026-04-02  
**Spec:** [memory-service.md](./memory-service.md) §5  
**Prompt defaults:** [docs/prompts/compaction-defaults.md](../docs/prompts/compaction-defaults.md)

---

## Overview

The compaction pipeline uses three prompt templates, each fed to the `MemoryModel` abstraction. This spec defines the **behavior requirements** for each prompt. @lexicon will craft the final prompt text; this doc provides the constraints and examples they need.

---

## 1. Daily → Weekly Summary

### Inputs

- All daily logs for one ISO week (3–7 files)
- Combined as a single document with date headers

### System Prompt Requirements

The prompt MUST instruct the model to:

1. **Produce a structured weekly summary** with clear section headings
2. **Capture:** key decisions, outcomes, blockers, and context that would be lost if dailies were deleted
3. **Drop:** routine/repetitive entries, verbose tool output, redundant status updates
4. **Extract typed memories:** Identify entries that qualify as durable knowledge (decisions, feedback, project context, references) and emit them in a clearly delimited section at the end, each with `name`, `description`, `type`, and `body`
5. **Target compression:** ~30% of combined input token count (configurable via `CompactionConfig.compressionTarget`)
6. **Preserve attribution:** If an entry names a person or teammate, keep the name

### Output Format

```markdown
---
type: weekly
---

## Week of YYYY-MM-DD

### Key Outcomes
- ...

### Decisions
- ...

### Blockers / Open Items
- ...

### Notes
- ...

---
<!-- EXTRACTED_TYPED_MEMORIES
- name: ...
  description: ...
  type: project|feedback|user|reference
  body: |
    ...
- name: ...
  ...
-->
```

The `EXTRACTED_TYPED_MEMORIES` section uses a YAML list inside an HTML comment. The compactor parses this section and writes each entry as a separate `memory/type_topic.md` file.

### Example Input → Output

**Input (3 dailies, ~1200 tokens combined):**

```
## 2026-03-24
- Set up monorepo structure with packages/core
- Decided on vitest over jest for test runner
- Hit issue with transformers.js ESM imports — resolved by adding type: module

## 2026-03-25
- Implemented FileStorage interface re-exports
- Started on MemoryFiles — daily CRUD working
- PR review from stevenic: use gray-matter for frontmatter, not custom parser

## 2026-03-26
- Finished MemoryFiles — all CRUD methods implemented
- Added VirtualFileStorage tests — 14 tests passing
- Weekly standup: stevenic wants search working by end of next week
```

**Expected output (~360 tokens):**

```markdown
---
type: weekly
---

## Week of 2026-03-24

### Key Outcomes
- Monorepo scaffolded with packages/core; vitest chosen as test runner
- MemoryFiles fully implemented — all CRUD methods for daily, weekly, monthly, wisdom, and typed memories
- 14 tests passing using VirtualFileStorage

### Decisions
- vitest over jest (better TS monorepo support)
- gray-matter for frontmatter parsing (per stevenic's PR review)
- transformers.js requires `type: module` in package.json

### Open Items
- Search implementation targeted for end of W14 (per stevenic)

---
<!-- EXTRACTED_TYPED_MEMORIES
- name: Test runner choice
  description: Chose vitest over jest for the recall monorepo
  type: project
  body: |
    Chose vitest over jest for better TypeScript monorepo support and faster watch mode.
- name: Frontmatter parsing
  description: Use gray-matter for YAML frontmatter, not custom parsing
  type: feedback
  body: |
    Use gray-matter for frontmatter parsing. **Why:** stevenic flagged custom parser in PR review — gray-matter is battle-tested and handles edge cases.
-->
```

---

## 2. Weekly → Monthly Summary

### Inputs

- All weekly summaries for one calendar month (2–5 files)
- Combined as a single document with week headers

### System Prompt Requirements

The prompt MUST instruct the model to:

1. **Summarize themes, milestones, and trajectory** at the month scale
2. **Aggressive compression** — focus on what matters looking back in 3+ months
3. **Drop:** week-level detail that doesn't represent a milestone or decision
4. **Preserve:** decisions, architectural changes, milestone completions, blockers that persisted across weeks
5. **Target compression:** ~30% of combined input token count
6. **Do NOT extract typed memories** — that happens only at the daily→weekly stage

### Output Format

```markdown
---
type: monthly
---

## YYYY-MM — [Month Name]

### Milestones
- ...

### Key Decisions
- ...

### Themes
- ...

### Trajectory / What's Next
- ...
```

---

## 3. Wisdom Distillation

### Inputs

- Current `WISDOM.md` content (may be empty on first run)
- All typed memories (`memory/type_*.md`)
- Latest monthly summary

### System Prompt Requirements

The prompt MUST instruct the model to:

1. **Merge** new insights from typed memories and the monthly summary into existing wisdom
2. **Deduplicate** — if a new insight overlaps with an existing entry, merge them (keep the richer version)
3. **Remove** entries that are:
   - No longer relevant (contradicted by newer information)
   - Implementation details derivable from reading the code
   - Overly specific to a single incident with no generalizable lesson
4. **Cap** at max entries (default 20, configurable via `WisdomConfig.maxEntries`)
5. **Organize** by category if `WisdomConfig.categories` is provided; otherwise use a flat list
6. **Each entry** should be a concise principle (1–3 sentences) — not a narrative
7. **Preserve the voice** of the existing WISDOM.md — don't rewrite entries that haven't changed

### Output Format

```markdown
# [Teammate Name] - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: YYYY-MM-DD

---

## [Category 1]  (if categories configured)

**Entry title**
Entry body — concise principle, 1–3 sentences.

**Entry title**
Entry body...

## [Category 2]
...
```

If no categories are configured, omit the `##` headings and list entries as a flat sequence of bold-titled paragraphs.

---

## Integration Notes

- All prompts are passed as the `systemPrompt` field of `CompleteOptions`
- The user content (the actual daily logs / weekly summaries / typed memories) is passed as the `prompt` parameter to `MemoryModel.complete()`
- `WisdomConfig.systemPrompt` overrides the default wisdom distillation prompt entirely
- Compression targets are injected into the prompt text dynamically (e.g., "Target approximately 360 tokens" based on input size × `compressionTarget`)
- The extracted typed memories section is parsed by the compactor, not the model — the model just needs to emit the correct format
