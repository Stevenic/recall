# MCP server + OpenClaw skill

Recall currently exposes a memory system through a TypeScript `MemoryService` API and a bench-time agent loop. To make Recall consumable from MCP-aware clients (OpenClaw, Claude Code, Cursor, Codex), we ship an **MCP server** that translates Recall's surface into MCP tools, plus an **OpenClaw skill** package that bundles install + protocol-guidance for the host agent.

This is exactly the pattern MemPalace uses (`mempalace.mcp_server` + `integrations/openclaw/SKILL.md`). The architectural shape is portable; the contents differ because Recall's mental model is different (dailies + wiki + supersession, not wings/halls/drawers/KG).

## Goals

1. A single OpenClaw command (`openclaw mcp set recall …`) and the host agent gets the Recall tool surface.
2. The tool surface is the **right minimum** to support host-agent recall workflows — search, read, write daily logs, list/read wiki pages, status — without exposing every internal knob.
3. Process model + transport mirror what MemPalace shipped: stdio JSON-RPC, lazy memory-root resolution, defensive stdout handling.
4. Reuse Recall's existing `MemoryService` end-to-end. The MCP server is a thin shell.

Out of scope:
- HTTP/SSE transport (stdio only for v1; MCP has SSE/Streamable HTTP but the universal one is stdio).
- Multi-tenant / multi-root servers. One server, one memory root.
- Write tools that bypass compaction/dreaming bookkeeping (e.g., direct index manipulation).

## Architecture

```
┌─────────────────┐   stdio (JSON-RPC)   ┌─────────────────────────────────────┐
│                 │ ◄──────────────────► │  recall-mcp                          │
│  OpenClaw       │                       │  (Node.js process)                  │
│  Claude Code    │                       │  ──────────────────                 │
│  Cursor/Codex   │                       │   @modelcontextprotocol/sdk         │
│                 │                       │   ─► registerTool(name, …)          │
└─────────────────┘                       │                                     │
                                          │   ↓ each tool handler invokes:      │
                                          │                                     │
                                          │   MemoryService (the existing API)  │
                                          │   ──────────────────                │
                                          │   - search / multiSearch            │
                                          │   - files.readDaily / writeDaily    │
                                          │   - wiki.read / list / write        │
                                          │   - compact() / dream() / sync()    │
                                          │   - status()                        │
                                          │                                     │
                                          │   On <memory-root>/                 │
                                          └─────────────────────────────────────┘
```

The server is a Node process that:

1. Resolves the memory root (CLI arg → env var → `./memory` default).
2. Loads `.env` if present (for `AZURE_OPENAI_*` / `OPENAI_API_KEY` — required only for compaction + dreaming, not for read-only access).
3. Constructs `MemoryService` with that root.
4. Calls `service.initialize()`.
5. Registers MCP tools via the SDK, each handler being a thin call into `MemoryService`.
6. Listens on stdio until interrupted.

### Why a separate process

Some MCP clients (OpenClaw, Claude Code) prefer to manage MCP servers as subprocesses they spawn on demand. That maps cleanly to a Node.js `recall-mcp` binary. Long-running daemons are out of scope; spawn-per-session is the canonical MCP pattern.

### Why stdio

MCP's stdio transport is the lowest-common-denominator and what every MCP client supports. SSE / Streamable HTTP exist for multi-client scenarios; for a per-user agent memory the spawn-and-stdio model is the right shape.

### Why the official SDK

`@modelcontextprotocol/sdk` (npm: `@modelcontextprotocol/sdk`) handles JSON-RPC, initialize handshake, capability negotiation, ping, and transport framing. MemPalace hand-rolled all of this (~2600 LOC) — fine for Python where MCP libraries were less mature, but Node has the official SDK. Using it cuts the server to ~300 LOC of glue.

## Package layout

