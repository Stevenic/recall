# Daily → Weekly Compaction Prompt

**Spec reference:** §5.2 (Daily → Weekly), §5.3 (Typed Memory Extraction)  
**Used by:** `Compactor.compactDaily(week)`  
**Model call:** `MemoryModel.complete(prompt, { systemPrompt, temperature: 0.2, maxTokens: 4096 })`

---

## System Prompt

```
You are a memory compaction engine. You compress daily agent logs into a structured weekly summary. You also extract durable knowledge into typed memory candidates.

Rules:
- Output ONLY the two sections described below. No preamble, no commentary.
- Use the exact markdown structure shown. Do not invent additional sections.
- Compression target: the WEEKLY SUMMARY section should be roughly 30% of the combined input token count.
- Every claim in your output must trace to a specific daily entry. Do not hallucinate or infer beyond what is written.
```

## User Prompt Template

```
<DAILY_LOGS>
{daily_logs}

<INSTRUCTIONS>
Compact the daily logs above into two sections.

SECTION 1 — WEEKLY SUMMARY

Write a structured markdown summary for the week. Use this exact format:

---
type: weekly
---

## {week_label}

### Key Decisions
- (list decisions made, with date and rationale)

### Outcomes
- (list what was accomplished, shipped, merged, or resolved)

### Blockers & Open Items
- (list unresolved issues, blockers, or items carried forward)

### Context
- (any other detail worth preserving at the week level)

Rules for this section:
- DROP routine entries (status checks, trivial updates, repeated daily patterns)
- KEEP decisions, outcomes, blockers, surprises, and anything a future reader would need
- Each bullet should be self-contained — readable without the original daily log
- Target ~30% of input length

SECTION 2 — TYPED MEMORY CANDIDATES

For each entry in the daily logs that represents durable knowledge, emit a fenced block:

```typed_memory
---
name: {short_title}
description: {one-line description for search indexing}
type: {user | feedback | project | reference}
---

{content — for feedback/project types, include **Why:** and **How to apply:** lines}
```

Classification rules:
- **user**: facts about a person's role, preferences, expertise, or working style
- **feedback**: guidance on how to approach work — corrections OR validated approaches. Include why.
- **project**: decisions, goals, timelines, or context about ongoing work. Convert relative dates to absolute.
- **reference**: pointers to external resources (URLs, tools, dashboards, channels)

If NO entries qualify as typed memories, output:

```typed_memory
NONE
```

Do not extract memories that are:
- Derivable from code or git history
- Ephemeral task state (in-progress work that will change tomorrow)
- Already documented elsewhere
```

---

## Parsing the Output

The compactor parses the response into two parts:

1. **Weekly summary** — everything outside `typed_memory` fenced blocks → written to `memory/weekly/{week}.md`
2. **Typed memory candidates** — each `typed_memory` block is parsed for frontmatter and written to `memory/{type}_{topic}.md`

The `typed_memory` fence language tag makes extraction unambiguous — simple regex: `` ```typed_memory\n([\s\S]*?)``` ``

---

## Design Rationale

| Principle | Application |
|---|---|
| **Positional attention** | System prompt sets role + hard rules at the top. Daily logs (data) come next. Instructions at the bottom — closest to where the model generates output. |
| **Labels adjacent to values** | The output template puts field names (`name:`, `type:`) directly next to their values in the typed memory blocks. |
| **Force discrete outputs** | Type classification is constrained to 4 options. The keep/drop decision is implicit in the output structure — if it's not in the summary, it was dropped. |
| **Compress before reasoning** | The model doesn't analyze the logs first and then summarize. It reads compressed daily logs and directly produces the compressed output. |
| **Scope retrieved context** | Only the relevant week's daily logs are injected. No extra context. |
| **Open-only section tags** | `<DAILY_LOGS>` and `<INSTRUCTIONS>` use open-only tags. The next tag implicitly closes the previous section. |
