# Harness Program — Building & Running the MemPalace Adapter

This file is the operator's playbook for the MemPalace bench harness. `bench-program.md` at the recall repo root tells the agent that **before running any profile whose `harness.adapter:` points at a `bench-harnesses/<system>/` package, it must consult that package's `harness-program.md` first**. This is that file for MemPalace.

TL;DR: this harness **builds in place** (like `bench-harnesses/recall/`). MemPalace lives in a separate Python repo; we spawn its `mempalace-mcp` server as a subprocess and talk to it over MCP JSON-RPC. No source copy is required.

---

## Why this harness exists

MemPalace is a local-first, append-only memory system whose canonical surface is the **MCP server** (`mempalace-mcp`). It exposes `mempalace_add_drawer` for ingest, `mempalace_search` for retrieval, and a `mempalace_reconnect` cache-flush tool — exactly the trio the bench needs.

Because MemPalace is Python and the bench is Node, the harness doesn't import MemPalace; it spawns the MCP server as a child process and speaks newline-delimited JSON-RPC 2.0 over stdio. That keeps the Node↔Python boundary clean and exercises MemPalace through its public protocol — the same surface a real user hits via Claude Code.

---

## Prerequisites

- A local MemPalace checkout (default: `C:/source/mempalace`).
- MemPalace's venv built: `cd <mempalace>; uv sync --extra dev`.
- The `mempalace-mcp` console script resolvable. Pick one:
  1. **Absolute path** (recommended for benches): `C:/source/mempalace/.venv/Scripts/mempalace-mcp.exe` on Windows, `<mempalace>/.venv/bin/mempalace-mcp` on macOS/Linux.
  2. **`uv run`**: `["uv", "run", "--project", "<mempalace>", "mempalace-mcp"]` — slower per-spawn but doesn't require knowing the venv layout.
  3. **PATH**: `mempalace-mcp` if you've installed the venv shims.
- An OpenAI **or** Azure OpenAI deployment for query-time answer synthesis. The adapter loads `openai` lazily so the dep is only paid for when a query runs.
- The bench profile you intend to run (e.g., `packages/recall-bench/profiles/ea-180d-mempalace.yaml`).

---

## Workflow: build → point → run

### 1. Install + build the harness

From the recall repo root:

```bash
npm install                                  # picks up bench-harnesses/mempalace as a workspace
npm run build --workspace=bench-harnesses/mempalace
```

Produces `bench-harnesses/mempalace/dist/index.js`. That file is what the recall-bench CLI loads.

### 2. Run the harness's own tests (optional)

Fast sanity check that the MCP handshake + add_drawer + search round-trip works. Uses a stub synthesis model, so no OpenAI/Azure quota is spent. The tests **do** spawn `mempalace-mcp`, so they need it resolvable:

```bash
RECALL_MP_COMMAND="C:/source/mempalace/.venv/Scripts/mempalace-mcp.exe" \
  npm test --workspace=bench-harnesses/mempalace
```

If `mempalace-mcp` is on PATH already, omit `RECALL_MP_COMMAND` — the tests auto-skip when it can't be found.

The first run downloads MemPalace's `all-MiniLM-L6-v2` embedder (~79 MB) into `~/.cache/chroma/`. Cached afterwards.

### 3. Point the profile at the dist

Each profile has a `harness.adapter:` field. For MemPalace it points at the in-place dist:

```yaml
# packages/recall-bench/profiles/ea-180d-mempalace.yaml
harness:
  adapter: ../../../bench-harnesses/mempalace/dist/index.js
  factory: createMempalaceAdapter
  config:
    mempalaceCommand:
      - C:/source/mempalace/.venv/Scripts/mempalace-mcp.exe
    synthesisProvider: azure
    synthesisModel: gpt-5.4-mini
    identityName: Jordan
    identity: |
      Jordan is an AI executive assistant ...
    searchK: 10
    contextBudget: 9000
```

The path in `harness.adapter:` is resolved relative to the profile file — same convention as `ea-180d-recall-baseline.yaml`. If your MemPalace checkout is elsewhere, edit `mempalaceCommand[0]`.

### 4. Run the bench

From the recall repo, exactly as `bench-program.md` describes:

```bash
recall-bench run \
  --profile packages/recall-bench/profiles/ea-180d-mempalace.yaml \
  --json-out bench-results/drafts/mempalace-ea-180d-$(date +%Y%m%d-%H%M%S)/result.json
```

The bench CLI imports the adapter via dynamic `import()`. The adapter spawns one `mempalace-mcp` process per `setup()` call, ingests days into a fresh temp palace dir, flushes caches at each checkpoint via `mempalace_reconnect`, and tears the palace down at the end.

---

## Iteration loop

You're editing the harness source and the MemPalace server side-by-side. The cycle:

1. Edit `bench-harnesses/mempalace/src/...` in the recall repo. Or edit MemPalace itself in `C:/source/mempalace/` — the next `setup()` spawns a fresh process picking up changes.
2. `npm run build --workspace=bench-harnesses/mempalace` if you touched the TS source.
3. Re-run the bench or its tests.

The MCP process is spawned per-run, so no daemon to restart between iterations.

---

## Configuration the adapter accepts

The full set, in profile `harness.config.*` order of precedence (config wins over env):