```
packages/
└── recall-mcp/                          # new package
    ├── package.json
    │   bin: { recall-mcp: dist/cli.js }
    ├── src/
    │   ├── cli.ts                       # arg parsing, memory-root resolution
    │   ├── server.ts                    # MCP server construction, tool registration
    │   ├── tools/
    │   │   ├── search.ts                # recall_search
    │   │   ├── get.ts                   # recall_get
    │   │   ├── timeline.ts              # recall_timeline
    │   │   ├── list-dailies.ts          # recall_list_dailies
    │   │   ├── list-wiki.ts             # recall_list_wiki
    │   │   ├── append-daily.ts          # recall_append_daily
    │   │   ├── status.ts                # recall_status
    │   │   ├── dream.ts                 # recall_dream
    │   │   ├── compact.ts               # recall_compact
    │   │   └── index.ts
    │   └── format.ts                    # tool result formatting helpers

integrations/
└── openclaw/
    └── SKILL.md                         # the OpenClaw skill bundle (see below)
```

`recall-mcp` is a new sibling to `packages/core` and `packages/recall-bench`. It depends on `recall` (the core) and the MCP SDK. Nothing else.

## Tool surface

Tools are namespaced `recall_*`. The set below is the v1 surface — small enough to learn, complete enough to operate the system from an MCP host.

### Read tools

| Tool | What it does | Signature |
|---|---|---|
| `recall_status` | One-shot overview: memory root, daily count, wiki page count, last sync, last dream | `() → { memoryRoot, indexCreated, dailies, weeklies, monthlies, wikiPages, lastDreamRun }` |
| `recall_search` | Hybrid search (semantic + BM25, two-stage reranked) across dailies + wiki | `{ query, limit?, includeWiki?, wikiOnly? } → SearchResult[]` |
| `recall_get` | Read full content of a specific memory file | `{ path: "memory/2026-01-15.md" \| "memory/wiki/<slug>.md" \| ... } → string` |
| `recall_timeline` | Same retrieval as search, returned chronologically with `[first mention]` / `[latest mention]` markers | `{ topic, limit? } → TimelineEntry[]` |
| `recall_list_dailies` | List daily files with optional date range filter | `{ after?, before? } → string[]` |
| `recall_list_wiki` | List wiki pages, optionally filtered by category | `{ category? } → WikiPageSummary[]` |
| `recall_read_wiki` | Read a wiki page by slug (convenience over `recall_get`) | `{ slug } → WikiPage` |

### Write tools

| Tool | What it does | Signature |
|---|---|---|
| `recall_append_daily` | Append content to today's daily (or a specific date), creating the file if needed | `{ content, date? } → { path, written }` |
| `recall_write_typed_memory` | Create or update a typed memory file (`type: feedback / project / reference / user`) | `{ filename, content } → { path }` |
| `recall_write_wiki` | Create or update a wiki page; pass through to `WikiEngine.write` | `{ slug, name, description, category, body, sources?, related? } → WikiPage` |
| `recall_record_supersession` | Record that a wiki page's current claim supersedes a prior one | `{ slug, source, fact?, supersededOn? } → WikiPage` |

### Maintenance tools

| Tool | What it does | Signature |
|---|---|---|
| `recall_sync` | Incremental index refresh after external file writes | `() → IndexStats` |
| `recall_compact` | Run compaction (daily → weekly → monthly → wisdom) | `() → CompactionResult` |
| `recall_dream` | Run a dreaming session | `{ dryRun?, maxCandidates? } → DreamResult` |
| `recall_reindex` | Full index rebuild (rare; useful after embedding model change) | `() → IndexStats` |

### What we deliberately omit

- **No direct file-system write tools.** All writes go through `MemoryService` so compaction / dreaming / supersession bookkeeping stays consistent. An LLM that needs to "save raw text" uses `recall_append_daily`; the system catches up the rest.
- **No direct index manipulation.** `recall_sync` / `recall_reindex` are the only routes.
- **No prompt-template tools.** The MemPalace surface exposes `mempalace_get_aaak_spec` because their compression dialect is opaque. Recall doesn't have an opaque dialect — markdown + frontmatter is the surface. Nothing to "spec out."
- **No tool exposing wisdom.** WISDOM.md is read via `recall_get` like anything else. Avoids inventing a separate path for a file that's just a file.

