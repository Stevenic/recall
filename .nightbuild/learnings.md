# Learnings — recall

Distilled lessons from past NightBuild runs on this project. Future kickoffs read this file to anticipate gotchas. Sections are organized by topic; the agent prunes, merges, and refines entries to keep the file small. Per-run reflection history lives in each run's `<run_dir>/log.md`.

---

## Slow steps

- `npx recall-bench generate --model claude` on Windows costs **~3 minutes per arc-day invocation** with claude-opus-4-7 via the local `claude` CLI. For multi-arc days the same calendar day is touched once per active arc, so total invocations ≈ days × avg-arcs-per-day. Full EA-persona corpus (1000 days, ~3.5 arcs avg) projects to ~175 hours wall-clock. **Always do a 1-day smoke first to calibrate per-day cost on whatever model adapter you're using — projecting from prior runs at a different model will mislead you.** *first seen 2026-05-05; see `.nightbuild/2026-05-05/log.md`*

- `npx tsx` first-invocation startup latency on Windows is >45s for one-off scripts. For prompt-build smoke tests, prefer rebuilding `dist/` with `npx tsc` and running `node` against compiled output — sub-second iteration. *first seen 2026-05-05*

## Project conventions

- Day-generator persona schema is **v0.5** (multi-session): `persona.yaml` carries `sessions:` and `sharedKnowledge:` blocks; `arcs.yaml` annotates every arc with `primarySession` and (optional) `referencedSessions`. The 5 v1 personas + `executive-assistant` follow this schema; check `specs/recall-bench.md` §2.6/§2.7 and `specs/day-generator.md` §3.1 before changing the prompt template. *first seen 2026-05-05*

- The `--model claude` flag invokes the local `claude` CLI subprocess — coding-agent quirks apply per `docs/recall-bench.md` (no `--temperature` or `--max-tokens` honored). For per-call control, write a custom model adapter in `packages/recall-bench/src/defaults/` and pass its compiled JS path via `--model`. *first seen 2026-05-05*

## Gotchas

- `buildArcUserMessage` (the Pass 1 user prompt) tells the LLM to "keep all existing content" when merging a new arc into an already-touched day, but the LLM will still create a **duplicate `# session: <id>` H1** for the same session unless explicitly told not to. **Fix shipped in commit `6e42b72`** — explicit merge rules in the prompt. Pending end-to-end re-validation under a faster model. If you see two `# session: principal` H1s in a day file after a generation run, the merge prompt has regressed. *first seen 2026-05-05; fix landed; not yet re-confirmed under live LLM output*

- `recall-bench generate` is resume-safe but its progress reporting (`day X/30  day-NNNN.md  (N unique)`) is per-arc, not per-unique-day. Watching the log can mislead you about throughput — count unique day files in the output directory instead. *first seen 2026-05-05*

## Deferred / open

- **Generation-speed strategy** — choose between (a) custom haiku model adapter, (b) reduced EA scope (200-300 days), (c) Anthropic SDK with prompt caching, (d) parallelization. Recommended: a+b. **Required input before EA generation can resume.** *deferred 2026-05-05 in run `.nightbuild/2026-05-05`*

- **Validate the duplicate-H1 merge fix** — commit `6e42b72` adds explicit merge rules to `buildArcUserMessage` but no LLM-output-level smoke confirmed they work. First run of tomorrow's NightBuild should re-smoke 3-5 days under the new model adapter and confirm each multi-arc day has exactly one H1 per session. *deferred 2026-05-05 in run `.nightbuild/2026-05-05`*
