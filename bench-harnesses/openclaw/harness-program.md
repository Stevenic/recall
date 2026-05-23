# Harness Program — Building & Running the OpenClaw Adapter

This file is the operator's playbook for the OpenClaw bench harness. `bench-program.md` (at the recall repo root) tells the agent that **before running any profile whose `harness.adapter:` points into a `bench-harnesses/<system>/` package, it must consult that package's `harness-program.md` first**. This is that file for OpenClaw.

The TL;DR: **the source lives here, but the package builds and runs inside an OpenClaw checkout, not in this repo.** Treat `bench-harnesses/openclaw/` as a vendored sibling — canonical, version-controlled in the recall repo, but materialized into the OpenClaw monorepo for build and execution.

---

## Why this harness is special

The recall in-process harness in `bench-harnesses/recall/` builds and runs from this repo because its only dependency (`recall`) is in this workspace.

The OpenClaw harness can't. It imports:

- `@openclaw/memory-core/runtime-api.js` — the SQLite-backed `MemoryIndexManager`
- `@openclaw/openai-provider/memory-embedding-adapter.js` — vector mode wiring
- type-only imports from `openclaw/plugin-sdk/...`

Those modules only resolve inside the OpenClaw monorepo, where pnpm workspace links and TS path mappings stitch them to the OpenClaw source tree. Trying to `pnpm install` here will fail (`link:../dist-runtime/extensions/memory-core` resolves to nothing). Trying to bundle the source verbatim ends in a forest of dynamic-import string indirections.

So the workflow is: edit here, copy to OpenClaw, build there, point the profile at the dist.

---

## Prerequisites

- A local OpenClaw checkout. Default expected location: `C:/source/OpenClaw` (a sibling of `C:/source/recall`). If yours is elsewhere, export `OPENCLAW_REPO` to its absolute path and substitute below.
- `pnpm` installed and on PATH (OpenClaw uses pnpm workspaces).
- An OpenClaw build at least once — `pnpm install && pnpm build` in the OpenClaw root — so `dist-runtime/extensions/memory-core` exists for the workspace link to target.
- The bench profile you intend to run (e.g., `packages/recall-bench/profiles/ea-180d-openclaw.yaml`).

---

## Workflow: copy → install → build → point → run

### 1. Copy this directory into the OpenClaw checkout

The target path inside OpenClaw is `recall-bench-openclaw/` (sibling of `packages/`, `extensions/`, `src/`):

```powershell
# from the recall repo root
$openclaw = $env:OPENCLAW_REPO; if (-not $openclaw) { $openclaw = "C:/source/OpenClaw" }
$dest = Join-Path $openclaw "recall-bench-openclaw"

# Overwrite source, configs, tests, and the two design docs. Leave the dest's
# node_modules/dist/probe-* artifacts in place if they exist.
Copy-Item -Recurse -Force bench-harnesses/openclaw/src $dest/
Copy-Item -Recurse -Force bench-harnesses/openclaw/tests $dest/
Copy-Item -Force bench-harnesses/openclaw/package.json $dest/
Copy-Item -Force bench-harnesses/openclaw/tsconfig.json $dest/
Copy-Item -Force bench-harnesses/openclaw/tsconfig.build.json $dest/
Copy-Item -Force bench-harnesses/openclaw/vitest.config.ts $dest/
Copy-Item -Force bench-harnesses/openclaw/README.md $dest/
Copy-Item -Force bench-harnesses/openclaw/SPEC.md $dest/
```

Bash equivalent:

```bash
OPENCLAW_REPO="${OPENCLAW_REPO:-C:/source/OpenClaw}"
dest="$OPENCLAW_REPO/recall-bench-openclaw"
mkdir -p "$dest"
cp -R bench-harnesses/openclaw/src "$dest/"
cp -R bench-harnesses/openclaw/tests "$dest/"
cp bench-harnesses/openclaw/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,README.md,SPEC.md} "$dest/"
```

**Do not include `harness-program.md` in the copy.** It only makes sense inside the recall repo where the bench CLI runs.

### 2. Install workspace deps (if needed)

If the package is new in the OpenClaw checkout, or `package.json` changed:

```bash
cd "$OPENCLAW_REPO"
pnpm install
```

If you only changed `src/` or `tests/`, skip this step.

### 3. Run the harness's own tests

Fast sanity check that the workspace links resolve and the lifecycle is intact. Uses a fake `MemorySearchManager`, so no OpenClaw build is required and no API keys are spent:

```bash
pnpm --filter @openclaw/recall-bench-openclaw test
```

Optional smoke against the real 180-day EA corpus from the recall repo:

```bash
RUN_SMOKE_180D=1 RECALL_REPO=C:/source/recall \
  pnpm --filter @openclaw/recall-bench-openclaw test smoke-180d
```

### 4. Build the dist

```bash
pnpm --filter @openclaw/recall-bench-openclaw build
```

Produces `<OPENCLAW_REPO>/recall-bench-openclaw/dist/index.js` (+ `.d.ts`, sourcemap). That file is what the recall-bench CLI loads.

### 5. Point the profile at the dist

Each profile has a `harness.adapter:` field. For OpenClaw it must be an absolute path to the built `index.js` in the OpenClaw checkout — the recall CLI does **not** resolve relative paths into sibling repos.

```yaml
# packages/recall-bench/profiles/ea-180d-openclaw.yaml
harness:
  adapter: C:/source/OpenClaw/recall-bench-openclaw/dist/index.js
  factory: createOpenClawAdapter
  config:
    embeddingProvider: openai
    embeddingModel: text-embedding-3-small
    synthesisModel: gpt-5.4-mini
    answerMode: agent
    synthesisProvider: azure
    # ...
```

