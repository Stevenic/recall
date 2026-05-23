# @openclaw/recall-bench-openclaw

A [recall-bench](https://github.com/Stevenic/recall) harness that runs
benchmarks against OpenClaw's built-in SQLite memory backend **in-process** —
no agent runtime, no CLI, no plugin activation.

See [`SPEC.md`](./SPEC.md) for the design.

> **Operating note.** The canonical source lives here in the `recall` repo at
> `bench-harnesses/openclaw/`, but the package **cannot be built or run from
> this repo** — it depends on `@openclaw/memory-core`, `@openclaw/openai-provider`,
> and `openclaw/plugin-sdk` workspace links that only resolve inside the
> OpenClaw monorepo. To use it, follow [`harness-program.md`](./harness-program.md):
> copy this directory into a local OpenClaw checkout, build it there, then
> point a bench profile at the resulting `dist/index.js`.

## Why this lives in OpenClaw

OpenClaw's memory backend (`MemoryIndexManager` in `extensions/memory-core/`)
is consumed via `@openclaw/memory-core/runtime-api` plus type imports from
`openclaw/plugin-sdk/memory-core-host-engine-storage`. Those paths only
resolve cleanly inside the OpenClaw monorepo where the workspace links and
TS path mappings are wired up. Running the harness from outside OpenClaw
required a shelf of workarounds (string-indirected dynamic imports, locally
re-declared types) — all of which fall away in there.

## Build & test (inside the OpenClaw checkout)

```bash
pnpm install                                # at OpenClaw root
pnpm --filter @openclaw/recall-bench-openclaw test
pnpm --filter @openclaw/recall-bench-openclaw build
```

Tests use a fake `MemorySearchManager`, so they don't require OpenClaw to be
built. The build step (`tsdown`/`tsc`) bundles the harness into a single
`dist/index.js` that recall-bench's CLI can `import()` as `--adapter <path>`.

## Usage from recall-bench

```bash
# from the recall repo, after `pnpm build` over in OpenClaw
recall-bench run \
  --adapter /path/to/openclaw/recall-bench-openclaw/dist/index.js \
  --data ./packages/recall-bench/personas \
  --judge openai
```

Default-export config is read from environment variables; named exports
(`createOpenClawAdapter`, `OpenClawMemoryAdapter`) give programmatic users
richer control.

## Environment variables

| Var                          | Default                  | Purpose                                        |
|------------------------------|--------------------------|------------------------------------------------|
| `OPENAI_API_KEY`             | —                        | Required for vector mode and synthesis         |
| `RECALL_OC_EMBED_PROVIDER`   | `auto`                   | `openai` enables vector mode; `auto` is FTS    |
| `RECALL_OC_EMBED_MODEL`      | `text-embedding-3-small` | Embedding model id (vector mode only)          |
| `RECALL_OC_SYNTHESIS_MODEL`  | `gpt-4.1-mini`           | Chat model used to synthesize prose answers    |
| `RECALL_OC_MAX_RESULTS`      | `15`                     | Max chunks fed to synthesis                    |
| `RECALL_OC_MIN_SCORE`        | `0.1`                    | Minimum chunk score                            |

## Modes

- **FTS-only (default)**: `embeddingProvider: 'auto'`. BM25 over SQLite FTS5.
  No external API calls during sync or search. Reproducible, offline-friendly.
- **Vector**: `embeddingProvider: 'openai'`. Registers
  `openAiMemoryEmbeddingProviderAdapter` from `extensions/openai/` against the
  process-global embedding registry, then runs hybrid (BM25 + vector) search.
  Requires `OPENAI_API_KEY`.

The LLM synthesis step (chunks → prose answer) is independent of OpenClaw
and uses OpenAI directly. OpenClaw itself never invokes an LLM in its
index/search path.
