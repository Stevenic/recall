# Program — 2026-05-05

## Mission

Generate a usable v0.5-format memory corpus for the `executive-assistant` persona at `packages/recall-bench/personas/executive-assistant/memories/`, in chronological day order, with each completed chunk committed to git so progress survives interruption and is resumable across multiple nights. Tonight's success = generator is at v0.5 + research-scientist smoke validates the format + EA generation is in progress with at least one committed chunk; the run is structurally resumable by tomorrow's NightBuild.

The full 1,000-day EA corpus is unlikely to complete in a single 6-hour run. Tomorrow night's NightBuild will pick up at the next un-generated day and continue.

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

### Phase B — `research-scientist smoke (30 days)`

Validates Phase A end-to-end against a real generation run on the simplest v0.5 persona before risking EA's larger surface.

Sub-steps:

1. **Delete stale memory days.** `rm packages/recall-bench/personas/research-scientist/memories/day-*.md` (the 3 existing days are pre-v0.5 and would break the consistency canary).
2. **Run smoke.**
   ```bash
   cd C:/source/recall && npx recall-bench generate --persona ./packages/recall-bench/personas/research-scientist --model claude --start 1 --end 30
   ```
   Stream stdout to `<run_dir>/raw/phase-b-smoke.log`.
3. **Sample-day inspection** — pick days 1, 8, 15, 22, 30. For each, verify:
   - Frontmatter has `type: daily` plus day/date/persona/active-sessions
   - At least one `# session: <id>` H1 emitted
   - No empty session H1s
   - No `## YYYY-MM-DD` legacy headers
4. **Boundary canary.** `grep -B1 -A30 "Chen Lab's proprietary LNP" packages/recall-bench/personas/research-scientist/memories/day-*.md` should return either zero matches OR matches only under `# session: collab-chen` (the lifecycle for that session is days 300–700, so within days 1–30 it should be zero matches — this is the cleanest possible smoke).

**Done bar:** 30 day-NNNN.md files exist under `research-scientist/memories/`; all 5 sampled days pass the inspection checklist; boundary canary clean; no `[generator] arc=... skipped:` lines in stderr.

### Phase C — `EA full generation (chunked, resume-safe)`

The main work. Iterative — each tick generates one chunk (~50 days), verifies, commits, schedules next. The chunk size is tuned so each tick stays under 20 minutes of wall-clock work (PLAYBOOK §6 / NIGHTBUILD §Tick recipe step 4).

Sub-step recipe (one per tick):

1. Determine the next day to generate: `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md | sort | tail -1` → the highest existing day. Next start = highest + 1, or 1 if no days exist.
2. Compute end day: `min(start + 49, 1000)`.
3. Run:
   ```bash
   cd C:/source/recall && npx recall-bench generate --persona ./packages/recall-bench/personas/executive-assistant --model claude --start <start> --end <end>
   ```
   Stream to `<run_dir>/raw/phase-c-chunk-<NNNN>.log`.
4. Verify: `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md | wc -l` matches expected count. Scan stderr for skipped days; if >2 in this chunk, log BLOCKED and yield.
5. Commit per § Tick recipe step 8.

**Done bar (per chunk tick):** chunk's day-NNNN.md files exist; `git log -1` shows a commit covering the chunk; `consecutive_blocked` is reset to 0.

**Done bar (phase complete — only achievable on a future night):** `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md | wc -l` returns 1000.

### Phase D — `morning-readiness gate`

Runs as the final tick before exit. Proves the run produced a useful, resumable corpus state.

Sub-steps:

1. Count EA memory files: `ls packages/recall-bench/personas/executive-assistant/memories/day-*.md | wc -l`. Record `<N>`.
2. Sample-day inspection on 3 random EA days from the produced corpus (same checklist as Phase B step 3).
3. Boundary canary across the EA corpus: `grep -B1 "Project Condor target identity" packages/recall-bench/personas/executive-assistant/memories/day-*.md | grep "^# session:"` — every match must show `# session: project-condor`. Any other session H1 in front of those lines is a leak.
4. Confirm git state is clean: `git status --porcelain` returns empty.
5. Write `<run_dir>/handoff.md` per NIGHTBUILD § End-of-overnight protocol step 1, including the resume command for tomorrow night.

**Done bar:** at least 30 EA day files exist (Phase A + B prerequisite plus at least one Phase C chunk landed); all 3 sampled days pass inspection; boundary canary clean; git clean; handoff.md written.

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
