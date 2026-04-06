# Wisdom Distillation Prompt

**Spec reference:** §5.2 (Wisdom Distillation)  
**Used by:** `Compactor.distillWisdom()`  
**Model call:** `MemoryModel.complete(prompt, { systemPrompt, temperature: 0.3, maxTokens: 4096 })`

---

## System Prompt

```
You are a wisdom distillation engine. You maintain a curated set of high-value entries — decisions, invariants, gotchas, and validated patterns — by merging new material into an existing wisdom file.

Rules:
- Output ONLY the updated wisdom file in the exact format described below.
- Maximum {max_entries} entries. If merging would exceed the cap, drop the least durable entries.
- Every entry must be actionable — it should change future behavior, not just record history.
- Do not include implementation recipes (derivable from code), ephemeral status, or task lists.
```

## User Prompt Template

```
<CURRENT_WISDOM>
{current_wisdom_content}

<NEW_MATERIAL>
{latest_monthly_summary}

{typed_memories_content}

<INSTRUCTIONS>
Merge the new material into the current wisdom file. Produce the updated wisdom file.

For each item in NEW MATERIAL, make exactly one decision:

- **MERGE** — the insight updates, refines, or reinforces an existing wisdom entry. Edit the existing entry in place.
- **ADD** — the insight is new and durable. Add it as a new entry. If at the cap ({max_entries}), you must DROP a less durable entry to make room.
- **DROP** — the insight is ephemeral, already covered, derivable from code, or contradicted by newer information. Do not include it.

Output format:

# {agent_name} - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: {today_date}

---

## {category (if categories configured, otherwise omit)}

**{Entry title}**
{1-3 sentence description of the principle, decision, or pattern.}

(repeat for each entry, up to {max_entries})

Rules for entries:
- Lead with the actionable rule, not the history behind it.
- If the entry has a "why", include it — but keep it to one sentence.
- Entries that haven't been reinforced by any new material in 3+ months are candidates for DROP.
- Contradictions: newer information wins. Update or remove the stale entry.
- Do not duplicate: if two entries say the same thing, merge into one.
```

---

## Design Rationale

| Principle | Application |
|---|---|
| **Force discrete outputs** | Every item requires exactly one of three decisions: MERGE, ADD, DROP. No ambiguity, no "maybe keep." |
| **Positional attention** | Current wisdom at top (reference), new material in middle (evidence), instructions at bottom edge (action). The model reads existing state → new data → what to do. |
| **Compress before reasoning** | Input is already double-compressed (dailies→weeklies→monthlies + typed memories). Wisdom is the third compression stage. |
| **Constrain decompression** | Exact output structure specified. "Lead with the actionable rule" prevents narrative drift. Entry cap forces prioritization. |
| **Staleness heuristic** | "3+ months without reinforcement" gives the model a concrete signal for what to drop, rather than leaving durability as a subjective judgment. |
| **Contradiction resolution** | Explicit "newer information wins" prevents the model from trying to reconcile conflicting entries. |

---

## Notes for Implementation

- `{max_entries}` defaults to 20 (from `WisdomConfig.maxEntries`)
- `{categories}` are optional. If `WisdomConfig.categories` is set, entries are grouped under `## Category` headings. Otherwise, entries are a flat list under the `---` separator.
- `{typed_memories_content}` should include all typed memories, concatenated with `---` separators. Each includes its frontmatter so the model can see the type classification.
- Temperature is 0.3 (slightly higher than compaction) because wisdom requires mild judgment about durability and relevance, not just compression.
