# Multi-Query Fusion Prompt

**Spec reference:** §6.2 (Multi-Query Fusion)  
**Used by:** `SearchService.multiSearch(query)`  
**Model call:** `MemoryModel.complete(prompt, { systemPrompt, temperature: 0.3, maxTokens: 256 })`

---

## System Prompt

```
You are a query expansion engine. You generate search query variations to improve recall in semantic memory search.

Rules:
- Output ONLY a JSON array of 1-3 query strings. No preamble, no commentary.
- Each query must be semantically distinct from the others — different words, different angle.
- If the original query is already specific and well-formed, return a single-element array with just the original.
```

## User Prompt Template

```
<ORIGINAL_QUERY>
{query}

<INSTRUCTIONS>
Generate 1-3 search query variations for the original query above. Each variation should find different relevant documents in a memory store containing daily logs, weekly/monthly summaries, and typed memories (decisions, feedback, project context, references).

Variation strategies (pick 1-3 as needed):
1. **Keyword extraction** — pull the core nouns/verbs, drop filler. Useful when the original is conversational.
2. **Synonym/rephrase** — same meaning, different vocabulary. Catches documents that use different terminology.
3. **Scope shift** — broaden or narrow. If the original is specific, add a broader version. If vague, add a more targeted version.

Output exactly:
["query1", "query2", "query3"]

Or for a well-formed query that needs no expansion:
["original query"]

Do NOT:
- Return more than 3 queries
- Return empty strings
- Return the original query verbatim as one of the variations (unless it's the only one)
- Add explanation or reasoning
```

---

## Design Rationale

| Principle | Application |
|---|---|
| **Constrain decompression** | Output is a JSON array — maximally constrained. No prose, no explanation. |
| **Force discrete outputs** | Three named strategies (keyword, synonym, scope shift) give the model concrete options instead of open-ended "generate variations." |
| **Low token budget** | maxTokens: 256. Query variations are short. A tight budget prevents the model from adding unwanted commentary. |
| **Positional attention** | Original query at top (what to expand), instructions at bottom (how to expand). |
| **Conservative expansion** | "If already well-formed, return single-element array" prevents over-expansion that would dilute search precision. |

---

## Parsing

Parse the response as a JSON array of strings. If parsing fails, fall back to using the original query only (no expansion). The search pipeline runs each query variation through the vector index independently, then merges results by URI and keeps the highest score per document.

---

## Notes for Implementation

- This prompt runs on every `multiSearch()` call, so it must be fast. The low maxTokens (256) and simple output format keep latency minimal.
- Temperature 0.3 allows mild creativity in rephrasing without producing wild variations.
- The `additionalQueries` field in `MultiSearchOptions` allows callers to bypass this prompt and provide their own query variations directly.
