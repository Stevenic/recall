# EA Corpus Generation — 10-Night Epic

**Mission:** Generate the v0.5 multi-session memory corpus for the `executive-assistant` persona. Target: 1,000 days; floor: ~300 days (sufficient to clear PLAYBOOK §8.1 Q&A range minimums for `30d`, `90d`, `6mo`).

**Budget per night:** 6 wall-clock hours (NIGHTBUILD default), no cost cap, `--model claude` (claude-opus-4-7 via local CLI).

**Speed envelope (measured 2026-05-05):** ~3 min per `claude` CLI invocation; ~22 active arcs × selectArcDays per arc × small overlap → roughly 1,200 invocations to cover 1,000 days. At 6h/night this lands ~120 invocations/night → expect ~80–120 unique calendar days emitted per night, with multi-arc days re-touched for merge.

**Resume contract (between nights):**
- Each night commits per-tick. Tomorrow's NightBuild kickoff sees committed days from prior nights; `recall-bench generate --start <next>` picks up at the highest existing `day-NNNN.md`.
- Same branch (`nightbuild/2026-05-05`) — set `branch_policy: "current"` at tomorrow's kickoff prompt to skip the branch question.
- This file is the durable across-night ledger. Each night appends one progress entry.

**Reporting contract:** one short progress entry per night. No big NEEDS HUMAN blocks unless something is genuinely broken (per-tick details still go to each run's `log.md`).

---

## Night 1 — 2026-05-05 / 2026-05-06 — Foundation

**Status:** in progress
**Started:** 2026-05-06T01:29:18Z
**Run dir:** `.nightbuild/2026-05-05`

**Done:**
- ✅ Phase A — day-generator at v0.5 schema (commits `8dc7c71`, `9653ee0`)
- ✅ Bug fix landed (`6e42b72`) — duplicate session H1s in arc-merge prompt

**In progress:**
- ⏳ Validate bug fix via small live smoke (3 days research-scientist)
- ⏳ Kick off EA generation with whatever budget remains after smoke

**Goal for Night 1:** validate the merge-rules prompt fix at LLM-output level, then emit as many EA days as the remaining budget allows. No specific day-count target; whatever lands, lands.

**Rolling totals (updated end-of-night):**
- Total EA days emitted: 0 / 1000 (0%)
- Cumulative invocations: ~8 (the killed smoke)
- Cumulative wall-clock: ~30 min compute + ~30 min orchestration

---
