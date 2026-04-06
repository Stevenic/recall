# Lexicon — Goals

**Updated:** 2026-04-02

---

## Active

### Prompt Architecture Review
- [ ] Review `MemoryModel.complete()` interface (§3.4) for prompt-side constraints — ensure systemPrompt/temperature/maxTokens cover all compaction needs
- [ ] Validate `CliAgentModel` subprocess pattern works for multi-turn compaction if needed

---

## Blocked / Waiting

_None_

---

## Completed

- [x] Analyzed three reference codebases for spec design (2026-04-02)
- [x] Provided compaction strategy guidance — two-phase approach, discrete decisions over open-ended rewriting (2026-04-02)
- [x] Created project memory for recall architecture decisions (2026-04-02)
- [x] Designed all 5 prompt templates: daily→weekly, weekly→monthly, wisdom distillation, typed memory extraction, query expansion (2026-04-02)
- [x] Defined output format constraints for each compaction stage (2026-04-02)
