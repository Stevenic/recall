# Beacon - Wisdom

Distilled principles. Read this first every session (after SOUL.md).

Last compacted: 2026-04-14

---

## Engineering

**Read before editing**
Inspect the module, its call sites, and existing tests before changing behavior. Most regressions come from changing one layer in isolation.

**Small surfaces win**
Prefer narrower interfaces, fewer flags, and obvious data flow. If a helper only serves one caller, keep it close — don't invent a shared abstraction.

**Tests prove the contract**
Add or update tests for the observable behavior you changed. Happy path alone is insufficient when bugs hide in state transitions, error paths, or edge conditions.

**Export pure functions for testability**
Extract state-computation logic as pure exported functions alongside stateful classes. Pure functions are trivially testable without mocks; the class stays focused on orchestration.

**Ship verified code**
Build, run the relevant tests, and call out any verification gap plainly. Don't log completion until the file is written and verified — false "done" entries poison future debugging.

**Clean dist AND tsbuildinfo before rebuilding**
Always remove `dist/` and `*.tsbuildinfo` before `npm run build`. With `composite: true`, a stale `.tsbuildinfo` can make tsc skip emit entirely — the build succeeds but produces no output.

**Lint after every build**
Run the linter with auto-fix after the build, then rebuild if lint changed code. Build → lint → rebuild is the required verification loop.

**Make destructive operations dry-run capable**
Operations that mutate or delete data (compaction, migrations, bulk updates) should support a dry-run mode. This makes testing, debugging, and user confirmation trivial.

**Prefer stable identities over index math**
Track durable item identity instead of parallel index-keyed structures when state can shift. Index-heavy designs make insertion, deletion, and selection brittle.

**Instrumentation must not break the primary path**
Observability hooks (search logging, metrics, telemetry) should be best-effort with try/catch. A logging failure must never fail the operation being logged.

## Architecture

**Verify spec assumptions against actual dependencies**
Specs may claim a library exports interfaces it doesn't. Before designing around a re-export, check the actual package types. Build your own narrow abstraction when needed — but when upstream catches up (e.g., Vectra 0.14.0), adopt it to reduce maintenance.

**Compaction prompts are product surface**
Compaction prompt constants drive wisdom distillation quality. Treat them as first-class: low temperature (0.2) for summarization, structured output sections, explicit MERGE/ADD/DROP semantics.

**Keep sibling packages self-contained**
When a new package needs a similar abstraction to core (e.g., `GeneratorModel` vs `MemoryModel`), implement independently rather than creating a cross-package dependency. Coupling packages that evolve at different rates creates upgrade friction.

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
