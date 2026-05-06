recall-bench: lift day-generator to v0.5 multi-session; flag generation-speed blocker

Tonight's NightBuild landed the day-generator v0.5 schema sync (Phase A complete) and a fix for an arc-merge duplicate-H1 bug discovered during smoke. The Phase B smoke run was killed early because per-day generation against `--model claude` is ~3 min/arc-day invocation, projecting ~7 days of wall-clock for the full 1000-day EA corpus. EA generation is blocked on a strategy decision (faster model, scope reduction, or both) — see `.nightbuild/2026-05-05/log.md` NEEDS HUMAN block.

## What changed

- `packages/recall-bench/src/generator-types.ts` — added `SessionDef` interface; added `sessions?: SessionDef[]` and `sharedKnowledge?: string[]` to `PersonaDefinition`; added `primarySession?`, `referencedSessions?`, `participants?` to `ArcDefinition`; added `primarySession?`, `referencedSessions?`, `echoToday?` to `ActiveArc`; added `activeSessions?: string[]` to `DayContext`.
- `packages/recall-bench/src/generator.ts` — rewrote `buildSystemPrompt` to render `# Sessions`, `# Shared knowledge`, `# How to partition the log by session`, and v0.5 multi-session output structure (with v0.2 fallback for legacy personas without a `sessions:` block); added `computeEchoToday`, updated `getActiveArcs` to surface session affinity; added `computeActiveSessions` exported helper; `buildDayContext` populates `activeSessions`; `buildUserMessage` renders the active-sessions hint plus per-arc affinity in YAML; `buildArcUserMessage` adds explicit merge rules to prevent duplicate session H1s when integrating arc activity into an existing log.
- `packages/recall-bench/personas/research-scientist/memories/day-{0001,0002,0008}.md` — deleted (pre-v0.5 stale).
- `.nightbuild/2026-05-05/` — full run log, program, state, and morning artifacts (this file plus `MORNING_TODO.md` at the repo root).

All commits on branch `nightbuild/2026-05-05` off `main`. 122/122 unit tests pass. Working tree clean modulo the run-scratch updates from this final tick.

## What didn't land / known issues

- **Phase B smoke incomplete.** Killed at 8/30 invocations after duplicate-H1 bug discovery. The 5 partial day files were deleted; tomorrow's re-smoke under a faster model is the right path.
- **Duplicate-H1 fix unvalidated end-to-end.** The prompt change in `buildArcUserMessage` is correct on its face, but no LLM-output-level smoke has yet confirmed the new merge rules eliminate the duplication. Tomorrow's smoke will validate.
- **Phase C (EA full generation) not started.** Blocked on the speed-strategy decision. Tonight produced no EA memory days.
- **No Q&A pairs generated.** Per the playbook order, Q&A authoring follows memory generation. With memories not generated, Q&A is correctly deferred.

## How to validate

```bash
git -C C:/source/recall log nightbuild/2026-05-05 --oneline | head -10
git -C C:/source/recall diff main..nightbuild/2026-05-05 --stat

cd C:/source/recall/packages/recall-bench
npx tsc --noEmit          # expect: clean exit
npm test                  # expect: 122 pass

# Confirm the v0.5 prompt wiring on the EA persona:
node -e "
import('yaml').then(async ({default: yaml}) => {
  const fs = await import('node:fs');
  const {buildSystemPrompt} = await import('./dist/generator.js');
  const p = yaml.parse(fs.readFileSync('personas/executive-assistant/persona.yaml','utf8'));
  const out = buildSystemPrompt(p);
  for (const m of ['# Sessions', '# Shared knowledge', '# How to partition', '# session: <session-id>', 'lifecycle: day']) {
    console.log((out.includes(m) ? 'OK   ' : 'FAIL ') + m);
  }
});
"
```
