# Weekly → Monthly Compaction Prompt

**Spec reference:** §5.2 (Weekly → Monthly)  
**Used by:** `Compactor.compactWeekly(month)`  
**Model call:** `MemoryModel.complete(prompt, { systemPrompt, temperature: 0.2, maxTokens: 4096 })`

---

## System Prompt

```
You are a memory compaction engine. You compress weekly agent summaries into a single monthly summary. Focus on themes, milestones, and trajectory — not individual tasks.

Rules:
- Output ONLY the monthly summary in the exact markdown structure described below.
- Compression target: ~30% of the combined input token count.
- Every claim must trace to a specific weekly summary. Do not hallucinate.
- Drop week-level detail that doesn't matter at the month scale.
```

## User Prompt Template

```
<WEEKLY_SUMMARIES>
{weekly_summaries}

<INSTRUCTIONS>
Compact the weekly summaries above into a single monthly summary. Use this exact format:

---
type: monthly
---

## {month_label}

### Themes
- (recurring patterns, focus areas, or threads that spanned multiple weeks)

### Milestones
- (concrete things accomplished — shipped, resolved, decided, or delivered)

### Trajectory
- (where is the work heading? what shifted direction? what accelerated or stalled?)

### Carried Forward
- (unresolved blockers or open items that persist into the next month)

Rules:
- MERGE related items across weeks into single bullets. Don't repeat the same topic per-week.
- DROP anything that was raised and resolved within the same week — it's already captured in weekly.
- KEEP decisions that set direction, milestones that mark progress, and blockers that persisted.
- Each bullet should be self-contained — readable without the original weekly summaries.
- Target ~30% of input length. Be aggressive — monthly is the "what mattered" layer.
```

---

## Design Rationale

| Principle | Application |
|---|---|
| **Positional attention** | Data first (`<WEEKLY_SUMMARIES>`), instructions at the bottom edge. |
| **Force discrete outputs** | Four fixed sections (Themes, Milestones, Trajectory, Carried Forward) eliminate free-form drift. Each section has a clear semantic role. |
| **Compress before reasoning** | Input is already compressed (weekly summaries, not raw dailies). The model compresses compressed data — second-stage compression. |
| **Constrain decompression** | Exact output format specified. "Self-contained bullets" prevents lazy references to source material. |
| **Merge instruction** | Explicit "MERGE related items across weeks" prevents the most common monthly-summary failure: restating each week sequentially instead of synthesizing. |
