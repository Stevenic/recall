# Agent Toolkit — Design Spec

**Status:** Draft
**Author:** Scribe
**Date:** 2026-05-24
**Version:** 0.1
**Parent specs:** [memory-service.md](./memory-service.md), [wiki.md](./wiki.md)

---

## 1. Overview

Recall today exposes a single retrieval-shaped public API: `service.search(query)` returns ranked chunks. Higher-level "ask the memory a question and get a clean answer" lives inside the bench harness (`bench-harnesses/recall/src/agent-loop.ts`), where a tool-calling agent loop wraps the service. That code is invisible to non-bench consumers and reimplemented by every other harness against every other memory system.

This spec promotes the agent loop into Recall as a first-class API and adds a **second**, lower-cost integration shape — a toolkit that consumers can plug into their own agent's tool surface.

The result is three public layers, one per cost tier:

1. **`service.search(query)`** — raw retrieval. Existing API. No LLM in the path.
2. **`service.toolkit()`** — tool definitions + prompt fragment + handlers. Integrator's agent owns the loop; one round-trip per memory call.
3. **`service.ask(question)`** — full agent loop. Recall owns the loop; multiple round-trips per question, clean answer + provenance returned.

### Problem

Three issues with the current shape:

1. **The "memory_get is not optional" prompt language we just iterated on lives in a bench harness file.** It's invisible IP. Anyone integrating Recall outside the bench has to re-derive it from scratch.
2. **Every harness reimplements the same loop.** The OpenClaw harness has its own `agent-loop.ts` with parallel logic. The Loki harness will too. The shape is generic; the implementations diverge.
3. **No production-friendly tool integration.** A developer building an agent on top of Recall today gets `service.search()` and is left to design their own prompt strategy, tool schema, and refusal discipline. They will get it wrong in the same ways the bench harness's first version did (snippet-too-small, refuse-without-memory_get).

### Solution

Lift the agent loop into Recall and split it into two consumption shapes:

- **Toolkit (View 1)** — Recall publishes the tool *definitions* + *prompt fragment* + *handlers*. The integrator's agent does the LLM calls. Used by developers who already have an agent SDK (OpenAI Assistants, Anthropic tool use, Vercel AI SDK, etc.) and just want to add memory tools to it.

- **Memory fetcher (View 2)** — Recall publishes a single `service.ask(question)` method that runs the loop end-to-end and returns a clean answer + retrieval trace. Used by callers without their own agent loop: bench harnesses, REPLs, batch processing, scripts.

Both views share the same underlying tool implementations and prompt language. The fetcher is a thin convenience wrapper over the toolkit + a chat model.

### Design Principles

- **One source of truth for the prompt language.** The "memory_get is not optional" discipline, the wiki-first framing, and the citation format live in one constant. Both views pull from it.
- **The toolkit is stateless data + pure handlers.** No LLM coupling. No chat client. Just the schemas, the prompt, and the dispatch functions. Safe to instantiate, pass around, embed in any agent SDK.
- **The fetcher is opt-in coupling.** Constructing a service with a `chatModel` enables `ask()`. Without one, `ask()` throws but the service still works for `search()` and `toolkit()`.
- **The bench harness is a thin caller.** Once the toolkit and fetcher are in Recall, `bench-harnesses/recall/src/agent-loop.ts` collapses to `await service.ask(question)`. Other in-house harnesses can use the same primitive against their adapted services.
- **Tool names are stable.** `memory_search`, `memory_get`, `memory_timeline` are the contract. Other memory systems implementing the same toolkit shape SHOULD use the same names so prompts written for one work against another.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Consumer (caller)                         │
├──────────────────────────────────────────────────────────────────┤
│  service.search()  │  service.toolkit()  │  service.ask()       │
│  raw retrieval      │  tools + prompt     │  loop-in-a-call      │
│  (existing)         │  (NEW — View 1)     │  (NEW — View 2)      │
├──────────────────────────────────────────────────────────────────┤
│                       MemoryService                              │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌──────────────────┐  ┌─────────────────────┐  │
│  │ Search /   │  │ Agent Toolkit    │  │ Agent Runner        │  │
│  │ Index      │  │ (tools, prompt)  │  │ (drives the loop)   │  │
│  └────────────┘  └──────────────────┘  └─────────────────────┘  │
│                            │                       │             │
│                            ↓                       ↓             │
│                  ┌──────────────────┐  ┌─────────────────────┐  │
│                  │ Tool Handlers    │  │ ChatModel           │  │
│                  │ (memory_search,  │  │ (OpenAI / Azure /   │  │
│                  │  memory_get,     │  │  Anthropic / stub)  │  │
│                  │  memory_timeline)│  │                     │  │
│                  └──────────────────┘  └─────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

