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

**Done:**
- ✅ Phase A — day-generator at v0.5 schema (commits `8dc7c71`, `9653ee0`)
- ✅ Bug fix landed and validated (`6e42b72`) — duplicate session H1s in arc-merge prompt; confirmed via 3-day research-scientist smoke and again on EA day 1 (touched by 4+ arcs, emitted exactly one H1 per session)
- ⚠️ Phase C chunk 1-10 — partial: 2 days emitted (1, 8) before chunk hit two 10-min timeouts and was killed (commit `b4ccf16`)

**Closed at:** 2026-05-06T06:08Z (~4h39m elapsed; budget cap was 6h, ended ~80 min early after Phase C stalled)

**Rolling totals:**
- Total EA days emitted: 2 / 1000 (0.2%)
- Day files: 1, 8 (both v0.5 multi-session format, no duplicate H1s)
- Cumulative invocations: ~14 successful + 2 timeouts (research-scientist smoke + EA chunk + earlier killed smoke)
- Cumulative wall-clock: ~3h compute + ~30 min orchestration

**Issues to watch on Night 2:**
1. **Per-call timeouts.** `--timeout` defaults to 600000ms (10 min). Two timeouts on EA chunk 1-10 (relationship-family day 8, relationship-board-chair day 1). Consider reducing to 300000ms — claude CLI hangs are non-recoverable, so faster failure is cheaper. Skipped days can be retried on subsequent runs.
2. **Session-selection drift.** EA days 1 and 8 emitted only 4 sessions each (principal, direct-reports, ea-network, family) instead of the active-sessions list (which would also include board-prep and executive-team echoes from arc start touchpoints). The LLM took narrative liberties — picked sessions based on what felt right rather than strictly following the user message. Not a structural failure; tomorrow's `--start 1 --end 10` rerun will merge missing arcs into days 1 and 8 (and add days 2-7, 9, 10). If drift persists, tighten `buildUserMessage` to make the active-sessions list a hard constraint.

**Resume command for Night 2:**
```bash
cd C:/source/recall
npx recall-bench generate \
  --persona ./packages/recall-bench/personas/executive-assistant \
  --model claude --start 1 --end 10 --timeout 300000
```
Days 1 and 8 were deleted (see persona-refresh note below); Night 2 starts fresh. Subsequent chunks: `--start 11 --end 20`, etc.

---

## Persona refresh — between Night 1 and Night 2

User updated the EA persona to reflect the EA Persona Source Document (April 2026):

- **Agent renamed:** Sebastian → Jordan (single-name codename per repo convention; the source doc named "Jordan Ellis" but agents use first-name only — humans keep full names)
- **Domain shifted:** mid-cap industrial → large technology company; company name changed NorthRiver Industries → Mosaic Systems
- **Profile + communication_style rewritten** to emphasize the source doc's EA traits: anticipatory, discreet, judgment-bearing, ambiguity-absorbing, low-ego/high-ownership; tone variants by audience (warm-but-formal external, agenda-first internal, deferential with board chair, etc.)
- **sharedKnowledge expanded** with calendar discipline, briefing format, sensitive-topic handling, stakeholder norms, approval boundaries, and physical-world constraints from source doc §10
- **Sessions unchanged** (9 still maps cleanly to the 12 jobs)
- **Arcs:** all 22 existing arc IDs kept (descriptions updated for Jordan/Mosaic naming); **2 new arcs added** to fill source-doc coverage gaps:
  - `relationship-travel-coordination` (Job 7 — quarterly travel, recency-bias preferences)
  - `incident-vip-customer-visit` (Jobs 8 + 9 — Caldwell Group CEO onsite, physical logistics + stakeholder management)
- **Total arcs: 24** (was 22). Primary-session distribution: 15 principal / 3 condor / 2 comp / 1 each for legal/family/ea-network/executive-team. Within spec range.
- **Day files deleted:** the 2 EA days from Night 1 (day-0001, day-0008) referenced "Sebastian" + "NorthRiver" framing; deleted so Night 2's regen produces consistent v0.5 + Jordan-flavored output.

**Net effect on Night 1 progress:** day count rolls back from 2 → 0. Phase A and bug fix work persist. Night 2 effectively starts from scratch on EA generation, with a richer persona aligned to the source doc.

---
