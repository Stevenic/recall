# NightBuild morning summary — 2026-05-06

## Status: BLOCKED — needs your input on generation-speed strategy

Tonight's NightBuild landed Phase A (v0.5 day-generator sync) cleanly and discovered + fixed a duplicate-H1 bug in the arc-merge logic. Phase B (smoke validation) was killed early because at the current per-day generation cost (~3 min/arc-day invocation), the full EA corpus would take ~7 days of wall-clock — not viable for "tests this week" without a strategy change.

## What landed

| Phase | Status | Commits |
|---|---|---|
| Boot tick | ✅ passed | `902b1c0` (kickoff seal) |
| Phase A — v0.5 day-generator sync | ✅ complete | `8dc7c71`, `9653ee0` |
| Phase B step 1 — delete pre-v0.5 stale days | ✅ committed | `91e81ff` |
| Phase B step 2 — smoke validation | ⚠️ partial — killed mid-run | (no commit; the 5 partial day files were deleted) |
| Phase B fix — arc-merge duplicate-H1 | ✅ committed but unvalidated | `6e42b72` |
| Phase C — EA full generation | ⏸ not started — blocked | — |
| Phase D — morning-readiness gate | ⏸ not reached | — |

**On disk:**
- `packages/recall-bench/src/generator-types.ts` — full v0.5 schema (sessions, sharedKnowledge, primarySession, referencedSessions, echoToday)
- `packages/recall-bench/src/generator.ts` — `buildSystemPrompt` v0.5, `getActiveArcs` with session affinity, `computeActiveSessions`, `buildUserMessage` with active-sessions hint, `buildArcUserMessage` with merge rules
- All commits on branch `nightbuild/2026-05-05` (off `main`). 122/122 unit tests still pass; tsc clean.

**Pre-composed commit/PR text:** `.nightbuild/2026-05-05/handoff.md` — pipe directly to `git commit -F` or `gh pr create --body-file`.

## What's blocked / needs human

**Tonight's measured cost:** `--model claude` (claude-opus-4-7 via the local `claude` CLI) takes **~3 minutes per arc-day invocation** on Windows. With multi-arc days each requiring N arc invocations to merge into one day file, the projection for the full EA corpus is **~175 hours of wall-clock** (≈7 days continuous). At this rate one overnight produces ≈12% of one persona.

The full strategy options + my recommendation are in `.nightbuild/2026-05-05/log.md` under `## NEEDS HUMAN`. TL;DR:

- **Option A** — switch to a faster model (haiku-4-5 via custom adapter). Expected 4-6× speedup. ~30 min of engineering.
- **Option B** — reduce EA scope to 200-300 days for the first pass. Hits 30d/90d/6mo Q&A range minimums; misses 1y/full.
- **Option C** — SDK with prompt caching. ~10× input-cost reduction; smaller wall-clock win. 1-2 hours of engineering.
- **Option D** — parallelize. Not recommended without harness changes.

**Recommended:** A + B together → custom haiku adapter + EA scoped to 300 days. Usable corpus by mid-week.

## Resume instructions (tomorrow night)

1. Open `TONIGHT.md` and write a directive like:
   ```
   Tonight: implement a haiku-model adapter at packages/recall-bench/src/defaults/haiku-model.ts, smoke-validate it against research-scientist (5 days), then kick off EA generation with --model ./packages/recall-bench/dist/defaults/haiku-model.js, days 1-300, in 50-day chunks. Resume-safe across nights.
   ```
   (Adjust per the option you choose. If you want me to draft the haiku adapter ahead of time, I can do that on demand before sleeping tonight.)

2. Re-invoke the NightBuild kickoff prompt:
   ```
   Read the NIGHTBUILD.md file at https://raw.githubusercontent.com/Stevenic/nightbuild/main/NIGHTBUILD.md
   and follow its instructions to kick off a night build for this project.
   ```

3. At the branch decision prompt, answer **always** to save `branch_policy: "current"` so tomorrow's commits keep stacking on `nightbuild/2026-05-05` instead of creating a new branch.

4. The kickoff will read `.nightbuild/learnings.md` (will exist after this morning's distill — see below) and incorporate tonight's lessons into tomorrow's program.

## Commit & PR

Tonight's run created **5 commits** on branch `nightbuild/2026-05-05` (off `main`):

```bash
# See the diff vs main
git -C C:/source/recall log main..nightbuild/2026-05-05 --oneline
git -C C:/source/recall diff main..nightbuild/2026-05-05 --stat
```

Three options:

**Keep + merge (recommended for finished work; not yet for tonight's run):**
```bash
git -C C:/source/recall checkout main
git -C C:/source/recall merge nightbuild/2026-05-05
```

**Keep + open a PR:**
```bash
git -C C:/source/recall push -u origin nightbuild/2026-05-05
gh pr create --title "$(head -n1 C:/source/recall/.nightbuild/2026-05-05/handoff.md)" --body-file C:/source/recall/.nightbuild/2026-05-05/handoff.md
```

**Discard (if you want to try a different approach from scratch):**
```bash
git -C C:/source/recall checkout main
git -C C:/source/recall branch -D nightbuild/2026-05-05
```

I recommend **keep** but defer the merge until tomorrow's run extends EA into a usable corpus state. The branch isn't "done" until at least Phase B re-smoke validates the duplicate-H1 fix and Phase C produces some EA day files.

The pre-composed commit/PR body is at `.nightbuild/2026-05-05/handoff.md` — it covers what changed, what's still pending, and validation commands.

## Per-run narrative

Full per-tick log: `.nightbuild/2026-05-05/log.md` (5 ticks from kickoff through this BLOCKED entry).
