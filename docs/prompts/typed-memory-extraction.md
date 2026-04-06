# Typed Memory Extraction Prompt

**Spec reference:** §5.3 (Typed Memory Extraction)  
**Used by:** `Compactor.compactDaily(week)` (integrated into daily→weekly), or standalone extraction  
**Model call:** `MemoryModel.complete(prompt, { systemPrompt, temperature: 0.1, maxTokens: 2048 })`

---

## Context

Typed memory extraction is primarily embedded in the daily→weekly compaction prompt (see `daily-to-weekly.md`, Section 2). This standalone prompt exists for cases where extraction runs independently — e.g., on-demand extraction from a single daily log or from arbitrary text input.

The classification logic is identical in both versions. If you change the type definitions or extraction rules, update both files.

---

## System Prompt

```
You are a memory classifier. You read agent logs or notes and extract entries that represent durable knowledge. You classify each into exactly one type and output structured blocks.

Rules:
- Output ONLY typed_memory fenced blocks, or the word NONE if nothing qualifies.
- No preamble, no commentary, no summary.
- Each block must include valid YAML frontmatter with name, description, and type fields.
- Be conservative — only extract knowledge that will be useful in future sessions. When in doubt, skip it.
```

## User Prompt Template

```
<SOURCE_TEXT>
{input_text}

<TYPE_DEFINITIONS>
- **user**: Facts about a person's role, preferences, expertise, or working style. Helps tailor future collaboration.
- **feedback**: Guidance on how to approach work — corrections OR validated approaches. Must include why.
- **project**: Decisions, goals, timelines, or context about ongoing work not derivable from code/git. Convert relative dates to absolute dates (use {today_date} as reference).
- **reference**: Pointers to external resources — URLs, tools, dashboards, Slack channels, tracking systems.

<EXCLUSION_RULES>
Do NOT extract:
- Code patterns, architecture, or file paths (derivable from reading the codebase)
- Git history or who-changed-what (derivable from git log/blame)
- Debugging solutions or fix recipes (the fix is in the code)
- Ephemeral task state (in-progress work, temporary blockers that will resolve)
- Anything already documented in project config files

<INSTRUCTIONS>
For each durable knowledge entry in the source text, emit:

```typed_memory
---
name: {short_title}
description: {one-line description — specific enough for search indexing}
type: {user | feedback | project | reference}
---

{content body}
```

For feedback and project types, structure the body as:
- Lead with the rule or fact
- **Why:** (the motivation or incident behind it)
- **How to apply:** (when/where this should influence future behavior)

If nothing qualifies, output exactly:

```typed_memory
NONE
```
```

---

## Design Rationale

| Principle | Application |
|---|---|
| **Force discrete outputs** | Type is constrained to exactly 4 options. The extract/skip decision is binary — either a `typed_memory` block appears or it doesn't. |
| **Labels adjacent to values** | Frontmatter fields (`name:`, `type:`) sit directly next to their values. The `<TYPE_DEFINITIONS>` section puts each type label adjacent to its definition. |
| **Reference section names in instructions** | Instructions reference `<TYPE_DEFINITIONS>` and `<EXCLUSION_RULES>` by their exact tag names, creating direct token-level links. |
| **Conservative by default** | "When in doubt, skip it" — false negatives (missing a memory) are cheaper than false positives (cluttering the memory store with noise). |
| **Low temperature** | 0.1 — this is classification, not generation. Minimal creativity needed. |

---

## Parsing

Same as daily→weekly: extract all `typed_memory` fenced blocks via regex `` ```typed_memory\n([\s\S]*?)``` ``. Parse YAML frontmatter from each block. The `name` field is slugified to produce the filename: `{type}_{slugified_name}.md`.

If the block contains only `NONE`, no memories are extracted.