## MCP Resources (the wiki as first-class data)

Tools are *actions the model can take*. **Resources** are *read-only data items the host makes available with stable URIs.* The host can list them, read them, subscribe to change notifications, and — critically — pre-load them into the model's context without a tool round-trip.

For Recall this is a natural fit for the wiki layer: each wiki page is a coherent "what is true about topic X" document with a stable identity. Exposing wiki pages as resources lets MCP clients:

- **Pre-cache** them when the host attaches Recall — every wiki page can be visible to the model from turn one, without the model having to discover them via `recall_list_wiki` + `recall_read_wiki`.
- **Subscribe** to changes, so when dreaming refreshes a page the host gets a notification and can re-load.
- **Cite** them with a stable URI the host can render back to the user (clickable in Claude Code's UI, for example).

### Resource surface

| URI scheme | What | Mime type |
|---|---|---|
| `recall://wiki/<slug>` | A wiki page's full markdown (frontmatter + body) | `text/markdown` |
| `recall://wiki/<target>/<slug>` | Same, for shared-wiki targets when configured | `text/markdown` |
| `recall://identity` | IDENTITY.md | `text/markdown` |
| `recall://wisdom` | WISDOM.md | `text/markdown` |
| `recall://daily/<YYYY-MM-DD>` | A specific daily log (read-only window into history) | `text/markdown` |

Wiki pages and the two singletons (`identity`, `wisdom`) are the high-leverage ones. Dailies as resources are debatable — high cardinality (180+ entries for the EA corpus, thousands over a long-lived deployment), and the host typically doesn't want to pre-cache hundreds of dailies. Two options:

1. **Don't expose dailies as resources at all.** They're addressable via `recall_get memory/YYYY-MM-DD.md`; that's enough.
2. **Expose only "recent dailies"** as resources — e.g., the last N days — so a host can attach the recent-context window to every turn.

Lean (2) with a configurable window (`--recent-daily-window 14`, default 7). Wiki pages and singletons always exposed; dailies bounded.

### How resources differ from `recall_get`

A client *can* read every wiki page with `recall_get`. What resources add:

| Aspect | Tools (`recall_get`) | Resources |
|---|---|---|
| Discovery | Client calls `recall_list_wiki` first, then `recall_get` per page | Client lists `resources/list` once; sees every wiki page with URI + description |
| Pre-load | The model has to decide to fetch | The host can attach the resource to every turn automatically |
| Change notification | Polling only | Server emits `notifications/resources/updated` on change |
| URI stability | Path is the URI | `recall://wiki/<slug>` is stable across path-layout changes |
| Display in client UI | Just text | Clients can render as a sidebar / panel / citation chip |

The two surfaces coexist. Resources are the discoverable, pre-cacheable, citable surface; tools are how the model navigates beyond what's pre-loaded.

### Resource implementation (sketch)

The MCP SDK exposes a `Resource` registration alongside tool registration. The server:

1. On `resources/list`: enumerate via `service.wiki.list()` + the two singletons + the recent-daily window. Each entry returns `{ uri, name, description, mimeType }`. Wiki page descriptions come from the page's `description:` frontmatter; the singletons get static descriptions.

2. On `resources/read`: parse the URI, route to `service.wiki.read(slug)` / `service.files.readWisdom()` / `service.files.readDaily(date)`. Return the full markdown.

3. On `resources/subscribe`: track which URIs the client subscribed to. After every successful `recall_dream` (or any `WikiEngine.write` / `append`), check if any subscribed URI is in the changed set and emit `notifications/resources/updated`.

Subscriptions are session-scoped. When the MCP connection drops, the subscription list clears.

### Subscription firing

The cleanest place to wire change-notifications: a small event emitter on `WikiEngine` (already plausible — it owns all wiki writes). The MCP server subscribes to that emitter and translates page-changed events into MCP notifications.

```ts
this._wiki.on('pageChanged', (slug: string, target: string) => {
    const uri = target === 'private' ? `recall://wiki/${slug}` : `recall://wiki/${target}/${slug}`;
    if (subscriptions.has(uri)) emitResourceUpdated(uri);
});
```

The `WikiEngine.on()` hook is a new addition. Tiny — a Node `EventEmitter` field + emit calls inside `write` / `append` / `recordSupersession`. Worth landing whether or not MCP needs it, since it cleanly decouples notification consumers from the engine.

## SKILL.md (OpenClaw)

The OpenClaw skill is a markdown file with frontmatter that bundles install metadata, tool descriptions, and a behavioral protocol. Modeled directly on `C:/source/mempalace/integrations/openclaw/SKILL.md`.

```yaml
---
name: recall
description: "Recall — agent memory with wiki layer, supersession tracking, and temporal-aware retrieval. Local, no cloud required for read-only use; AZURE_OPENAI_* needed only for compaction + dreaming."
version: <package version>
homepage: https://github.com/Stevenic/recall
user-invocable: true
metadata:
  openclaw:
    emoji: "📚"
    os: [darwin, linux, win32]
    requires:
      anyBins: [recall-mcp, node]
    install:
      - id: recall-npm
        kind: npm
        label: "Install Recall MCP server"
        package: "@recall/mcp"
        bins: [recall-mcp]