| Component | Responsibility |
|-----------|---------------|
| **Agent Toolkit** | Tool schemas, prompt fragment, dispatch handlers. Pure data + functions; no LLM. |
| **Tool Handlers** | Backed by `MemoryService.search`, `MemoryFiles`, `WikiEngine`. Same code paths used by the bench harness today. |
| **Agent Runner** | The tool-calling loop. Takes a `ChatModel` + a `Toolkit` + a question; returns an answer + trace. |
| **`ChatModel`** | New abstraction: multi-turn chat-completions interface with tool support. Distinct from the existing `MemoryModel` (which is single-prompt with optional system) because tool calling needs explicit message structure. |

---

## 3. Public API

### 3.1 Toolkit (View 1)

```typescript
export interface AgentToolkit {
    /**
     * OpenAI-style function/tool definitions. Drop into the `tools` field
     * of a chat-completion request, or transform into Anthropic's tool
     * format, or use with any other SDK that accepts JSON Schema.
     */
    toolDefinitions: ToolDefinition[];

    /**
     * Prompt fragment teaching an LLM how to use the tools. Designed to
     * be pasted into the integrator's system prompt. Self-contained;
     * doesn't reference any specific framework.
     */
    promptFragment: string;

    /**
     * Dispatch a tool call against the underlying MemoryService. Returns
     * the formatted string the LLM should see as the tool response.
     * Throws on unknown tool names; tool implementations themselves
     * catch their own errors and return descriptive text.
     */
    execute(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: object;  // JSON Schema
    };
}

export interface ToolCallResult {
    /** Text the LLM sees as the tool's response. */
    text: string;
    /** Hits surfaced by this call (for caller-side retrieval tracking). */
    retrieval: Array<{ path: string; score: number; snippet: string }>;
}

// On MemoryService:
class MemoryService {
    // ... existing methods ...
    toolkit(): AgentToolkit;
}
```

Three tools, names stable across implementations:

| Tool | Purpose | Tuning state |
|------|---------|--------------|
| `memory_search` | Vector + BM25 retrieval, returns top-K chunks with snippets | Snippet budget: 1500 chars per hit (tuned 2026-05-24) |
| `memory_get` | Read a memory file by path | Full content, no truncation |
| `memory_timeline` | Vector search + chronological sort, for trajectory questions | Snippet budget: 800 chars per entry |

The prompt fragment is the post-tuning version that survived bench iteration 2 — wiki-first framing, mandatory `memory_get` discipline, citation format, no-speculation refusal language.

### 3.2 Memory Fetcher (View 2)

```typescript
export interface AskOptions {
    /** Cap on tool-loop iterations. Default 6. */
    maxIterations?: number;
    /**
     * Optional pre-fetched context injected before the question. The
     * bench harness uses this for the wiki-first pre-pass. Integrators
     * usually don't need it.
     */
    preamble?: string;
    /** Per-question chat-model overrides (temperature, max-tokens). */
    chatOptions?: { temperature?: number; maxTokens?: number };
}

export interface AskResult {
    /** Final assistant message — what a judge or user reads. */
    answer: string;
    /** Union of all chunks surfaced via tool calls. */
    retrieval: Array<{ path: string; score: number; snippet: string }>;
    /** Tool-call trace for diagnostics. */
    trace: Array<{ tool: string; args: Record<string, unknown>; resultPreview: string }>;
    /** Number of completion calls (one per turn). */
    iterations: number;
}

// On MemoryService:
class MemoryService {
    // ... existing methods ...
    ask(question: string, options?: AskOptions): Promise<AskResult>;
}
```