If your OpenClaw checkout is somewhere else, edit that one line. Don't try to make it portable with a relative path or env-var substitution — the harness CLI takes the literal string as a filesystem path.

### 6. Run the bench

From the recall repo, exactly as `bench-program.md` describes:

```bash
recall-bench run \
  --profile packages/recall-bench/profiles/ea-180d-openclaw.yaml \
  --json-out bench-results/drafts/openclaw-ea-180d-$(date +%Y%m%d-%H%M%S)/result.json
```

The bench CLI imports the adapter at runtime via dynamic `import()` against the absolute path. Node resolves the dist's own `node_modules` for OpenClaw deps automatically, because the build copied symlinked workspace packages into the OpenClaw checkout's resolution graph.

---

## Iteration loop

You're editing here, building there. The cycle:

1. Edit `bench-harnesses/openclaw/src/...` in the recall repo.
2. Run step 1 from the workflow above (the `Copy-Item`/`cp -R`).
3. Run step 4 (`pnpm --filter ... build`). Skip step 2 (install) unless deps changed.
4. Re-run the bench, or start a fresh checkpoint, or whatever you were doing.

Steps 1 + 4 can be wrapped in a small script or `Makefile` target if you're iterating a lot. Don't be tempted to symlink `bench-harnesses/openclaw/src` into the OpenClaw repo; on Windows in particular the workspace resolver gets cranky with symlinks across drives.

---

## Environment variables the adapter reads

These are read by the adapter's default export (when the bench loads `dist/index.js` without a custom factory call) and by the profile config when present:

| Var                          | Default                  | Purpose                                        |
|------------------------------|--------------------------|------------------------------------------------|
| `OPENAI_API_KEY`             | —                        | Required for vector mode + OpenAI synthesis    |
| `AZURE_OPENAI_API_KEY`       | —                        | Required when `synthesisProvider: azure`       |
| `AZURE_OPENAI_ENDPOINT`      | —                        | Azure resource base URL                        |
| `AZURE_OPENAI_API_VERSION`   | —                        | Azure API version                              |
| `RECALL_OC_EMBED_PROVIDER`   | `auto`                   | `openai` enables vector mode; `auto` is FTS    |
| `RECALL_OC_EMBED_MODEL`      | `text-embedding-3-small` | Embedding model id (vector mode only)          |
| `RECALL_OC_SYNTHESIS_MODEL`  | `gpt-4.1-mini`           | Chat model for prose synthesis                 |
| `RECALL_OC_MAX_RESULTS`      | `15`                     | Max chunks fed to synthesis / agent context    |
| `RECALL_OC_MIN_SCORE`        | `0.1`                    | Minimum chunk score                            |

Profile config (`harness.config.*`) wins over env vars when both are set.

---

## Verifying it actually built

After step 4, before running the bench:

| Check | Expected |
|---|---|
| `ls <OPENCLAW_REPO>/recall-bench-openclaw/dist/` | Contains `index.js`, `index.d.ts`, plus one `.js`/`.d.ts` per src file |
| Date on `dist/index.js` | Newer than your most recent edit in `bench-harnesses/openclaw/src/` |
| Quick import probe | `node -e "import('<absolute path to dist/index.js>').then(m => console.log(Object.keys(m)))"` lists `createOpenClawAdapter`, `OpenClawMemoryAdapter`, `default`, etc. |

If `dist/` is missing or stale, the bench loader will throw `Cannot find module` or — worse — silently load a previous build and run the wrong code.

---

## When things go wrong

- **`pnpm install` fails with "no matching version" on `@openclaw/memory-core`.** OpenClaw hasn't been built yet. Run `pnpm install && pnpm build` at OpenClaw root first; the `dist-runtime/...` workspace targets only exist after a build.
- **`build` fails with TS path errors on `openclaw/plugin-sdk/...`.** The OpenClaw plugin-sdk hasn't been generated. Run `pnpm --filter openclaw build` at OpenClaw root (or whatever the OpenClaw playbook calls for) — this generates the `.d.ts` files the harness's type imports rely on.
- **Bench errors `Cannot find module '@openclaw/memory-core/runtime-api.js'` at runtime.** The bench is loading a stale dist that predates a dependency rename, OR the absolute path in the profile points at the wrong checkout. Re-run step 4 in the right checkout.
- **Azure content filter trips on EA corpus.** Expected on a handful of parent-care / home-incident days. The `agent-loop.ts` catches `content_filter` errors and returns a sentinel answer — the judge will score that as a failure, which is the correct measurement. Don't soften the corpus.
- **Tests pass but the bench retrieves nothing.** The 750ms sleep in `finalizeIngestion` is for the chokidar watcher to pick up newly-written day files. If you've disabled the watcher in `manager.ts`'s config, that sleep no longer applies and you'd need a `force: true` sync instead.

---

## Where the canonical references live

| Topic | File |
|---|---|
| Adapter design | `bench-harnesses/openclaw/SPEC.md` |
| Adapter public API + env vars | `bench-harnesses/openclaw/README.md` |
| Recall Bench operator playbook | `bench-program.md` (at recall repo root) |
| Recall Bench design spec | `specs/recall-bench.md` |
| OpenClaw memory backend | `<OPENCLAW_REPO>/extensions/memory-core/` |
| Profile invoking this harness | `packages/recall-bench/profiles/ea-180d-openclaw.yaml` |