---

# Recall — Agent Memory with Wiki Layer

You have access to a Recall memory system via MCP tools. Recall stores:
- **Daily logs** (`memory/YYYY-MM-DD.md`) — immutable history of what was said
  or decided on a specific day. The ground truth.
- **Wiki pages** (`memory/wiki/<slug>.md`) — current state of record per topic.
  Synthesized by dreaming. Carry `supersedes:` records when claims change.
- **Weekly / monthly summaries** — compacted views over date ranges.
- **WISDOM.md** — durable principles distilled across compactions.

## Protocol — FOLLOW THIS EVERY SESSION

1. **ON WAKE-UP**: call `recall_status` to confirm the memory root, daily
   count, and last dream date.
2. **BEFORE RESPONDING** about prior work, decisions, dates, people, or
   preferences: call `recall_search` (or `recall_timeline` for
   trajectory questions). Never guess — verify from memory.
3. **WIKI vs DAILY**: wiki pages summarize across many dailies and may
   lag the latest revision. For specific values, dates, names, or
   quotes, call `recall_get` on a cited daily to verify before
   answering. The daily wins when it disagrees with the wiki.
4. **DATE-PINNED QUESTIONS**: if the user asks "on YYYY-MM-DD …" or
   "as of …", `recall_get memory/YYYY-MM-DD.md` directly — that's the
   ground truth for that date.
5. **AFTER EACH SESSION** where the user shared new context: call
   `recall_append_daily` with a brief record of what happened, what
   the user said, and what matters going forward.
6. **WHEN A FACT CHANGES**: if you discover a claim that contradicts
   what a wiki page currently says, mention it to the user. The next
   `recall_dream` pass will pick up the revision and supersede the
   stale claim. Don't try to edit the wiki body directly unless you're
   sure.

## Available Tools

(generated from the tool surface table above — full descriptions + parameters)

## Setup

```bash
npm install -g @recall/mcp
recall-mcp --memory-root ~/my-memory   # first-time, populates an empty memory
```

### OpenClaw MCP config

```bash
openclaw mcp set recall '{"command":"recall-mcp","args":["--memory-root","~/my-memory"]}'
```

### Other MCP hosts

```bash
# Claude Code
claude mcp add recall -- recall-mcp --memory-root ~/my-memory

# Cursor — .cursor/mcp.json
# Codex — .codex/mcp.json
```

## License

