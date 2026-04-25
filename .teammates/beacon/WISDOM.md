# Beacon - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: 2026-04-25

---

## Engineering

**Read before editing**
Inspect the module, its call sites, and existing tests before changing behavior. Most regressions come from changing one layer in isolation.

**Small surfaces win**
Prefer narrower interfaces, fewer flags, and obvious data flow. If a helper only serves one caller, keep it close — don't invent a shared abstraction.

**Tests prove the contract**
Add or update tests for the observable behavior you changed. Happy path alone is insufficient — bugs hide in state transitions, error paths, and edge conditions.

**Export pure functions for testability**
Extract state-computation logic as pure exported functions alongside stateful classes. Pure functions are trivially testable without mocks; the class stays focused on orchestration.

**Ship verified code**
Build, run the relevant tests, and call out any verification gap plainly. Don't log completion until the file is written and verified — false "done" entries poison future debugging.

**Verify outputs, not exit codes**
A clean exit doesn't prove the operation did work. After batch jobs, generators, or filters, check the artifacts you expected — file count, size, content. Silent zero-result runs with exit 0 are the worst failure mode because they look like success.

**Persist work incrementally in batch jobs**
In long-running batch jobs (generation, migration, indexing), commit each item to disk as soon as it completes — never accumulate in memory and write at the end. A timeout, crash, or single failure on item 22 must not lose work for items 1–21. Hook into per-item completion (e.g. `onDay`, `onItem`) and write immediately.

**Isolate per-item failures in batch loops**
Wrap each iteration's risky call (model, network, subprocess) in try/catch and continue with a one-line skip log. One flaky call must not abort an N-item run. The exception boundary is what separates "one bad item" from "whole run failed."

**Clean dist AND tsbuildinfo before rebuilding**
Always remove `dist/` and `*.tsbuildinfo` before `npm run build`. With `composite: true`, a stale `.tsbuildinfo` can make tsc skip emit entirely — the build succeeds but produces no output.

**Lint after every build**
Run the linter with auto-fix after the build, then rebuild if lint changed code. Build → lint → rebuild is the required verification loop.

**Make destructive operations dry-run capable**
Operations that mutate or delete data (compaction, migrations, bulk updates) should support a dry-run mode. Makes testing, debugging, and user confirmation trivial.

**Prefer stable identities over index math**
Track durable item identity instead of parallel index-keyed structures when state can shift. Index-heavy designs make insertion, deletion, and selection brittle.

**Instrumentation must not break the primary path**
Observability hooks (search logging, metrics, telemetry) should be best-effort with try/catch. A logging failure must never fail the operation being logged.

**Wrap parseInt/parseFloat as Commander coercers**
Commander invokes coercers as `coerce(value, previousValue)`, so `parseInt("1", 1)` treats `1` as the radix and returns `NaN`. Always wrap: `(v: string) => parseInt(v, 10)`. The `??` default guard does NOT catch `NaN` (it's not nullish), and `NaN` propagates silently through comparisons (`x >= NaN` is always false), producing zero-result runs with exit 0.

**Gate per-tool flags on tool identity**
When one adapter wraps multiple CLI tools, do not append flags universally. Built-in CLIs (`claude`, `codex`, `copilot`) and custom CLIs accept different flag sets — assuming universal support produces immediate exit 1 errors. Branch on tool identity before adding tool-specific flags.

## Architecture

**Verify spec assumptions against actual dependencies**
Specs may claim a library exports interfaces it doesn't. Check actual package types before designing around a re-export. Build your own narrow abstraction when needed — but when upstream catches up (e.g., Vectra 0.14.0), adopt it to reduce maintenance.

**Compaction prompts are product surface**
Compaction prompt constants drive wisdom distillation quality. Treat them as first-class: low temperature (0.2), structured output sections, explicit MERGE/ADD/DROP semantics.

**Keep sibling packages self-contained**
When a new package needs a similar abstraction to core (e.g., `GeneratorModel` vs `MemoryModel`), implement independently. Coupling packages that evolve at different rates creates upgrade friction.

**Store rich data in frontmatter, not index metadata**
When the index engine has type constraints (e.g., Vectra's `MetadataTypes` doesn't support arrays), keep complex/nested data in YAML frontmatter and read it at query time. Index metadata stays flat and filterable.

**Feature-flag new pipelines with graceful fallback**
Gate new architectural modes behind a config flag and fall back to prior behavior when disabled. Incremental adoption, trivial rollback.

**Convention over configuration for directory layout**
Replace multiple output path flags with a single root directory and well-known subdirectories. Fewer flags, discoverable structure, commands that compose without manual path wiring.

**Prefer dynamic proto loading over codegen**
Use `@grpc/proto-loader` for runtime proto loading instead of build-time `protoc` codegen. Keeps the proto file as the single source of truth and simplifies contributor setup.

**Parse LLM output with structured-then-freeform fallback**
When consuming LLM-generated output, try JSON parsing first and fall back to freeform text extraction. Never discard output because it wasn't perfectly structured — a low-confidence result beats no result.

## Cross-Platform

**Normalize backslash paths**
When using `path.basename()` or similar utilities on paths that may contain Windows backslashes, normalize `\` to `/` first. On Linux, `path.basename()` does not recognize `\` as a separator.

**ESM path resolution must be explicit**
Resolve sibling files with `fileURLToPath(new URL(..., import.meta.url))`, never `__dirname`. Path-sensitive startup code should fail loudly; silent catches hide broken behavior.

**Spawned stdin needs EOF protection**
Whenever writing to a child process stdin, attach an error handler that swallows `EPIPE` and `EOF`. Some processes close stdin early — that should not crash the parent.

**Windows spawn timeout needs explicit watchdog**
Node's `spawn({ timeout })` uses SIGTERM, which Windows doesn't honor — hung subprocesses run forever. Use a `setTimeout` watchdog that calls `taskkill /PID <pid> /T /F` on Windows (POSIX falls back to SIGKILL). The `/T` flag matters because `shell: true` makes the real subprocess a grandchild of `cmd.exe`; without it you only kill the wrapper. Wrap `resolve`/`reject` in a `settled` flag so the watchdog and a delayed `close` event can't double-settle the Promise.

## Monorepo

**Version bumps touch every reference**
When bumping versions, update all package manifests and grep for other copies of the old version string. Partial bumps leave the workspace inconsistent.

**Workspace deps should stay wildcarded**
Use `"*"` for workspace package references. Pinned semver can resolve to registry builds or invalidate newer local workspace packages after a bump.

## Process

**Spec first for major UI shifts**
Write the UI spec before implementing changes that alter layout, action placement, or state ownership. Terminal UI work drifts fast without a written target.

**Oversized files deserve structural fixes**
Once a source file grows beyond comfortable review size, recommend extraction — not just more careful editing.

**Restart the process after rebuilds**
Node.js caches modules at startup. After rebuilding packages, the running process still uses old code until restarted.