`ask()` requires `chatModel` in `MemoryServiceConfig`. Throws a clear error if absent (matching the current pattern for `compact()` and `dream()` requiring `model`).

### 3.3 ChatModel interface

```typescript
export interface ChatModel {
    /**
     * Run one chat completion with tool support. The runner handles the
     * loop, message accumulation, and tool dispatch; this method is a
     * single call to the underlying provider.
     */
    complete(
        messages: ChatMessage[],
        options: ChatCompleteOptions,
    ): Promise<ChatCompletionResult>;
}

export interface ChatCompleteOptions {
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
    temperature?: number;
    maxTokens?: number;
}

export interface ChatCompletionResult {
    /** Assistant text (may be empty when tool_calls are present). */
    content: string | null;
    /** Tool calls the model made. */
    toolCalls?: ChatToolCall[];
    /** Token usage for telemetry. */
    usage?: { inputTokens: number; outputTokens: number };
    /** Finish reason from the provider, normalized. */
    finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | "other";
}

export interface ChatToolCall {
    id: string;
    name: string;
    arguments: string;  // JSON-encoded; the runner parses
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    toolCalls?: ChatToolCall[];
    toolCallId?: string;  // For role: "tool"
}
```

Distinct from `MemoryModel` (single-prompt completion used for compaction, dreaming, wisdom distillation). Two adapter classes ship in `packages/core/src/defaults/`:

- `OpenAiChatModel` — wraps the `openai` SDK
- `AzureOpenAiChatModel` — wraps `AzureOpenAI` from the same package

Both extend a `BaseOpenAiChatModel` to share the message-shape normalization. Future: `AnthropicChatModel` adapter for Claude tool use.

### 3.4 Configuration

```typescript
export interface MemoryServiceConfig {
    // ... existing fields ...
    
    /** Required for compaction, dreaming, wisdom distillation. Existing. */
    model?: MemoryModel;
    
    /**
     * Required for service.ask(). Optional — service.search() and
     * service.toolkit() work without it (the toolkit's handlers don't
     * need a chat model; only the runner does).
     */
    chatModel?: ChatModel;
}
```

`MemoryService.toolkit()` is always available. `MemoryService.ask()` throws if `chatModel` is absent.

---

## 4. Migration

### 4.1 Existing code paths

| What | Where today | Where after |
|------|-------------|-------------|
| Agent loop body | `bench-harnesses/recall/src/agent-loop.ts` | `packages/core/src/agent-runner.ts` |
| Tool definitions | Same file, exported constants | `packages/core/src/agent-toolkit.ts` |
| Tool implementations | Same file (`executeMemorySearch` etc.) | `packages/core/src/agent-toolkit.ts` |
| System prompt | Same file (`AGENT_SYSTEM_PROMPT`) | `packages/core/src/agent-toolkit.ts` |
| OpenAI/Azure client wiring | `bench-harnesses/recall/src/index.ts` | `packages/core/src/defaults/openai-chat-model.ts` |
| Wiki-first pre-pass | `bench-harnesses/recall/src/index.ts` | Stays in harness — it's bench-specific. Uses `AskOptions.preamble` to inject. |

### 4.2 Bench harness reduction

`bench-harnesses/recall/src/index.ts` shrinks. The agent-mode branch becomes:

```typescript
if (answerMode === "agent") {
    // Wiki-first pre-pass (unchanged — bench-specific behavior)
    const wikiHits = await service.search(question, {
        maxResults: 3,
        wikiOnly: true,
        skipSync: true,
    });
    const preamble = wikiHits.length > 0 ? buildWikiPreamble(wikiHits) : undefined;

    // The agent loop is now a service method.
    const result = await service.ask(question, {
        maxIterations: agentMaxIterations,
        preamble,
    });
    return { answer: result.answer, retrieval: result.retrieval };
}
```

`agent-loop.ts` is deleted from the harness. Net delta: -250 lines from the harness, +400 lines added to core (mostly type definitions and the two ChatModel adapter classes).

### 4.3 OpenClaw harness alignment

OpenClaw's harness in `bench-harnesses/openclaw/src/agent-loop.ts` can keep its own loop (it backs different tools against `MemorySearchManager` rather than `MemoryService`), but the toolkit *shape* — tool names, prompt fragment shape, ChatModel interface — becomes a shared convention. A future `@recall/agent-toolkit` package could export the prompt + tool definitions independently of the memory backend, and OpenClaw could adopt those. Not required for this spec; flagged as a follow-up.

