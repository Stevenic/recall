# Lexicon - Wisdom

Distilled principles. Read first every session (after SOUL.md).

Last compacted: 2026-04-14

---

## Prompt Architecture

**Task near the end** — Restate the ask near final instructions so the model exits pointed at the work.

**Budget every context source** — Conversation, memory, and reference docs each need token limits. One noisy source starves the rest.

**Diagnose the failure layer** — Missing facts = distance. Wrong conclusions = compression. Bad output = decompression. Fix only the broken layer.

**Structure over volume** — Sharp sections with labels adjacent to values beat longer, vaguer prompts.

**Reference data off the evidence path** — Roster, services, datetime dilute the evidence chain. Keep them outside the context-to-task span.

**Bottom-edge reinforcement** — Short end-of-prompt reminders carry outsized force. Tie each to its `<SECTION_NAME>`.

**Constraint over choreography** — Specify outcomes, format, limits. Avoid sequencing mandates unless order matters.

## Prompt Integration

**SOUL is identity, not runtime control** — Persona and durable principles only. Runtime mechanics go in the instruction block.

**Specs are hypotheses until verified in assembly** — Check the prompt builder before treating any design note as live behavior.

**Patch the assembly point** — Changes only matter where the final token stream is built. A correct idea in the wrong file has no effect.

**Read consumer code before finalizing prompts** — Output format assumptions diverge between docs and implementation. Read the parser first.

## Compaction Prompts

**Discrete decisions, not open-ended rewriting** — Demand KEEP/DROP/MERGE. Discrete choices compress reliably; open-ended rewrites drift.

**Two-phase: structural then semantic** — Roll up structure mechanically first. Invoke LLM compression only when budget is exceeded.

**Unambiguous delimiters for dual output** — When one prompt produces summary and extracted items, use distinct fenced-block markers so parsing is a single regex.

**Temperature tracks task entropy** — Classification/extraction: 0.1-0.2. Synthesis: 0.3. Higher values hallucinate connections.

## Operational

**Deliverable first, housekeeping second** — Front-loading upkeep consumes budget before the visible answer ships.

**Compression bugs look like missing context** — Right facts buried in duplicates behave as absent. Dedupe before concluding retrieval failed.

**Attention failures are multi-layer** — One symptom can have co-occurring distance, compression, and decompression causes. Check all three.

**Log bloat is a per-turn compression tax** — Duplicated entries compete with task-relevant context. Aggressive historical compression improves performance.
