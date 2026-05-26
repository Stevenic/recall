/**
 * Tool-calling agent loop. Replaces the single-shot synthesis pass with a
 * mini agent that:
 *
 *   1. Sees OpenClaw's recommended memory-recall system prompt verbatim
 *      (the same one OpenClaw injects when memory tools are available)
 *   2. Has `memory_search` and `memory_get` exposed as OpenAI tools backed by
 *      our adapter's manager/workspace
 *   3. Decides for itself whether and how to retrieve before answering
 *
 * This is a closer simulation of how OpenClaw's actual agents use memory: the
 * LLM owns the query/retrieve/read/answer loop. The bench still measures the
 * *system* (memory backend + the agent's use of it) end-to-end, but no longer
 * conflates "the LLM didn't extract a fact from a pre-stuffed chunk dump" with
 * "the memory system can't find it."
 */

import type { MemorySearchManager, MemorySearchResult } from "@openclaw/memory-core/runtime-api.js";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

/**
 * Detect Azure OpenAI content-filter rejections (400 with code=content_filter
 * or innererror.code=ResponsibleAIPolicyViolation). The openai SDK throws
 * these as BadRequestError instances with a structured `error` payload.
 */
function isContentFilterError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: string;
    error?: { code?: string; innererror?: { code?: string } };
  };
  if (e.code === "content_filter") return true;
  if (e.status === 400 && e.error?.code === "content_filter") return true;
  if (e.error?.innererror?.code === "ResponsibleAIPolicyViolation") return true;
  return false;
}

/**
 * OpenClaw's recommended memory-recall prompt, mirrored from
 * `extensions/memory-core/src/prompt-section.ts`. Kept verbatim here so the
 * bench measures OpenClaw's intended behavior, not our paraphrase.
 */
export const AGENT_SYSTEM_PROMPT =
  "## Memory Recall\n" +
  "Before answering anything about prior work, decisions, dates, people, " +
  "preferences, or todos: run memory_search on MEMORY.md + memory/*.md + " +
  "indexed session transcripts; then use memory_get to pull only the needed " +
  "lines. If low confidence after search, say you checked.\n" +
  "Citations: include `(Source: YYYY-MM-DD)` referencing the date of the " +
  "memory excerpt that supports the fact. Do not cite file paths.\n\n" +
  "Be concise. Extract specific facts, names, dates, and numbers verbatim " +
  "from memory when they appear. Never invent details that aren't in memory.";

/** OpenAI tool definitions for the agent. Mirrors OpenClaw production
 * `MemorySearchSchema` / `MemoryGetSchema` in
 * `extensions/memory-core/src/index.ts` so the bench measures OpenClaw's
 * intended tool surface, not a paraphrase. */