| Field                | Env var                          | Default                         | Purpose |
|----------------------|----------------------------------|---------------------------------|---------|
| `mempalaceCommand`   | `RECALL_MP_COMMAND` (whitespace-split) | `["mempalace-mcp"]`       | argv vector spawned for the MCP server. Append `--palace` is automatic. |
| `cwd`                | `RECALL_MP_CWD`                  | inherited                       | Working directory for the spawned process. |
| `palacePath`         | `RECALL_MP_PALACE`               | fresh `tmpdir()` per `setup`    | Reuse an existing palace. Rarely useful — every run should start clean. |
| `requestTimeoutMs`   | `RECALL_MP_REQUEST_TIMEOUT_MS`   | `60000`                         | Per-MCP-call timeout. Cold first call can take ~15s on embedder load. |
| `searchK`            | `RECALL_MP_SEARCH_K`             | `10`                            | Results fetched from `mempalace_search` per query. |
| `maxDistance`        | `RECALL_MP_MAX_DISTANCE`         | `1.5`                           | Mempalace's own search-distance cap. Lower = stricter. |
| `contextBudget`      | —                                | `8000`                          | Max chars of excerpts in the synthesis prompt. |
| `wingOverride`       | —                                | `personaId`                     | Wing to file every day under. |
| `synthesisProvider`  | `RECALL_MP_SYNTHESIS_PROVIDER`   | `openai`                        | `openai` or `azure`. |
| `synthesisModel`     | `RECALL_MP_SYNTHESIS_MODEL`      | `gpt-4.1-mini`                  | Chat model id (Azure: the deployment name). |
| `openAiApiKey`       | `OPENAI_API_KEY`                 | —                               | OpenAI key for synthesis. |
| `azureEndpoint`      | `AZURE_OPENAI_ENDPOINT`          | —                               | Azure base URL for synthesis. |
| `azureApiVersion`    | `AZURE_OPENAI_API_VERSION`       | —                               | Azure API version. |
| `azureApiKey`        | `AZURE_OPENAI_API_KEY`           | —                               | Azure key for synthesis. |
| `identityName` / `identity` | —                         | —                               | Threaded into the synthesis system prompt. |

Profile config (`harness.config.*`) wins over env vars when both are set.

The MCP server also reads its own env: `MEMPALACE_PALACE_PATH`, `MEMPALACE_MCP_IDLE_HOURS`, `MEMPALACE_LOG_FILE`. Pass those via `env:` in the profile or set them in the parent shell — the adapter forwards `process.env` to the child.

---

## Wing / room mapping

The bench feeds the adapter one day at a time with metadata `{ dayNumber, date, personaId, activeArcs }`. We map that to MemPalace as:

- **Wing**: `personaId` (e.g., `executive-assistant`)
- **Room**: ISO date (e.g., `2026-01-15`)
- **Drawer content**: the verbatim day Markdown
- **`source_file` metadata**: `day-XXXX.md` for traceability in failure logs

That gives MemPalace a natural taxonomy: one wing per persona, one room per day, full days as drawers. `mempalace_search` runs without wing/room filters by default so the bench evaluates whole-palace recall — the same surface a user query hits.

If you want per-persona scoping (multi-persona benches), set `wingOverride` and the adapter will route every day there instead.

---

## Verifying it actually built

After step 1 above, before running the bench:

| Check | Expected |
|---|---|
| `ls bench-harnesses/mempalace/dist/` | Contains `index.js`, `index.d.ts`, plus `adapter`, `mcp-client`, `synthesis`, `types` siblings |
| Date on `dist/index.js` | Newer than your most recent edit in `bench-harnesses/mempalace/src/` |
| Quick import probe | `node -e "import('./bench-harnesses/mempalace/dist/index.js').then(m => console.log(Object.keys(m)))"` lists `createMempalaceAdapter`, `MempalaceAdapter`, `configFromEnv`, `default` |
| `mempalace-mcp` reachable | `<your mempalaceCommand[0]> --help` exits 0 and prints `usage: mempalace-mcp` |

---

## When things go wrong

- **`MCP request "initialize" timed out`**. The first MCP call after a fresh `mempalace-mcp` spawn can take ~15s while ChromaDB loads its ONNX embedder. Raise `requestTimeoutMs` to `120000` for cold-start runs, or pre-warm with `MEMPALACE_MCP_EAGER_EMBEDDER=1` in the adapter env block.
- **`mempalace-mcp exited (code=null signal=SIGTERM)` mid-run**. The MCP server has an idle auto-exit watchdog (default 8h). If your bench checkpoints space requests >8h apart, set `env.MEMPALACE_MCP_IDLE_HOURS=0` to disable it.
- **`mempalace_search` returns `vector_disabled: true`**. The HNSW index hit its capacity guard. Check the MCP server's stderr for the bloat-guard message; usually means the temp palace filled. Mempalace falls back to a hash-based search — results will still come back but quality drops.
- **`Filed drawer` log lines vanish**. The adapter forwards `mempalace-mcp` stderr verbatim. If you see no `Filed drawer:` lines in `progress.jsonl` neighbors, the server isn't getting your writes — check `mempalaceCommand` resolves the right binary.
- **Adapter test suite skips entirely**. The tests probe for `mempalace-mcp` on PATH or `RECALL_MP_COMMAND`. Set the env var; that's the expected pattern for CI.
- **Synthesis-side OpenAI error `model not found`**. With `synthesisProvider: azure`, `synthesisModel` is the **deployment** name, not the upstream model id. Match it to your Azure Foundry deployment.

---

## Where the canonical references live

| Topic | File |
|---|---|
| Adapter public API + env vars | `bench-harnesses/mempalace/README.md` (if present) and this file |
| Recall Bench operator playbook | `bench-program.md` (at recall repo root) |
| Recall Bench design spec | `specs/recall-bench.md` |
| MemPalace MCP server | `<mempalace>/mempalace/mcp_server.py` |
| MemPalace project README | `<mempalace>/README.md` |
| Profile invoking this harness | `packages/recall-bench/profiles/ea-180d-mempalace.yaml` |