### 4.4 Documentation updates

- `docs/memory-system/architecture.html` — add a "How to integrate" section with all three layers (search, toolkit, ask) and which pattern fits which use case.
- A new `docs/memory-system/integration.html` page covering both toolkit-style and fetcher-style integration with concrete examples for OpenAI, AzureOpenAI, and Anthropic. (Anthropic example is aspirational until `AnthropicChatModel` lands.)
- README gets a short "Quick start" example using `service.ask()` since that's the simplest path.

---

## 5. Acceptance Criteria

### Toolkit
- [ ] `service.toolkit()` returns an `AgentToolkit` with three tool definitions, a prompt fragment, and an `execute` dispatch.
- [ ] `toolkit.execute("memory_search", { query: "..." })` returns the same shape and content as the current bench-harness tool handler.
- [ ] `toolkit.execute("memory_get", { path: "..." })` reads the file safely, refusing paths outside the memory root.
- [ ] `toolkit.execute("memory_timeline", { topic: "...", limit: N })` returns chronologically-ordered hits.
- [ ] Calling `execute("unknown_tool", {})` throws a clear "unknown tool" error.

### Fetcher
- [ ] `service.ask("question")` returns `{ answer, retrieval, trace, iterations }`.
- [ ] `service.ask()` throws a clear error when no `chatModel` is configured.
- [ ] Content-filter rejections produce a sentinel answer (`(refused: …)`) rather than failing the call.
- [ ] Iteration-cap hit produces a final no-tools synthesis turn so we always return SOMETHING.
- [ ] The `preamble` option injects into the initial user message.

### Configuration
- [ ] `MemoryServiceConfig.chatModel` is optional.
- [ ] `OpenAiChatModel({ apiKey, model })` works against OpenAI.
- [ ] `AzureOpenAiChatModel({ apiKey, endpoint, apiVersion, deployment })` works against Azure Foundry.
- [ ] Both adapters surface token usage on `usage`.

### Prompt parity
- [ ] The prompt fragment exported by `toolkit().promptFragment` matches the system prompt currently used in `bench-harnesses/recall/src/agent-loop.ts` (post-tuning).
- [ ] The bench harness with `service.ask()` produces equivalent results to the existing bench harness on the same questions (within noise; ±0.1 composite score across a 6-question checkpoint).

### Bench parity
- [ ] After migration, the recall bench harness uses `service.ask()` and the dist still loads via the existing profile path.
- [ ] All existing harness tests pass.
- [ ] Bench numbers for the 60d run do not regress.

---

## 6. Implementation Sequencing

### Phase A — ChatModel abstraction and adapters

1. Define `ChatModel`, `ChatMessage`, `ChatCompletionResult`, `ChatToolCall` in `packages/core/src/interfaces/chat-model.ts`.
2. Implement `BaseOpenAiChatModel` + `OpenAiChatModel` + `AzureOpenAiChatModel` in `packages/core/src/defaults/openai-chat-model.ts`. Share the message-normalization helpers.
3. Unit tests with mocked OpenAI SDK responses.

**Can ship independently. No consumer yet; lays the type foundation.**

### Phase B — Agent toolkit

1. `packages/core/src/agent-toolkit.ts` defines:
   - `AGENT_SYSTEM_PROMPT` (moved from harness)
   - `AGENT_TOOL_DEFINITIONS` (the three tool schemas)
   - `executeMemorySearch`, `executeMemoryGet`, `executeMemoryTimeline` (moved from harness; rewired to use `MemoryService` instead of harness-local `deps`)
2. `MemoryService.toolkit()` returns the `AgentToolkit` bundle.
3. Tests using a fake `MemoryService` to verify each tool's behavior.

**Depends on the memory service surface but not on Phase A. Toolkit is LLM-agnostic.**

### Phase C — Agent runner + `ask()`

