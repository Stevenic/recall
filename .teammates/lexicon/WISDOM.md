# Lexicon - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: 2026-04-06

---

## Prompt Architecture

**Task near the end** — Context first, but restate the concrete ask close to the final instructions so the model exits pointed at the work.

**Budget every context source** — Conversation, retrieved memory, and reference docs each need explicit token limits. One noisy source will starve the rest.

**Diagnose the failure layer** — Missing facts = retrieval/distance problem. Wrong conclusions = compression problem. Bad output format/style = decompression problem. Fix the broken layer, not the whole prompt.

**Structure over volume** — Shorter prompts with sharp sections, labels adjacent to values, and output constraints outperform longer prompts with vaguely relevant text.

**Reference data off the evidence path** — Roster, services, datetime, and other low-frequency support data must not sit between recalled context and the active task. They dilute attention on the evidence chain.

**Bottom-edge reinforcement** — Short reminders at the very end of the instruction block carry outsized global force. Tie each to the exact `<SECTION_NAME>` it governs so attention routes back.

**Constraint over choreography** — Specify outcomes, format, and limits. Avoid sequencing mandates about *when* to speak or call tools unless strict ordering is truly required.

## Prompt Integration

**SOUL is identity, not runtime control** — SOUL.md lands in the identity block: persona and durable principles only. Runtime reminders, task mechanics, and output rules go in the instruction block.

**Specs are hypotheses until verified in assembly** — A design note is not live behavior. Check the prompt builder or generated token stream before treating any proposed improvement as current reality.

**Patch the assembly point** — Prompt changes only matter where the final token stream is built. A correct idea in the wrong file has no runtime effect.

**Read consumer code before finalizing prompts** — Output format assumptions (fenced blocks vs JSON, frontmatter vs bare content) diverge between design docs and implementation. Always read the parsing code first.

## Compaction Prompts

**Discrete decisions, not open-ended rewriting** — Present each item and demand a classification (KEEP/DROP/MERGE or ADD/DROP/MERGE). Discrete choices compress reliably; open-ended rewrites drift.

**Two-phase: structural then semantic** — Roll up structure mechanically first (days into weeks, weeks into months). Invoke LLM compression only when the token budget is actually exceeded. Saves cost, preserves fidelity.

**Unambiguous delimiters for dual output** — When one prompt produces both a summary and extracted items, use distinct fenced-block markers (e.g., `typed_memory`) so parsing is a single regex.

**Temperature tracks task entropy** — Classification/extraction: 0.1-0.2. Synthesis: 0.3. Never use high temperature for compaction — it hallucinated connections between unrelated items.

## Operational

**Deliverable first, housekeeping second** — Memory reads and session maintenance support the task but are not the task. Front-loading upkeep consumes tool budget and attention before the visible answer is produced.

**Compression bugs look like missing context** — If the right facts are present but buried in duplicated logs or bloated payloads, the model behaves as if context is absent. Trim and dedupe before concluding retrieval failed.

**Attention failures are multi-layer** — A single symptom can have co-occurring distance, compression, and decompression failures. Check all three layers before prescribing a fix.

**Log bloat is a per-turn compression tax** — Duplicated recall results, verbose daily logs, and repeated entries consume tokens that compete with task-relevant context. Aggressive historical compression directly improves task performance.