[Recall](https://github.com/Stevenic/recall) is MIT licensed.
```

## Tool result formatting

MCP tools return `text` content blocks. Two formatting choices that matter:

1. **Search results** — return as a single text block with a fenced summary at the top + the snippet body, NOT as JSON. The host LLM reads the result text directly; JSON adds overhead the LLM has to parse mentally. (Matches how the bench-time agent already consumes search results.)

2. **Status / list-* tools** — return as JSON because the LLM benefits from structured data when planning multi-step work ("you have N wikis, here's the list, pick one to read").

Concrete: `recall_search` returns the same `[1] 2026-01-14 [LATEST] · memory/...md (score: X.XX)\n<snippet>` shape the agent already consumes; `recall_status` returns a JSON object.

## Lifecycle considerations

### Memory-root resolution

Priority order:
1. `--memory-root <path>` CLI arg
2. `RECALL_MEMORY_ROOT` env var
3. `./memory` relative to the current working dir
4. If none exist: create `~/recall-memory` and warn on stderr (one-time init).

A subprocess MCP server spawned by an MCP host typically doesn't see the user's shell env automatically. The CLI arg is the most reliable channel; document it in the SKILL.md.

### Read-only vs read-write mode

Compaction + dreaming require an LLM (`AZURE_OPENAI_*` / `OPENAI_API_KEY`). If those env vars aren't present, the server starts in **read-only mode**:
- All read + list tools work.
- `recall_append_daily`, `recall_write_*` work (these don't need an LLM).
- `recall_compact`, `recall_dream` return an error telling the user what env vars are missing.

Don't crash on startup when LLM env is missing — the read-only case is the common one for many users.

### Reconnect / refresh

MemPalace ships `mempalace_reconnect` because its ChromaDB backend caches embeddings and external writes go stale. Recall's Vectra index is file-based; `recall_sync` does the same job. No separate "reconnect" tool needed.

### Defensive stdout

MCP-over-stdio multiplexes JSON-RPC on stdout. Any rogue `console.log` from a dependency corrupts the stream. The server must:
- Redirect stdout to stderr at startup before importing core/Vectra/transformers.js.
- Restore real stdout only for the JSON-RPC writer.

Mirrors what MemPalace does at the Python level. In Node this looks like:

```ts
const realStdout = process.stdout;
const writeToStderr = (chunk: any) => process.stderr.write(chunk);
process.stdout.write = writeToStderr as any;
// … then in the JSON-RPC writer, write to `realStdout` directly.
```

The MCP SDK handles framing; the wrapping is just to prevent dependency-emitted noise.

## Tool naming

Two reasonable conventions:

1. `recall_search` / `recall_get` / `recall_timeline` (snake_case, matches MemPalace's namespace pattern, matches the existing agent-loop tool names sans the `recall_` prefix).
2. `search` / `get` / `timeline` (unprefixed — tighter, relies on the MCP client to namespace by server name).

MemPalace went with **prefixed** because OpenClaw merges tool surfaces from all configured MCP servers and unprefixed names collide. **Use the prefix.**

## Phasing

### Phase 1 — Server + read-only tools + wiki-as-resources

Goal: an LLM can ask Recall what it knows AND has the wiki pre-loaded as resources.

- `packages/recall-mcp/` package skeleton (separate npm package, `@recall/mcp`)
- `@modelcontextprotocol/sdk` integration + memory-root resolution + stdio defensive plumbing
- Read tools: `status`, `search`, `get`, `timeline`, `list_dailies`
- **Resources**: every wiki page exposed at `recall://wiki/<slug>`; `recall://identity`; `recall://wisdom`; recent-N dailies at `recall://daily/<YYYY-MM-DD>`
- `WikiEngine.on('pageChanged', …)` event emission for resource subscription support
- Basic OpenClaw SKILL.md

Effort: ~2 days. Read-only + resources together — resources are most of the leverage and they reuse the same MemoryService read paths, so doing them in the same pass is cheaper than splitting.

### Phase 2 — Write tools

Goal: an LLM can grow the memory.

- `recall_append_daily` — the most common write, gets the headline mention in SKILL.md
- `recall_write_typed_memory`, `recall_write_wiki`, `recall_record_supersession`
- `recall_write_wiki` ships with explicit guidance in SKILL.md: *"Prefer `recall_append_daily` and let dreaming synthesize. Use `recall_write_wiki` only when you're sure — direct wiki edits can be overwritten by the next dream pass."*
- Conflict-detection: warn (don't fail) if appending to a daily that's been compacted

Effort: ~1 day.

### Phase 3 — Maintenance + automation

Goal: an MCP host can run the maintenance cycle without invoking the CLI.

- `recall_sync`, `recall_compact`, `recall_dream`, `recall_reindex`
- Read-only mode detection for env-less starts
- `recall_status` reports whether the LLM env is configured

Effort: ~0.5 day. Mostly handler wiring.

### Phase 4 — Skill polish + other host integrations

Goal: shippable docs + multi-host coverage.

- Detailed SKILL.md with examples
- Claude Code / Cursor / Codex `.mcp.json` snippets
- npm publish setup for `@recall/mcp`
- E2E smoke test: spawn `recall-mcp`, run a search via an MCP test client, verify output shape; assert that `resources/list` returns expected wiki pages; verify `resources/updated` fires after a wiki write

Effort: ~1 day.

## Open questions

- **npm package name.** `@recall/mcp` reads cleanly. Alternative `recall-mcp` (unscoped) if we want a shorter install command. Lean scoped.
- ~~**Bundle vs separate package.**~~ **Decided: separate package** (`@recall/mcp`). Independent versioning, smaller install footprint for users who only want the core library.
- ~~**Wiki write surface.**~~ **Decided: ship `recall_write_wiki`** with a "best practice: prefer `recall_append_daily` and let dreaming synthesize" note in the SKILL.md. Restricting writes was more annoying than the rare bad-write.
- ~~**MCP resource support.**~~ **Decided: in scope for v1.** Wiki pages exposed as resources; design above.
- **Daily resources scope.** Expose recent-N dailies as resources (configurable window, default 7) or no dailies as resources at all? Lean recent-window. The pre-cache value of "last week's context attached to every turn" is high; the cost of pre-caching all 180+ dailies isn't.
- **Multi-agent collaboration.** Two MCP hosts with the same memory root will race on writes if both run dreaming. The per-slug locking we have for in-process concurrency doesn't extend to cross-process. Out of scope for v1; document the limitation.

## Non-trivial risks

- **Stdout corruption from dependencies.** Transformers.js and Vectra both emit progress logs to stdout on first model load. The MCP framing breaks immediately. The defensive stdout-redirect at startup is non-optional.
- **Cold start.** First call after server start triggers the embedding model download (~22MB English, ~278MB multilingual if we ship the localization spec's new default). Document the first-call latency; consider a `--warm` flag that preloads the model at startup.
- **Memory-root creation.** Auto-creating `~/recall-memory` on first run is convenient but surprising. Lean toward refusing to start without an explicit `--memory-root` and erroring with a clear message.
- **LLM env discovery.** A `recall-mcp` subprocess spawned by Claude Code won't inherit the user's shell environment. `.env` discovery via `<memory-root>/.env` is the most reliable path. Document it.

## Recommended next step

Phase 1 in ~2 days. Four pieces:

1. `packages/recall-mcp/` skeleton (separate `@recall/mcp` package, `@modelcontextprotocol/sdk` wired in)
2. Five read tools: `status`, `search`, `get`, `timeline`, `list_dailies`
3. **Resources**: wiki pages + `identity` + `wisdom` + recent dailies, with subscription support backed by a new `WikiEngine.on('pageChanged')` event
4. `integrations/openclaw/SKILL.md` (Phase 1 version — read-only protocol + the resource-aware framing)

Phase 1 delivers something complete enough to install in OpenClaw and use: the model has every wiki page pre-loaded as context (via resources) AND can search/read/timeline-traverse beyond that (via tools). Write tools and maintenance follow in subsequent phases, each independently shippable.