export const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "memory_search",
      description:
        "Search the agent's long-term memory for content relevant to a query. " +
        "Returns ranked memory snippets, each tagged with its source path. " +
        "Use this before answering questions about prior work, decisions, " +
        "dates, people, preferences, or todos. Optional `corpus` filter " +
        "restricts the source set (`memory` = daily logs, `wiki` = registered " +
        "compiled-wiki supplements, `all` = both, `sessions` = session transcripts).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — natural language; not just keywords.",
          },
          limit: {
            type: "integer",
            description:
              "Max results to return. Default 8. Capped at the harness's " +
              "configured maxSearchResults.",
          },
          maxResults: {
            type: "integer",
            description:
              "Alias for `limit` — OpenClaw's production schema names this " +
              "field. When both are supplied, `limit` wins.",
          },
          minScore: {
            type: "number",
            description:
              "Minimum similarity score for returned hits, in [0, 1]. " +
              "Defaults to the harness's configured minScore.",
          },
          corpus: {
            type: "string",
            enum: ["memory", "wiki", "all", "sessions"],
            description:
              "Source filter. `memory` (default) = MEMORY.md + memory/*.md. " +
              "`wiki` = registered compiled-wiki supplements. `all` = both. " +
              "`sessions` = session transcripts (when indexed).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_get",
      description:
        "Read a specific memory file by path. Use after memory_search when " +
        "you need more context than the search snippet provides. Supports " +
        "ranged reads via `from` + `lines` to fetch a window without pulling " +
        "the whole file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path returned by memory_search (e.g. memory/2026-03-15.md).",
          },
          from: {
            type: "integer",
            description:
              "Optional starting line (1-based). When omitted, reads from " +
              "the beginning of the file.",
          },
          lines: {
            type: "integer",
            description:
              "Optional number of lines to return starting from `from`. " +
              "When omitted, reads to end of file.",
          },
          corpus: {
            type: "string",
            enum: ["memory", "wiki", "all"],
            description:
              "Optional source hint. Path already encodes the corpus; " +
              "accepted for parity with the production schema.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

export interface AgentLoopDeps {
  /** OpenAI-compatible client (the same `openai` SDK instance the adapter already uses). */
  openai: {
    chat: {
      completions: {
        create: (params: unknown) => Promise<unknown>;
      };
    };
  };
  /** Model id for the agent's chat completions (e.g., 'gpt-5.4-mini'). */
  model: string;
  /** OpenClaw memory manager — backs `memory_search` and `memory_get`. */
  manager: MemorySearchManager;
  /** Absolute path to the workspace's memory dir, used to resolve `memory_get` paths. */
  workspaceDir: string;
  /** Adapter's max-results setting; applied as a ceiling on `memory_search.limit`. */
  maxSearchResults: number;
  /** Adapter's min-score setting; applied to `memory_search` calls. */
  minScore: number;
  /** Optional cap on tool-loop iterations to prevent runaway. Default 6. */
  maxIterations?: number;
}

export interface AgentLoopResult {
  /** The agent's final assistant message (what the judge scores). */
  answer: string;
  /**
   * Union of all chunks the agent surfaced via `memory_search`. Returned so
   * the harness's failure log can show the agent's actual search trajectory,
   * not just the chunks a non-agent synthesis would have seen.
   */
  retrieval: Array<{
    path: string;
    score: number;
    snippet: string;
    startLine?: number;
    endLine?: number;
    citation?: string;
  }>;
  /** Tool-call trace for diagnostics. */
  trace: Array<{ tool: string; args: Record<string, unknown>; resultPreview: string }>;
  /** Number of completion calls (one per turn). */
  iterations: number;
}

/**
 * Drive a tool-calling chat completion until the agent stops calling tools
 * (or we hit the iteration cap). The agent's final assistant text becomes
 * the system answer.
 */
export async function runAgentLoop(
  question: string,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  const maxIterations = deps.maxIterations ?? 6;

  // Conversation history. We seed with the OpenClaw-aligned system prompt and
  // the user's question, then let the model drive tool calls.
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const retrieval: AgentLoopResult["retrieval"] = [];
  const trace: AgentLoopResult["trace"] = [];

  for (let i = 0; i < maxIterations; i++) {
    let response: ChatCompletion;
    try {
      response = (await deps.openai.chat.completions.create({
        model: deps.model,
        messages,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
        temperature: 0,
        max_completion_tokens: 800,
      })) as ChatCompletion;
    } catch (err) {
      // Azure RAI may flag corpus content (parent-care, home incidents, etc.).
      // Treat content_filter as a model refusal — return a sentinel the judge
      // can score appropriately, instead of crashing the run.
      if (isContentFilterError(err)) {
        return {
          answer: "(refused: Azure content filter triggered on this question)",
          retrieval,
          trace,
          iterations: i + 1,
        };
      }
      throw err;
    }

    const choice = response.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      return { answer: "(agent returned no message)", retrieval, trace, iterations: i + 1 };
    }

    // Push the assistant turn into history (with any tool_calls preserved so
    // the next turn's tool messages are valid).
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    // No tool calls → assistant produced the final answer.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        answer: (msg.content ?? "").trim(),
        retrieval,
        trace,
        iterations: i + 1,
      };
    }

    // Execute each tool call and append a `tool` message per call.
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = { _parseError: call.function?.arguments };
      }

      let resultText: string;
      try {
        if (name === "memory_search") {
          const out = await executeMemorySearch(deps, args);
          for (const r of out.results) retrieval.push(r);
          resultText = out.text;
          trace.push({ tool: name, args, resultPreview: resultText.slice(0, 200) });
        } else if (name === "memory_get") {
          const out = await executeMemoryGet(deps, args);
          resultText = out;
          trace.push({ tool: name, args, resultPreview: resultText.slice(0, 200) });
        } else {
          resultText = `Unknown tool: ${name}`;
          trace.push({ tool: name ?? "(unknown)", args, resultPreview: resultText });
        }
      } catch (err) {
        resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        trace.push({ tool: name ?? "(unknown)", args, resultPreview: resultText });
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultText,
      });
    }
  }

  // Hit iteration cap without a clean answer — emit a final synthesis call
  // forcing no tools, so we always return SOMETHING the judge can score.
  let final: ChatCompletion;
  try {
    final = (await deps.openai.chat.completions.create({
      model: deps.model,
      messages: [
        ...messages,
        {
          role: "user",
          content:
            "You've hit the tool-call cap. Provide your best final answer now " +
            "from the information you've gathered. Do not invent details.",
        },
      ],
      temperature: 0,
      max_completion_tokens: 600,
    })) as ChatCompletion;
  } catch (err) {
    if (isContentFilterError(err)) {
      return {
        answer: "(refused: Azure content filter triggered on this question)",
        retrieval,
        trace,
        iterations: maxIterations,
      };
    }
    throw err;
  }
  const finalText = (final.choices?.[0]?.message?.content ?? "").trim();
  return {
    answer: finalText || "(agent did not produce an answer within the tool-call cap)",
    retrieval,
    trace,
    iterations: maxIterations,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function executeMemorySearch(
  deps: AgentLoopDeps,
  args: Record<string, unknown>,
): Promise<{ text: string; results: AgentLoopResult["retrieval"] }> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query.trim()) return { text: "memory_search: missing 'query' argument.", results: [] };
  // `limit` is the historical bench field; `maxResults` is the OpenClaw
  // production schema field. When both are present, `limit` wins.
  const rawLimit =
    typeof args.limit === "number"
      ? args.limit
      : typeof args.maxResults === "number"
        ? args.maxResults
        : 8;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), deps.maxSearchResults);
  const minScore =
    typeof args.minScore === "number" && Number.isFinite(args.minScore)
      ? Math.max(0, Math.min(1, args.minScore))
      : deps.minScore;

  // Map the production-schema `corpus` field to the manager's `sources`
  // filter. `sessions` is accepted but treated as `memory` since the
  // bench harness doesn't index session transcripts.
  const corpus = typeof args.corpus === "string" ? args.corpus : "memory";
  let sources: Array<"memory" | "wiki" | "sessions">;
  switch (corpus) {
    case "wiki":
      sources = ["wiki"];
      break;
    case "all":
      sources = ["memory", "wiki"];
      break;
    case "sessions":
    case "memory":
    default:
      sources = ["memory"];
      break;
  }

  const hits = await deps.manager.search(query, {
    maxResults: limit,
    minScore,
    sources,
  });

  if (hits.length === 0) {
    return { text: `memory_search("${query}") → no results.`, results: [] };
  }

  // Production OpenClaw search results carry startLine/endLine and a
  // citation (`<path>#<line>`) for every chunk hit. Surface them in the
  // formatted output so the agent has the same line-range affordance
  // production has — pull only the needed lines with memory_get, cite
  // with `Source: <path>#<line>`. The retrieval array also gains the
  // line info so the bench's failure log records where each hit landed.
  const results = hits.map((h: MemorySearchResult) => ({
    path: h.path,
    score: h.score,
    snippet: h.snippet,
    startLine: h.startLine,
    endLine: h.endLine,
    citation: h.citation,
  }));
  const formatted = hits
    .map((h: MemorySearchResult, idx) => {
      const range =
        Number.isFinite(h.startLine) && Number.isFinite(h.endLine)
          ? `[${h.startLine}..${h.endLine}]`
          : "";
      const cite = h.citation ? ` · cite=${h.citation}` : "";
      return (
        `[${idx + 1}] ${h.path}${range} (score: ${h.score.toFixed(2)})${cite}\n` +
        h.snippet.trim()
      );
    })
    .join("\n\n");
  return { text: formatted, results };
}

