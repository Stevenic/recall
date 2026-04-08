# Lexicon - Wisdom

Distilled principles. Read first every session (after SOUL.md).

Last compacted: 2026-04-07

---

## Prompt Architecture

**Task near the end** — Restate the concrete ask close to the final instructions so the model exits pointed at the work.

**Budget every context source** — Conversation, retrieved memory, and reference docs each need explicit token limits. One noisy source starves the rest.

**Diagnose the failure layer** — Missing facts = distance problem. Wrong conclusions = compression problem. Bad output = decompression problem. Fix the broken layer, not the whole prompt.

**Structure over volume** — Sharp sections with labels adjacent to values outperform longer prompts with vaguely relevant text.

**Reference data off the evidence path** — Roster, services, datetime sit outside the retrieved-context-to-task span. They dilute attention on the evidence chain.

**Bottom-edge reinforcement** — Short reminders at the very end carry outsized force. Tie each to the exact `<SECTION_NAME>` it governs.

**Constraint over choreography** — Specify outcomes, format, and limits. Avoid sequencing mandates unless strict ordering is truly required.

## Prompt Integration

**SOUL is identity, not runtime control** — Persona and durable principles only. Runtime reminders, task mechanics, and output rules go in the instruction block.

**Specs are hypotheses until verified in assembly** — Check the prompt builder or generated token stream before treating any design note as live behavior.

**Patch the assembly point** — Prompt changes only matter where the final token stream is built. A correct idea in the wrong file has no runtime effect.

**Read consumer code before finalizing prompts** — Output format assumptions diverge between design docs and implementation. Always read the parsing code first.

## Compaction Prompts

**Discrete decisions, not open-ended rewriting** — Demand a classification (KEEP/DROP/MERGE). Discrete choices compress reliably; open-ended rewrites drift.

**Two-phase: structural then semantic** — Roll up structure mechanically first. Invoke LLM compression only when the token budget is actually exceeded.

**Unambiguous delimiters for dual output** — When one prompt produces both summary and extracted items, use distinct fenced-block markers so parsing is a single regex.

**Temperature tracks task entropy** — Classification/extraction: 0.1-0.2. Synthesis: 0.3. High temperature hallucinated connections between unrelated items.

## Operational

**Deliverable first, housekeeping second** — Front-loading upkeep consumes tool budget and attention before the visible answer is produced.

**Compression bugs look like missing context** — Right facts buried in duplicated logs behave as if absent. Trim and dedupe before concluding retrieval failed.

**Attention failures are multi-layer** — A single symptom can have co-occurring distance, compression, and decompression causes. Check all three before prescribing a fix.

**Log bloat is a per-turn compression tax** — Duplicated entries consume tokens that compete with task-relevant context. Aggressive historical compression improves task performance.
