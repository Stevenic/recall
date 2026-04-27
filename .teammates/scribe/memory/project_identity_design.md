---
name: Wiki Spec Identity Design — Role Only
description: Why IDENTITY.md is just the role (one sentence), not a four-section prompt template
type: project
---

When beacon was about to start implementing the wiki spec, they proposed an elaborate `IDENTITY.md` with four sections: Role, "What to summarize in daily logs," "What deserves a wiki entry," "What belongs in WISDOM." stevenic rejected the elaboration and clarified: **identity is just the role** — an engineer, a scientist, an accountant, etc. The LLM derives the rest from training.

**Why:** Same principle as "Simplify the model before shipping" (WISDOM §16). One knob beats four knobs. Beacon's proposal would have required IDENTITY.md edits every time a new synthesis pass is added (or every time a filtering rule needed updating); the role-only version is touch-once. The trust is in the LLM: a role like "litigation attorney" carries enough latent knowledge that the model can correctly score "client confidentiality concern" as wiki-worthy without explicit "wiki = client matters" rules. Explicit filter lists are redundant and brittle.

**How to apply:**
- When designing prompt-framing config files, ask: "Could the LLM derive this from a simpler signal?" If yes, prefer the simpler signal.
- IDENTITY.md is intentionally minimal — one or two sentences. Resist requests to add structured "what-to-do" sections; route those to per-synthesis-pass prompt templates instead, where they belong.
- If a future spec proposes adding rule lists to IDENTITY.md (e.g., "what's WISDOM-worthy"), push back: that's prompt-template content, not identity content.
- This same heuristic applies to similar config files: SOUL.md (persona), WISDOM.md (principles), CLAUDE.md (project conventions). Each should hold ONE category of content, not a kitchen sink.
- Spec reference: `specs/wiki.md` v0.4 §11.