async function executeMemoryGet(
  deps: AgentLoopDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const reqPath = typeof args.path === "string" ? args.path : "";
  if (!reqPath.trim()) return "memory_get: missing 'path' argument.";
  const fromArg =
    typeof args.from === "number" && Number.isFinite(args.from)
      ? Math.max(1, Math.floor(args.from))
      : null;
  const linesArg =
    typeof args.lines === "number" && Number.isFinite(args.lines)
      ? Math.max(1, Math.floor(args.lines))
      : null;

  // Path is expected to be relative to the workspace (e.g. memory/2026-01-15.md).
  const resolved = isAbsolute(reqPath) ? reqPath : join(deps.workspaceDir, reqPath);
  // Refuse path traversal that escapes the workspace.
  if (!resolved.startsWith(deps.workspaceDir)) {
    return `memory_get: path "${reqPath}" resolves outside the workspace.`;
  }

  let content: string;
  try {
    content = await readFile(resolved, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `memory_get: failed to read "${reqPath}": ${msg}`;
  }

  if (fromArg == null && linesArg == null) {
    return content;
  }

  const allLines = content.split("\n");
  const start = (fromArg ?? 1) - 1;
  if (start < 0 || start >= allLines.length) {
    return (
      `memory_get: requested 'from=${fromArg ?? 1}' is past end of ` +
      `"${reqPath}" (file has ${allLines.length} lines).`
    );
  }
  const end = linesArg == null ? allLines.length : Math.min(start + linesArg, allLines.length);
  const window = allLines.slice(start, end).join("\n");
  const truncatedAhead = end < allLines.length;
  const header =
    `(memory_get range from=${start + 1}, lines=${end - start}` +
    (truncatedAhead ? `, more=${allLines.length - end} lines remain past line ${end}` : "") +
    `)\n`;
  return header + window;
}

// ---------------------------------------------------------------------------
// Minimal types — kept local so this file doesn't take a hard dependency on
// the openai SDK's exported types (which the adapter already imports lazily).
// ---------------------------------------------------------------------------

interface ChatToolCall {
  id: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }>;
}
