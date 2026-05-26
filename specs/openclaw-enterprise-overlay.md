# OpenClaw enterprise overlay — Recall as canonical memory

For enterprise OpenClaw deployments, customers want **agent memory to live external to the OpenClaw instance**: on customer-controlled storage, indexed under their policies, retained per their retention rules, auditable, portable. OpenClaw's default memory (`memory-core`) is fine for individual users but inappropriate as the system of record for an enterprise — it stores embeddings + dream artifacts inside the OpenClaw runtime tree and is not designed for centralized ops.

The good news: **OpenClaw's memory layer is designed for replacement, not just overlay.** The architecture is plugin-based with a named slot (`plugins.slots.memory`) and a published SDK (`openclaw/plugin-sdk/memory-core-host-runtime-core`). A `memory-recall` plugin that implements the contract drops in as the active memory provider; the existing agent prompt + `active-memory` auto-injection + `memory-wiki` bridge all work against it without further configuration.

## What OpenClaw actually has

Four memory-related extensions live under `extensions/`:

| Plugin | Role | Tools owned | Default activation |
|---|---|---|---|
| `memory-core` | Default memory provider — embeddings + dreaming with light/REM/deep phases | `memory_get`, `memory_search` | onStartup: false; activates when the slot selects it |
| `memory-lancedb` | Alternative provider — LanceDB-backed vector store | `memory_recall`, `memory_store`, `memory_forget` | onCommands: `["ltm"]` |
| `memory-wiki` | Persistent wiki compiler (isolated / bridge / unsafe-local modes) | `wiki_apply`, `wiki_get`, `wiki_search`, `wiki_lint`, `wiki_status` | onStartup: true |
| `active-memory` | Per-turn blocking sub-agent that pulls memory context and injects into the prompt | (none — uses the active provider's tools) | onStartup: true |

Three architectural facts that matter:

1. **Plugins declare `kind: "memory"` + `contracts.tools: [...]` in their `openclaw.plugin.json`.** This is how the gateway discovers what a plugin provides. Custom plugins use the same mechanism.

2. **`plugins.slots.memory` is the slot selector.** It names the active memory provider. The default is `memory-core`; setting it to `memory-lancedb` swaps providers; setting it to a custom plugin id (`memory-recall`) is the documented path for "other non-core memory providers" (per `active-memory`'s `toolsAllow` UI hint).

3. **`active-memory`'s auto-injection follows the slot.** Whatever tools the active memory plugin owns become the tools `active-memory` calls per turn. No additional config needed if the plugin's tool names match (`memory_search` / `memory_get`).

The previous version of this spec assumed OpenClaw didn't have a real memory system. That was wrong. It has a sophisticated one — and the same architectural choices that make it sophisticated (clean plugin slot, contract-based tool ownership, SDK-published host APIs) make it cleanly replaceable.

## Two enterprise integration paths

### Path A — `memory-recall` extension (recommended for OpenClaw-first deployments)

Build a thin OpenClaw extension that:
- Declares `kind: "memory"` in its manifest
- Owns `memory_search` + `memory_get` (matching `memory-core`'s contract — no agent prompt or `active-memory` config changes needed)
- Optionally owns extra tools like `memory_timeline`, `wiki_get`, `wiki_search` to expose Recall's wider surface
- Dispatches every tool call into Recall's `MemoryService`, with the memory root on customer-controlled storage
- Implements the necessary host SDK callbacks for dreaming, search-config, and (when enabled) `memory-wiki` bridge artifact export

When installed, the customer sets:

```bash
openclaw config patch '{
  "plugins": {
    "slots": { "memory": "memory-recall" }
  }
}'
```

That's the entire switch. The agent's existing memory tool calls now route to Recall. `active-memory`'s sub-agent calls `memory_search` / `memory_get` — they hit Recall. `memory-wiki` in bridge mode reads from Recall's published artifacts.

### Path B — MCP server (recommended for cross-host deployments)

The MCP path we already specced (`specs/mcp-integration.md`) — `@recall/mcp` ships as a standalone MCP server, OpenClaw mounts it via `openclaw mcp set recall …`, the tools appear as `recall_*` alongside whatever OpenClaw memory plugin is active.

This is the right choice when:
- The customer also uses non-OpenClaw MCP hosts (Claude Code, Cursor, Codex) and wants one Recall install across all of them.
- The customer can't or doesn't want to install custom OpenClaw plugins (managed gateway, locked-down environments).
- The customer wants Recall tools *alongside* OpenClaw's built-in memory rather than as the replacement.

The two paths are complementary. Many enterprises will deploy both: Path A for the OpenClaw-canonical memory experience, Path B for the multi-host MCP surface.

## Path A in detail: building `memory-recall`

### Package shape

```
extensions/memory-recall/                  # new OpenClaw extension
├── openclaw.plugin.json                   # manifest (kind: "memory", contracts.tools)
├── package.json
├── api.ts                                 # public types
├── runtime-api.ts                         # host SDK contract impl
├── manager-runtime.ts                     # dreaming / sync glue
├── index.ts                               # tool handlers
└── src/
    ├── service-wiring.ts                  # MemoryService construction + lifecycle
    ├── tools/
    │   ├── memory-search.ts               # → service.search(...)
    │   ├── memory-get.ts                  # → service.files.readDaily / wiki.read / ...
    │   ├── memory-timeline.ts             # → service.search with timeline post-sort
    │   ├── (optional: wiki-* tools)
    │   └── (optional: typed-memory tools)
    └── public-artifacts.ts                # export interface memory-wiki bridge reads
```

This extension lives in **the OpenClaw repo** (or as an external package the customer installs into OpenClaw) — not inside the Recall repo. Recall itself stays a library that the extension imports.

### Manifest

```json
{
  "id": "memory-recall",
  "kind": "memory",
  "activation": { "onStartup": false },
  "contracts": {
    "tools": ["memory_search", "memory_get", "memory_timeline"]
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "memoryRoot": { "type": "string" },
      "languages": { "type": "array", "items": { "type": "string" } },
      "dreaming": { "type": "object", "additionalProperties": true },
      "wiki": { "type": "object", "additionalProperties": true }
    }
  },
  "uiHints": {
    "memoryRoot": { "label": "Memory Root", "placeholder": "/var/recall/agent-memory" }
  }
}
```

By owning `memory_search` and `memory_get`, the extension fulfills the same contract `memory-core` does — no agent prompt changes, no `active-memory.toolsAllow` reconfiguration. `memory_timeline` is a small extension that helps for synthesis-style questions; not required but useful.

### Implementation sketch

```ts
import { definePluginEntry, type OpenClawPluginToolContext }
  from "openclaw/plugin-sdk/plugin-entry";
import { MemoryService } from "recall";

let serviceSingleton: MemoryService | undefined;

async function getService(ctx: OpenClawPluginToolContext): Promise<MemoryService> {
  if (serviceSingleton) return serviceSingleton;
  const cfg = ctx.config?.plugins?.entries?.["memory-recall"]?.config ?? {};
  serviceSingleton = new MemoryService({
    memoryRoot: cfg.memoryRoot ?? "/var/recall/agent-memory",
    languages: cfg.languages,
    // Wire the LLM model from OpenClaw's runtime context if available.
    model: ctx.resolveLLM?.(),
  });
  await serviceSingleton.initialize();
  return serviceSingleton;
}

export default definePluginEntry({
  id: "memory-recall",
  tools: [
    {
      name: "memory_search",
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args, ctx) => {
        const service = await getService(ctx);
        const hits = await service.search(args.query, { maxResults: args.maxResults ?? 8 });
        return formatHits(hits);
      },
    },
    {
      name: "memory_get",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      handler: async (args, ctx) => {
        const service = await getService(ctx);
        // Route by path shape: memory/YYYY-MM-DD.md, memory/wiki/<slug>.md, etc.
        return readByPath(service, args.path);
      },
    },
    {
      name: "memory_timeline",
      schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      handler: async (args, ctx) => {
        const service = await getService(ctx);
        return await timelineQuery(service, args.topic);
      },
    },
  ],
});
```

The thin-shell pattern matches what `@recall/mcp` does — the extension is glue between OpenClaw's plugin host and Recall's `MemoryService`.

### Host-SDK callbacks (the second half)

A memory plugin is more than tool handlers. The host SDK (`openclaw/plugin-sdk/memory-core-host-runtime-core`) expects providers to implement:

| Surface | What it does | Recall mapping |
|---|---|---|
| `resolveMemorySearchConfig` | Returns the active provider's search config so `active-memory` knows how to call it | Read from `MemoryService` settings + the plugin config |
| Dreaming registration | The host invokes dreaming on a schedule or command | Call `service.dream()` — Recall's dreaming maps cleanly to OpenClaw's light/REM/deep phases |
| Public artifact export | What `memory-wiki` (in bridge mode) and the doctor commands read | Wiki page paths + dream report paths + sync status |
| Embedding provider declaration | `contracts.memoryEmbeddingProviders` in the manifest | Recall ships local + Azure adapters; declare both |

Most of these are small adapters — Recall already does the work, the extension translates between OpenClaw's API surface and Recall's. Total scope: ~500 LOC of glue, not a reimplementation.

### What the customer does

```bash
# 1. Install the extension (npm package or git clone into extensions/)
openclaw skills install memory-recall

# 2. Configure the memory root on customer-controlled storage
openclaw config patch '{
  "plugins": {
    "entries": {
      "memory-recall": {
        "enabled": true,
        "config": { "memoryRoot": "/var/recall/agent-memory" }
      }
    },
    "slots": { "memory": "memory-recall" }
  }
}'

# 3. (Optional) disable memory-lancedb if it was active
openclaw config patch '{ "plugins": { "entries": { "memory-lancedb": { "enabled": false } } } }'

# 4. (Optional) set memory-wiki to bridge mode so its tools read Recall's wiki
openclaw config patch '{
  "plugins": {
    "entries": {
      "memory-wiki": {
        "config": {
          "vaultMode": "bridge",
          "bridge": { "enabled": true, "readMemoryArtifacts": true }
        }
      }
    }
  }
}'
```

Four config commands. The agent now uses Recall as its memory backend, `active-memory` auto-injection works, `memory-wiki` can compile a navigable view, and everything persists on customer storage.

## What we no longer need to do

The previous version of this spec proposed:

- ~~Aggressive session compaction~~ — unnecessary. OpenClaw's transcript is the working buffer; it doesn't need to be the system of record because Recall is. Let session compaction stay at its default.
- ~~Workspace bootstrap files reinforcing the policy~~ — unnecessary. The agent doesn't need to be *told* to use Recall; the slot mechanism routes it there automatically.
- ~~Enterprise-variant `SKILL.md`~~ — unnecessary for Path A. The plugin replaces the underlying tools, so the standard agent prompt already routes through Recall. Path B (MCP) still wants its own SKILL.md per the MCP spec.

This is good news: the spec is simpler when you actually replace the memory layer than when you overlay around it.

## What remains as risk

- **Host-SDK stability.** `memory-host-sdk` is a published package but it's not API-frozen — OpenClaw versions could shift the contract. Pin to a known-good version, watch CHANGELOG, plan to update when OpenClaw bumps major.
- **Dreaming overlap.** OpenClaw's `memory-core` has its own dreaming (light/REM/deep). Recall's dreaming is the canonical one for a `memory-recall` plugin; the host invokes us on its schedule. Make sure the plugin's dreaming hooks don't fight with the host's dream-frequency config — disable the host's dreaming command alias when the slot selects us.
- **`memory-wiki` bridge contract.** The bridge mode expects a specific "public artifact" export shape from the active memory plugin. We need to match it for `memory-wiki`'s features to work against Recall. Worst case: customer uses Recall's own wiki view (it's already there) and doesn't use `memory-wiki` at all.
- **Embedding provider compatibility.** `memory-core` ships with the `local` provider; `memory-lancedb` adds OpenAI-compatible. Recall has its own. The plugin should declare which embedding providers it supports in `contracts.memoryEmbeddingProviders` so the gateway routes correctly.

## Open questions

- **Where does the extension live?** Inside the OpenClaw monorepo (under `extensions/`)  vs. an external repo Recall publishes (`@recall/openclaw-extension`)? Lean external — same reasoning as the MCP package being separate. Lets us iterate without OpenClaw release cycles.
- **Memory tool naming.** Use `memory_search` / `memory_get` (matches `memory-core`'s contract — zero agent reconfiguration) or `recall_search` / `recall_get` (clearer provenance but requires `active-memory.toolsAllow` config). Lean the former — slot-based replacement should be invisible to the agent.
- **Multi-tenant within one OpenClaw instance.** Same answer as the MCP spec: spawn a separate plugin instance per tenant if the host supports it, otherwise namespace inside one plugin via session-key-prefixed memory roots.
- **Dreaming model selection.** OpenClaw's `memory-core` has `dreaming.model` config; we'd need to plumb that through to Recall's dreaming. Trivial.

## Implementation phasing

### Phase 1 — `memory-recall` extension scaffold + read tools

Goal: drop-in replacement for `memory-core`'s read surface.

- Manifest, plugin entry, service singleton lifecycle
- `memory_search`, `memory_get` tools
- Configuration plumbing (`memoryRoot`, `languages`, model)
- Smoke test against a customer-style deployment (memory root on a network mount)

Effort: 2-3 days. Most of it is learning the host SDK + glue, not Recall changes.

### Phase 2 — Dreaming integration + extra tools

Goal: the plugin is a peer to `memory-core`, not a stripped-down read shim.

- Dreaming registration via host SDK callbacks
- `memory_timeline` tool (synthesis-friendly)
- Public artifact export so `memory-wiki` bridge mode works
- Embedding provider declaration

Effort: 2-3 days. Dreaming is the meat.

### Phase 3 — Path B (MCP) finalization, in parallel

Continue with the MCP server work per `specs/mcp-integration.md`. Phase A and Phase B are independent; some customers will want one or the other or both.

### Phase 4 — Documentation + customer-facing guide

- Customer-facing deployment guide (the four config commands above, framed for ops)
- Internal migration guide from `memory-core` / `memory-lancedb` to `memory-recall`
- Compatibility matrix: which OpenClaw versions, which Recall versions, which embedding providers

Effort: 1 day.

## Recommended next step

Phase 1 of Path A — the scaffolded extension with read tools. Two reasons it should come before Phase 2 (dreaming) or before any Path B work:

1. **It's the smallest deliverable that gives an enterprise customer the canonical experience.** Read tools alone unlock "Recall as the memory backend" — write tools come naturally as Phase 2 (Recall's writes flow through `service.files.writeDaily` etc., which the extension can expose).
2. **It validates the host-SDK contract early.** If the SDK doesn't actually let a third-party plugin own the memory slot the way the manifest schema implies, we want to know in week 1, not week 3 after we've also built Phase 2.

If Phase 1 lands cleanly, Phase 2 and the MCP work proceed in parallel.
