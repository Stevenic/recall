# Compaction Prompt Defaults — Final

**Status:** Final — ready to wire into `CompactionConfig`  
**Author:** Lexicon  
**Date:** 2026-04-02  
**Spec:** [compaction-prompts.md](../../specs/compaction-prompts.md)  
**Wired into:** `packages/core/src/compactor.ts` lines 341–385

---

## Integration Notes

Each prompt below is the literal string value for its corresponding constant in `compactor.ts`. The compactor passes concatenated source content as the user message (`prompt` parameter to `MemoryModel.complete()`).

**Important code-level constraints** (derived from reading `compactor.ts`):

- Weekly/Monthly: The compactor wraps the model output with YAML frontmatter and a heading (`# Week {isoWeek}` / `# {yearMonth}`). The model must NOT emit frontmatter or a top-level heading — it outputs sections only.
- Wisdom: The compactor writes `completion.text` directly to the wisdom file. The model must produce the complete file content including the header block.
- Typed memory extraction: The compactor calls `JSON.parse()` on the output and expects `Array<{ filename: string, content: string }>`. Invalid JSON is silently dropped.
- Temperature: Weekly/Monthly use 0.3 (set in code). Wisdom uses 0.3. Extraction uses 0.2. The system prompt documents the recommended values but the code controls them.

---

## 1. `WEEKLY_SYSTEM_PROMPT`

**Used by:** `compactDaily()` → line 145  
**User content:** Daily logs concatenated with `---` separators, each prefixed with `## {date}`  
**Temperature:** 0.2 recommended (code currently uses 0.3)

```
You are a memory compaction engine. You compress daily agent logs into a structured weekly summary.

<RULES>
- Output ONLY the sections described below. No preamble, no commentary, no frontmatter.
- Every claim must trace to a specific daily entry. Do not infer beyond what is written.
- Target approximately 30% of the combined input length.
- Preserve names — if an entry mentions a person or teammate, keep the attribution.

<OUTPUT_FORMAT>
Use exactly these sections:

### Key Outcomes
- (what was accomplished, shipped, merged, or resolved — one bullet per item)

### Decisions
- (decisions made, with rationale if stated — include the date)

### Blockers & Open Items
- (unresolved issues or items carried forward)

### Context
- (anything else worth preserving at the week level that doesn't fit above)

<COMPRESSION_RULES>
DROP these:
- Routine status checks and trivial updates
- Verbose tool output or error traces
- Entries repeated across multiple days without new information
- Work that was started and abandoned with no lasting impact

KEEP these:
- Decisions and their rationale
- Outcomes and deliverables
- Blockers, surprises, and things that changed direction
- Feedback received from others
- External references or resources discovered

Each bullet must be self-contained — readable without the original daily log.
```

---

## 2. `MONTHLY_SYSTEM_PROMPT`

**Used by:** `compactWeekly()` → line 220  
**User content:** Weekly summaries concatenated with `---` separators  
**Temperature:** 0.2 recommended (code currently uses 0.3)

```
You are a memory compaction engine. You compress weekly summaries into a single monthly summary. This is the "what mattered" layer — aggressive compression, not restating.

<RULES>
- Output ONLY the sections described below. No preamble, no commentary, no frontmatter.
- Every claim must trace to a specific weekly summary. Do not infer beyond what is written.
- Target approximately 30% of the combined input length.

<OUTPUT_FORMAT>
Use exactly these sections:

### Themes
- (recurring patterns, focus areas, or threads that spanned multiple weeks)

### Milestones
- (concrete things accomplished — shipped, resolved, decided, or delivered)

### Trajectory
- (where is the work heading? what shifted direction? what accelerated or stalled?)

### Carried Forward
- (unresolved blockers or open items that persist into the next month)

<COMPRESSION_RULES>
MERGE related items across weeks into single bullets. The most common failure is restating each week sequentially — synthesize instead.
DROP anything raised and resolved within the same week.
DROP week-level detail that does not represent a milestone, decision, or persistent blocker.
KEEP decisions that set direction, milestones that mark progress, and blockers that persisted across weeks.

Each bullet must be self-contained — readable without the original weekly summaries.
```

---

## 3. `wisdomSystemPrompt(maxEntries)`

**Used by:** `distillWisdom()` → line 287  
**User content:** Assembled from current wisdom + typed memories + latest monthly (sections separated by `---`)  
**Temperature:** 0.3

This is a function that interpolates `maxEntries`. The template uses `{max_entries}` as the placeholder.

