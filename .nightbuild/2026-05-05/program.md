# Program — 2026-05-05

## Mission

**Night 1 of a 10-night epic.** Generate the v0.5 multi-session memory corpus for the `executive-assistant` persona, in chronological day order, with each completed chunk committed to git. Across-night plan and progress: `.nightbuild/ea-corpus-epic.md`.

Tonight's success criterion = (1) Phase A v0.5 day-generator landed, (2) duplicate-H1 bug fix validated end-to-end via a small live smoke, (3) EA generation in progress with at least one committed chunk of new days, (4) state cleanly resumable by tomorrow's NightBuild kickoff.

The full 1,000-day EA corpus is **explicitly multi-night** — this is a 10-night epic. Each night ends with a brief progress entry appended to `.nightbuild/ea-corpus-epic.md`.

## Scope deviations

| Spec requirement | Substitution | Reason |
|---|---|---|
| Q&A pairs (`PLAYBOOK.md` Phase 4) | Deferred entirely | Per `specs/recall-bench.md` §4.5, Q&A authoring requires a complete memory stream. Scope tonight = memory generation only. |
| Consistency checker (`specs/recall-bench.md` §4.4) | Manual boundary grep at smoke time | The full LLM consistency pass isn't implemented as a CLI; the boundary grep in PLAYBOOK §6.4 is the v0.5 leak canary. |
| Run other personas (`PLAYBOOK.md` §6.1 ordering) | Deferred to future nights | Tonight focuses on EA per user direction. Smoke uses research-scientist as the validator only. |

**Architectural invariants retained:** v0.5 multi-session day file format (`# session: <id>` H1 per active session, pre-H1 internal narration) per `specs/recall-bench.md` §4.7. Boundary isolation invariant — `sensitive_topics` from isolated sessions never appear under another session's H1. Resume safety — every tick commits.

## Inputs (from kickoff Q&A)

- `parent_branch` — `main`
- `persona_id` — `executive-assistant`
- `smoke_persona_id` — `research-scientist`
- `chunk_size_days` — `50` (per-tick generation chunk for the EA full run)
- `budget_max_usd` — none (no cap; track tokens only)
- `usd_per_mtok` — none

## Phase plan

### Phase A — `v0.5 day-generator sync`

The day-generator at `packages/recall-bench/src/generator.ts:351` (`buildSystemPrompt`) currently emits the v0.2 single-section format and ignores `sessions`/`sharedKnowledge`. The TypeScript types in `src/generator-types.ts` don't declare these fields. Without this phase, every memory day produced tonight is structurally wrong.

Sub-steps:

1. **Type sync.** Edit `packages/recall-bench/src/generator-types.ts`:
   - Add `SessionDef` interface (id, kind, participants, isolated?, shared?, firstDay?, lastDay?, sensitive_topics?)
   - Add `sessions?: SessionDef[]` and `sharedKnowledge?: string[]` to `PersonaDefinition`
   - Add `primarySession?: string`, `referencedSessions?: string[]`, `participants?: string[]` to `ArcDefinition`
   - Add `primarySession?: string`, `referencedSessions?: string[]`, `echoToday?: boolean` to `ActiveArc`
   - Reference: `specs/day-generator.md` §3.1.1 for canonical schema.
2. **Prompt rebuild.** Replace the body of `buildSystemPrompt` so it renders, in order: Identity / Profile / Communication style / Principal / Cast / **Sessions** / **Shared knowledge** / **How to partition the log by session** / **multi-session Required output structure**. Apply the conditional rendering rules in `specs/day-generator.md` §3.1.3 (omit Sessions block when absent; legacy fallback when absent). Copy the exact text of "How to partition the log by session" from `specs/day-generator.md` §3.1.2 — do not paraphrase.
3. **Active-arc plumbing.** Update `getActiveArcs` in `src/generator.ts` to surface `primarySession`, `referencedSessions`, and a computed `echoToday` flag (see `specs/recall-bench.md` §3.3 for the policy: arc start day, arc end day, decision moments / `directives[].day` entries, sprint boundaries every ~14 days). Be conservative — too many echoes pollute referenced sessions.
4. **Day-context plumbing.** Update the per-day user message to include the active-sessions list (which session H1s should be emitted today, derived from arc primarySessions + referenced sessions where echoToday is true).
5. **Type-check + smoke.** `cd packages/recall-bench && npx tsc --noEmit` must pass. Then run a one-shot prompt-build verification:
   ```bash
   cd C:/source/recall/packages/recall-bench && npx tsx -e "import yaml from 'yaml';import {readFileSync} from 'node:fs';import {buildSystemPrompt} from './src/generator.ts';const p=yaml.parse(readFileSync('personas/executive-assistant/persona.yaml','utf8'));console.log(buildSystemPrompt(p))" 2>&1 | grep -E '^(# Sessions|# Shared knowledge|# How to partition|# session:)' | head -10
   ```

