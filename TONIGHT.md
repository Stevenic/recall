# TONIGHT.md — recall

**Role:** the queue of things you want NightBuild to do the next time you kick off a run.
**You write to this file.** The agent drains it at kickoff (synthesizes it into the per-run program at `<run_dir>/program.md`, asks you clarifying questions, then resets this file to the empty scaffold). The autonomous loop does NOT read this file during ticks.

> Add to this file across the day as ideas come up. When you kick off a night build, the agent reads what's here, asks the questions it needs to make each task testable, writes the program, and clears this queue. Whatever was here gets archived verbatim in `<run_dir>/log.md` under "Kickoff inputs".
>
> If this file is empty when you kick off, the agent will ask you what to do tonight from scratch.

---

## Focus for the next run

<one or two sentences: what should the run bias toward? e.g. "land Phase D — the smoke is the bottleneck", or "stretch goal: try the Windows installer path if A–F land before 2am">

## Tasks queued

- [ ] <task 1 — concrete, scoped, single phase if possible>
- [ ] <task 2>
- [ ] <task 3>

## Hints / context that won't be obvious from the repo

- <e.g. "the test in foo_test.go is flaky on Windows — retry once before treating as a real failure">
- <e.g. "I rebased main this evening; the branch is at <sha>">

## Hard nos for the run

- <e.g. "do not touch the auth middleware — I'm in the middle of refactoring it">
- <e.g. "no dependency upgrades">
