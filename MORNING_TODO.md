# NightBuild morning summary — 2026-05-06 (Night 1 / 10)

## Status: partial — 2 EA days landed, bug fix validated, ended early due to timeouts

Tonight was Night 1 of a 10-night EA corpus epic. Foundation work is done (day-generator at v0.5, duplicate-H1 bug fix validated end-to-end), and the first EA chunk produced 2 days before two `claude` CLI timeouts caused me to cut the run short with ~80 min of budget unused.

## What landed

| Phase | Status | Commit |
|---|---|---|
| Phase A — day-generator v0.5 sync | ✅ complete | `8dc7c71`, `9653ee0` |
| Phase B — duplicate-H1 fix landed | ✅ committed | `6e42b72` |
| Phase B' — fix validated end-to-end | ✅ smoke clean (3-day research-scientist) | (no commit; smoke days deleted) |
| Phase C — EA chunk 1-10 | ⚠️ partial: days 1 and 8 emitted, chunk killed after 2 timeouts | `b4ccf16` |

**On disk:**
- `packages/recall-bench/personas/executive-assistant/memories/day-0001.md` — clean v0.5 multi-session, 4 H1s (principal, direct-reports, ea-network, family), no duplicates
- `packages/recall-bench/personas/executive-assistant/memories/day-0008.md` — same shape

**Total commits on `nightbuild/2026-05-05` since main:** 9.

## What's blocked / needs human

Nothing blocking, but two issues worth your awareness on Night 2:

1. **Timeouts cost 10 min each and made no progress.** `--timeout` defaults to 600000ms. On Night 2, consider passing `--timeout 300000` to fail faster. Skipped days can be retried.
2. **Session-selection drift.** The LLM picked 4 sessions for days 1 and 8 instead of the 5-6 expected per the active-sessions list in the user message. Not structurally broken; merging missing arcs into those days on Night 2's rerun should clean it up. If it persists, the `buildUserMessage` active-sessions instruction needs to be made stricter.

## Persona refreshed between Night 1 and Night 2

After Night 1 closed, you supplied the EA Persona Source Document (April 2026) and asked me to update the persona. Changes:
- Agent renamed: Sebastian → **Jordan** (first-name-only convention)
- Domain: industrial → **large technology company** (Mosaic Systems)
- Profile + communication style rewritten to match the source doc's EA traits (anticipatory, discreet, judgment-bearing, ambiguity-absorbing)
- `sharedKnowledge` expanded with §10 calendar/stakeholder/sensitive/physical rules
- **24 arcs** now (was 22) — added `relationship-travel-coordination` (Job 7) and `incident-vip-customer-visit` (Jobs 8+9, Caldwell Group CEO onsite)
- **Night 1's 2 EA days deleted** — they used the old Sebastian/NorthRiver framing. Night 2 starts EA generation from scratch.

Full diff of the refresh is in the same commit as this update; details in `.nightbuild/ea-corpus-epic.md`.

## Resume instructions (Night 2 — tonight)

Update `TONIGHT.md` with:
```
Night 2/10 of EA corpus epic. Persona was refreshed (Jordan, Mosaic Systems, EA-source-doc framing); EA day files reset.
  Step 1: npx recall-bench generate --persona ./packages/recall-bench/personas/executive-assistant --model claude --start 1 --end 10 --timeout 300000
  Step 2: continue with --start 11 --end 20 (and onward) until budget cap.
Append Night 2 entry to .nightbuild/ea-corpus-epic.md at end of run.
```

Then re-invoke the NightBuild prompt. The kickoff will read `TONIGHT.md`, `.nightbuild/learnings.md`, and `.nightbuild/ea-corpus-epic.md`. Choose **always** at the branch decision prompt (saves `branch_policy: "current"` so all 10 nights stack on `nightbuild/2026-05-05`).

## Per-night ledger

`.nightbuild/ea-corpus-epic.md` — durable across-night progress log. Night 1 entry appended.

## Commit & PR

Tonight's run is on `nightbuild/2026-05-05` with 9 commits since `main`. Don't merge yet — branch isn't useful until at least 100-200 EA days land. Diff command:

```bash
git -C C:/source/recall log main..nightbuild/2026-05-05 --oneline
```
