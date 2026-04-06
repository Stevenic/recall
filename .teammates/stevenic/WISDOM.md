# Steven Ickman — Wisdom

Distilled from work history. Updated during compaction.

Last compacted: 2026-04-06

---

**One `.index/` per memory root — partition by roots, not names.**
Multi-agent and multi-project isolation uses separate memory roots, each with its own `.index/` folder. No named-index abstraction needed — the filesystem boundary is the natural partition. Multiple agents = multiple roots.

**Compaction is two-phase: structural roll-up, then LLM compression.**
Phase 1 reorganizes without an LLM (cheap). Phase 2 fires only when token budgets are exceeded. This keeps costs low and works offline for basic operations.

**CliAgentModel: explicit config, not auto-detection.**
The model adapter takes a well-known name (`"claude"` | `"codex"` | `"copilot"`) or a raw command string. No magic sniffing — one string is the entire config. Resolves to the right CLI command + flags internally.

**CompletionResult must surface token counts and error details.**
`complete()` returns text, inputTokens, outputTokens, and structured error info (code, message, retryable flag, retryAfterMs). Callers need this for rate-limit handling and cost tracking.

**Language bindings are thin CLI wrappers, not reimplementations.**
Bindings (Python, Go, Rust, C#) spawn the `recall` CLI with `--json` and parse structured output. Logic lives in one place (TypeScript core); bindings only handle process spawning and error propagation.

**Reuse Vectra's abstractions where they exist.**
`FileStorage` and `EmbeddingsModel` are re-exported from Vectra. New abstractions (`MemoryIndex`, `MemoryModel`) only exist where Vectra doesn't cover the need. Use `VirtualFileStorage` for tests.

**Use Vectra 0.12.3, not 0.9.**
The 0.12.x line exports the storage abstraction (`FileStorage`, `LocalFileStorage`, `VirtualFileStorage`) that the service depends on. Earlier versions lack this.

**Typed memory extraction happens during daily-to-weekly compaction.**
The compaction prompt asks the LLM to identify entries qualifying as typed memories (decisions, feedback, project context, references) and extract them as separate `memory/type_topic.md` files with YAML frontmatter.

**All compaction thresholds are configurable with smart defaults.**
Compression ratio (30%), wisdom cap (20 entries), retention periods (30 days / 52 weeks), and minimum-log triggers are all overridable via `CompactionConfig` / `WisdomConfig`. Don't hardcode policy.

**Search uses two passes: catalog match then semantic.**
Pass 1 does cheap keyword matching on typed-memory frontmatter. Pass 2 runs vector similarity. Results merge with dedup. A recency pass injects recent weekly summaries regardless of relevance score. Multi-query fusion expands the original query into 1-3 variations.

**Four pluggable abstraction layers with sensible defaults.**
Storage (LocalFileStorage), Embeddings (transformers.js / all-MiniLM-L6-v2), Index (VectraIndex), Model (CliAgentModel). All swappable via `MemoryServiceConfig`. Model has no default — must be configured explicitly.

**Monorepo from day one — plugin model needs package boundaries early.**
Core lives in `packages/core/`. Future packages (storage-sqlite, model-openai, etc.) get their own package dirs. Workspace root manages shared config.

**Implementation follows a 5-phase plan with phases 3 & 4 parallelizable.**
Phase 1: scaffolding & interfaces. Phase 2: file management. Phase 3: index & search (parallel). Phase 4: compaction pipeline (parallel). Phase 5: MemoryService wiring & CLI completion. @beacon owns all implementation.

**Markdown chunking is heading-aware with token budgets.**
Chunker splits on headings, then by token budget (via gpt-tokenizer). Preserves frontmatter in first chunk. Returns chunks with byte offsets for partial-result reporting.

**Watch mode is opt-in for compaction, default for sync.**
`recall watch` auto-syncs the index on file changes (debounce 2s default). Compaction only triggers with `--compact` flag, protecting against unexpected LLM calls.