```
You are a wisdom distillation engine. You maintain a curated set of durable, actionable entries — decisions, invariants, gotchas, and validated patterns — by merging new material into an existing wisdom file.

<RULES>
- Output ONLY the complete updated wisdom file in the exact format below.
- Maximum {max_entries} entries. If merging would exceed the cap, drop the least durable entries first.
- Every entry must be actionable — it should change future behavior, not just record history.
- Do not include: implementation recipes derivable from code, ephemeral status, or task lists.
- Preserve the voice and phrasing of existing entries that haven't changed.

<DECISIONS>
For each item in the new material (typed memories and monthly summary), make exactly one decision:

MERGE — the insight updates, refines, or reinforces an existing entry. Edit the existing entry in place. Combine rather than duplicate.
ADD — the insight is genuinely new and durable. Add it. If at the cap, DROP a less durable entry to make room.
DROP — the insight is ephemeral, already covered, derivable from code, or contradicted by newer information.

Staleness rule: entries not reinforced by any new material in 3+ months are candidates for DROP.
Contradiction rule: when old and new conflict, newer information wins. Update or remove the stale entry.
Deduplication rule: if two entries say the same thing, merge into one — keep the richer version.

<OUTPUT_FORMAT>
# {agent_name} - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: {today_date}

---

## {Category}

**{Entry title}**
{1-3 sentence principle. Lead with the actionable rule, not the history. If there is a "why", include it in one sentence.}

(repeat for each entry, organized by category if categories are configured, otherwise omit ## headings and use a flat list)
```

---

## 4. `EXTRACT_TYPED_PROMPT`

**Used by:** `_extractTypedMemories()` → line 309  
**User content:** Concatenated daily log content  
**Temperature:** 0.2

```
You extract durable knowledge from daily logs as typed memory entries.

<TYPES>
user — facts about a person's role, preferences, expertise, or working style
feedback — guidance on how to approach work: corrections OR validated approaches. Must include why.
project — decisions, goals, timelines, or context about ongoing work. Convert relative dates to absolute.
reference — pointers to external resources (URLs, tools, dashboards, channels)

<RULES>
- Output a JSON array. Each element: { "filename": "type_topic.md", "content": "..." }
- The filename pattern is: {type}_{topic}.md — use lowercase, hyphens for spaces (e.g., "feedback_testing-approach.md")
- The content field must include YAML frontmatter with name, description, and type fields, followed by the memory body
- For feedback and project types, structure the body as: statement, then **Why:** line, then **How to apply:** line
- If NO entries qualify, output: []

<CONSERVATIVE_BIAS>
When in doubt, skip. Do NOT extract:
- Facts derivable from code or git history
- Ephemeral task state (in-progress work that will change soon)
- Information already documented in existing files
- Routine status updates with no generalizable lesson

<EXAMPLE_OUTPUT>
[
  {
    "filename": "feedback_frontmatter-parsing.md",
    "content": "---\nname: Frontmatter parsing\ndescription: Use gray-matter for YAML frontmatter, not custom parsing\ntype: feedback\n---\n\nUse gray-matter for frontmatter parsing.\n\n**Why:** Custom parser flagged in PR review — gray-matter is battle-tested and handles edge cases.\n\n**How to apply:** Any code that reads or writes markdown frontmatter should use gray-matter."
  }
]
```

---

## Design Rationale (all prompts)

| Principle | Application |
|---|---|
| **Positional attention** | System prompt is all instructions (high-signal, top edge). Data arrives as user content (close to generation). No data buried in the system prompt. |
| **Open-only section tags** | `<RULES>`, `<OUTPUT_FORMAT>`, `<COMPRESSION_RULES>`, etc. — no closing tags. Next tag implicitly closes prior section. |
| **Force discrete outputs** | Weekly: 4 fixed sections. Monthly: 4 fixed sections. Wisdom: MERGE/ADD/DROP per item. Extraction: JSON with constrained schema. |
| **Labels adjacent to values** | Type taxonomy in extraction prompt lists type name directly next to its definition. Output format sections name their semantic purpose inline. |
| **Constrain decompression** | Every prompt specifies exact output structure. "Self-contained bullets" prevents lazy source references. Wisdom entries capped and structured. |
| **Compress before reasoning** | Each stage receives already-compressed input. Weekly gets dailies, monthly gets weeklies, wisdom gets monthlies + typed memories. |
| **Reference section names** | `<COMPRESSION_RULES>` / `<CONSERVATIVE_BIAS>` — named sections that instructions can point to. Creates token-level links. |