**Done bar:** All four matched lines appear in the prompt-build smoke output (`# Sessions`, `# Shared knowledge`, `# How to partition`, and the `# session:` template marker). `tsc --noEmit` passes. Existing tests still pass: `cd packages/recall-bench && npm test`.

### Phase B — `validate duplicate-H1 fix (small live smoke)`

A 3-day research-scientist smoke. Purpose is not exhaustive validation — it's specifically to confirm commit `6e42b72`'s prompt-level merge rules eliminate the duplicate `# session: principal` H1s observed in the prior smoke.

Why 3 days and not 30: at ~3 min per `claude` CLI invocation × multi-arc-merge per day, even a 5-day smoke costs ~30 min. We have measured throughput data already; the only open question is whether the merge fix works.

Sub-steps:

1. **Run smoke.** `cd C:/source/recall && npx recall-bench generate --persona ./packages/recall-bench/personas/research-scientist --model claude --start 1 --end 3`. Stream stdout to `<run_dir>/raw/phase-b-validate.log`.
2. **Inspect.** For each emitted day-NNNN.md file, count `^# session: principal$` H1s. Each must equal exactly 1. Same for any other declared session.
3. **If duplicates found:** investigate the prompt; iterate fix; re-smoke. Up to 3 attempts per § Tick recipe step 7.

**Done bar:** Every emitted day file in days 1–3 has at most one H1 per session. No duplicate `# session: <id>` H1s anywhere in the inspection set.

### Phase C — `EA generation (Night 1 chunk)`

Iterative — each tick runs ~25 minutes of generation (one `recall-bench generate` invocation against a calendar-day range). The number of calendar days emitted per tick varies based on how many arcs touch that range, but each tick aims for ~6–10 unique calendar days landed.

Sub-step recipe (one per tick):

1. **Determine resume point.** `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md 2>/dev/null | sort | tail -1` → highest existing day. Next start = `highest + 1`, or `1` if no days exist.
2. **Pick chunk end.** Conservative chunk: `start + 24` (25 calendar-day window). Multi-arc days will trigger merges within that window — 25 days × ~5 invocations/day ≈ 125 invocations. At 3 min each that's ~6 hours, too long for one tick. So use a smaller window: `start + 9` (10-day chunk → ~50 invocations → ~25 minutes/tick). Iterate.
3. **Run** `npx recall-bench generate --persona ./packages/recall-bench/personas/executive-assistant --model claude --start <start> --end <end>` in foreground (single tick) OR background (long-tick with monitor wakeup). For ~25-min ticks, foreground is fine.
4. **Verify.** Count files; confirm no skipped-day stderr lines.
5. **Commit** per § Tick recipe step 8 with message `phase-c: ea days <start>-<end>`.

**Done bar (per chunk tick):** chunk's day-NNNN.md files exist; commit landed; `consecutive_blocked` reset.

**Done bar (Night 1 phase done):** at least one Phase C chunk committed; resume command for tomorrow recorded in `.nightbuild/ea-corpus-epic.md`.

**Done bar (epic complete — Night 10 or earlier):** EA day count ≥ 1000.

### Phase D — `Night 1 progress checkpoint`

Runs when the wall-clock budget is ~80% consumed OR when an EA chunk lands at a clean stopping point. Lightweight, not a full morning gate (the epic spans 10 nights).

Sub-steps:

1. Count EA memory files: `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md 2>/dev/null | wc -l`. Record as `night_1_total`.
2. Boundary canary spot-check: `grep -l "Project Condor target identity" packages/recall-bench/personas/executive-assistant/memories/day-*.md 2>/dev/null` — if matches, confirm via grep that they appear under `# session: project-condor` only. (No matches yet is fine — Project Condor's lifecycle starts day 100, so early chunks won't have leak surface.)
3. Confirm git state clean.
4. Append a Night 1 progress entry to `.nightbuild/ea-corpus-epic.md` with: total EA days emitted, resume start day for tomorrow, anything notable from this night.
5. Write minimal `<run_dir>/handoff.md` (one paragraph; the epic file carries the longer narrative).

**Done bar:** progress entry appended to `.nightbuild/ea-corpus-epic.md`; git clean; handoff.md written; next wakeup not scheduled (run ends, user re-kicks tomorrow).

## Authority overrides

Allow:
- Editing files inside `packages/recall-bench/`
- Running `npm test`, `npx tsc`, `npx tsx`, `npx recall-bench generate` (which subprocesses to `claude` CLI)
- Standard git ops on the `nightbuild/2026-05-05` branch
- `rm` on the 3 stale `research-scientist/memories/day-{0001,0002,0008}.md` files (Phase B step 1)

Deny (NIGHTBUILD defaults retained):
- Pushing to remotes
- `--no-verify` or hook bypass
- Modifying anything outside `packages/recall-bench/`

## Budget

- Cap: 6 wall-clock hours from kickoff (NIGHTBUILD default)
- Started at: 2026-05-06T01:29:18Z
- Cost cap: none (track tokens only)