1. `packages/core/src/agent-runner.ts` lifts the loop body from the harness's `runAgentLoop`. Takes `ChatModel`, `AgentToolkit`, question, options; returns `AskResult`.
2. `MemoryService.ask()` instantiates the runner with `this.toolkit()` and `this._chatModel`.
3. Tests using a stub `ChatModel` that returns pre-canned tool calls + final answer.

**Depends on A and B.**

### Phase D — Bench harness migration

1. Bench harness imports `service.ask()` instead of `runAgentLoop`.
2. Wiki-first pre-pass stays in the harness (it's a bench-specific behavior); plumbs via `preamble` option.
3. Delete `bench-harnesses/recall/src/agent-loop.ts`.
4. Re-run the existing harness tests; they should pass without modification.
5. Run a small benchmark (e.g. 18d EA) before vs after; numbers should match within noise.

**Depends on A, B, C.**

### Phase E — Documentation + integration page

1. New `docs/memory-system/integration.md` covering toolkit + fetcher patterns with code examples for OpenAI and Azure.
2. Update `docs/memory-system/architecture.md` to reference the new layers.
3. Update README "Quick start" to use `service.ask()`.
4. Cross-link from `bench-program.md` as the canonical "how harnesses talk to memory systems."

**Depends on D (or runs in parallel with D as soon as the API surface stabilizes).**

### Phase F — (Future, post-spec) extract `@recall/agent-toolkit` package

Once Phase D is stable, a follow-up extracts the toolkit shape into a standalone npm package so other memory systems (OpenClaw, Loki) can adopt it independently of `recall`. Out of scope for this spec but explicitly flagged as the natural next step.

---

## 7. Open Questions

1. **Naming `ask()`.** Alternatives: `recall()`, `query()`, `inquire()`. `recall()` matches the project name but collides with the verb in everyday code. `query()` collides with `MemoryIndex.query()`. `ask()` is the simplest and matches how callers think. **Resolved: `ask()`.**

2. **Should `toolkit()` be sync?** It returns immutable data + handlers — no I/O. Marking it sync is cleaner. **Resolved: sync.**

3. **Should the prompt fragment be parameterized?** Some callers might want to add per-deployment context (e.g. "you are a financial advisor"). Options: (a) accept a `personalize` arg with text spliced in; (b) leave it static and let integrators prepend their own context; (c) make the fragment a template literal with named slots. Probably (b) is simplest; (a) is a clean follow-up if requested.

4. **Should `ChatModel.complete()` support streaming?** Streaming is useful for production UX but not for the bench. The bench never reads partial tokens. **Resolved: non-streaming for v1; add streaming variant later if production callers ask.**

5. **What about prompt versioning?** The prompt fragment is tuned over time. Callers who paste it into their system prompt then upgrade Recall may see behavioral drift. Mitigation: include a version comment in the fragment, document changes in release notes, and possibly export the fragment as a tagged constant per major version (`PROMPT_FRAGMENT_V1`, `PROMPT_FRAGMENT_V2`, …).

6. **Should `MemoryService.config` expose `chatModel`?** Existing pattern is to keep model refs private. Probably keep `chatModel` private; expose `service.hasChatModel(): boolean` for callers that want to feature-detect.

---

## 8. Comparison: Existing Code vs This Spec

| Aspect | Today | After this spec |
|--------|-------|-----------------|
| **Where the agent loop lives** | `bench-harnesses/recall/src/agent-loop.ts` (266 lines) | `packages/core/src/agent-runner.ts` + `agent-toolkit.ts` |
| **Where the prompt language lives** | `AGENT_SYSTEM_PROMPT` constant in the harness | `agent-toolkit.ts`, exported via `toolkit().promptFragment` |
| **How a developer integrates Recall** | "Call `service.search()` and figure out the rest." | Three documented patterns. |
| **What the OpenClaw harness reimplements** | All of the same loop logic, with different tool names | The same loop logic, with the same tool names — opportunity to share via a future shared package |
| **Cost to add a new chat-model provider** | Modify the harness file | Implement `ChatModel`, ship as a default — works with `service.ask()` automatically |

---

## 9. Changelog

| Version | Date | Notes |
|---------|------|-------|
| 0.1 | 2026-05-24 | Initial draft. Three-layer architecture (search / toolkit / ask), `ChatModel` interface, two OpenAI adapters, six-phase implementation sequencing. |
