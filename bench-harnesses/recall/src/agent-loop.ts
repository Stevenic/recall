/**
 * Tool-calling agent loop. Mirrors the OpenClaw harness's agent loop so
 * Recall is measured under the same answering paradigm:
 *
 *   1. The model sees a memory-recall system prompt that mandates citation
 *      and tells it to refuse when retrieval doesn't support an answer.
 *   2. `memory_search` and `memory_get` are exposed as OpenAI tools, backed
 *      by the Recall MemoryService.
 *   3. The model decides for itself whether and how to retrieve before
 *      answering.
 *
 * This eliminates a measurement bias when Recall is compared head-to-head
 * with OpenClaw: both systems now answer through an LLM-driven retrieve →
 * read → answer loop instead of one single-shot synthesis call against
 * pre-stuffed chunks.
 */

import * as path from "node:path";
import type { MemoryService, SearchResult } from "recall";

/**
 * Detect Azure OpenAI content-filter rejections (400 with
 * code=content_filter or innererror.code=ResponsibleAIPolicyViolation).
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
 * Memory-recall system prompt. Mirrors the OpenClaw harness verbatim for
 * the citation, refusal, and grounding clauses so the bench measures
 * apples-to-apples answering quality across the two memory systems.
 */
export const AGENT_SYSTEM_PROMPT =
    "## Memory Recall\n" +
    "Before answering anything about prior work, decisions, dates, people, " +
    "preferences, or todos: run memory_search; then use memory_get to pull " +
    "specific files when you need more context than the snippet provides. " +
    "If low confidence after search, say you checked.\n" +
    "Citations: include `(Source: YYYY-MM-DD)` referencing the date of the " +
    "memory excerpt that supports the fact. Do not cite file paths.\n\n" +
    "Be concise. Extract specific facts, names, dates, and numbers verbatim " +
    "from memory when they appear. Never invent details that aren't in " +
    "memory.";

export const AGENT_TOOLS = [
    {
        type: "function" as const,
        function: {
            name: "memory_search",
            description:
                "Search the agent's long-term memory for content relevant to a query. " +
                "Returns ranked memory snippets, each tagged with its source path. " +
                "Use this before answering questions about prior work, decisions, " +
                "dates, people, preferences, or todos.",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Search query — natural language; not just keywords.",
                    },
                    limit: {
                        type: "integer",
                        description: "Max results to return. Default 8.",
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
                "Read the full content of a specific memory file by path. Use " +
                "after memory_search when you need more context than the search " +
                "snippet provides.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Path returned by memory_search (e.g. memory/2026-03-15.md " +
                            "or memory/wiki/<slug>.md).",
                    },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
    },
];

export interface AgentLoopDeps {
    /** OpenAI-compatible client (the openai SDK or AzureOpenAI). */
    openai: {
        chat: {
            completions: {
                create: (params: unknown) => Promise<unknown>;
            };
        };
    };
    /** Model id (OpenAI) or deployment name (Azure). */
    model: string;
    /** Recall MemoryService that backs memory_search / memory_get. */
    service: MemoryService;
    /** Absolute path to the memory root (used to resolve memory_get paths). */
    memoryRoot: string;
    /** Adapter's max-results setting; cap on `memory_search.limit`. */
    maxSearchResults: number;
    /** Optional cap on tool-loop iterations. Default 6. */
    maxIterations?: number;
}

export interface AgentLoopResult {
    /** The agent's final assistant message (what the judge scores). */
    answer: string;
    /**
     * Union of all chunks the agent surfaced via `memory_search`. Returned
     * so the harness's failure log can show the agent's actual search
     * trajectory, not just what a non-agent synthesis would have seen.
     */
    retrieval: Array<{ path: string; score: number; snippet: string }>;
    /** Tool-call trace for diagnostics. */
    trace: Array<{ tool: string; args: Record<string, unknown>; resultPreview: string }>;
    /** Number of completion calls (one per turn). */
    iterations: number;
}

/**
 * Drive a tool-calling chat completion until the agent stops calling tools
 * (or the iteration cap is hit). The agent's final assistant text becomes
 * the system answer.
 */
export async function runAgentLoop(
    question: string,
    deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
    const maxIterations = deps.maxIterations ?? 6;

    const messages: ChatMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: question },
    ];

    const retrieval: Array<{ path: string; score: number; snippet: string }> = [];
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
            if (isContentFilterError(err)) {
                return {
                    answer:
                        "(refused: Azure content filter triggered on this question)",
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
            return {
                answer: "(agent returned no message)",
                retrieval,
                trace,
                iterations: i + 1,
            };
        }

        messages.push({
            role: "assistant",
            content: msg.content ?? null,
            tool_calls: msg.tool_calls,
        });

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
            return {
                answer: (msg.content ?? "").trim(),
                retrieval,
                trace,
                iterations: i + 1,
            };
        }

        for (const call of msg.tool_calls) {
            const name = call.function?.name;
            let args: Record<string, unknown> = {};
            try {
                args = call.function?.arguments
                    ? JSON.parse(call.function.arguments)
                    : {};
            } catch {
                args = { _parseError: call.function?.arguments };
            }

            let resultText: string;
            try {
                if (name === "memory_search") {
                    const out = await executeMemorySearch(deps, args);
                    for (const r of out.results) retrieval.push(r);
                    resultText = out.text;
                    trace.push({
                        tool: name,
                        args,
                        resultPreview: resultText.slice(0, 200),
                    });
                } else if (name === "memory_get") {
                    resultText = await executeMemoryGet(deps, args);
                    trace.push({
                        tool: name,
                        args,
                        resultPreview: resultText.slice(0, 200),
                    });
                } else {
                    resultText = `Unknown tool: ${name}`;
                    trace.push({
                        tool: name ?? "(unknown)",
                        args,
                        resultPreview: resultText,
                    });
                }
            } catch (err) {
                resultText = `Tool error: ${
                    err instanceof Error ? err.message : String(err)
                }`;
                trace.push({
                    tool: name ?? "(unknown)",
                    args,
                    resultPreview: resultText,
                });
            }

            messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: resultText,
            });
        }
    }

    // Iteration cap hit — force a final no-tools answer so the judge has
    // something to score.
    let final: ChatCompletion;
    try {
        final = (await deps.openai.chat.completions.create({
            model: deps.model,
            messages: [
                ...messages,
                {
                    role: "user",
                    content:
                        "You've hit the tool-call cap. Provide your best final " +
                        "answer now from the information you've gathered. Do not " +
                        "invent details.",
                },
            ],
            temperature: 0,
            max_completion_tokens: 600,
        })) as ChatCompletion;
    } catch (err) {
        if (isContentFilterError(err)) {
            return {
                answer:
                    "(refused: Azure content filter triggered on this question)",
                retrieval,
                trace,
                iterations: maxIterations,
            };
        }
        throw err;
    }
    const finalText = (final.choices?.[0]?.message?.content ?? "").trim();
    return {
        answer:
            finalText ||
            "(agent did not produce an answer within the tool-call cap)",
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
): Promise<{
    text: string;
    results: Array<{ path: string; score: number; snippet: string }>;
}> {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) {
        return { text: "memory_search: missing 'query' argument.", results: [] };
    }
    const requestedLimit = typeof args.limit === "number" ? args.limit : 8;
    const limit = Math.min(
        Math.max(1, Math.floor(requestedLimit)),
        deps.maxSearchResults,
    );

    const hits: SearchResult[] = await deps.service.search(query, {
        maxResults: limit,
        skipSync: true,
    });

    if (hits.length === 0) {
        return { text: `memory_search("${query}") → no results.`, results: [] };
    }

    const results = hits.map((h) => ({
        path: h.uri,
        score: h.score,
        snippet: (h.text ?? "").slice(0, 600),
    }));
    const formatted = hits
        .map(
            (h, idx) =>
                `[${idx + 1}] ${h.uri} (score: ${h.score.toFixed(2)})\n${(h.text ?? "")
                    .trim()
                    .slice(0, 600)}`,
        )
        .join("\n\n");
    return { text: formatted, results };
}

async function executeMemoryGet(
    deps: AgentLoopDeps,
    args: Record<string, unknown>,
): Promise<string> {
    const reqPath = typeof args.path === "string" ? args.path : "";
    if (!reqPath.trim()) return "memory_get: missing 'path' argument.";

    // Path is expected to be relative to the memory root.
    const resolved = path.isAbsolute(reqPath)
        ? reqPath
        : path.join(deps.memoryRoot, reqPath);
    if (!resolved.startsWith(deps.memoryRoot)) {
        return `memory_get: path "${reqPath}" resolves outside the memory root.`;
    }

    // Route through the service's files API where possible so the same access
    // control / normalization applies. Falls back to direct fs read.
    try {
        const fs = await import("node:fs/promises");
        return await fs.readFile(resolved, "utf-8");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `memory_get: failed to read "${reqPath}": ${msg}`;
    }
}

// ---------------------------------------------------------------------------
// Minimal types — kept local so this file doesn't take a hard dependency on
// the openai SDK's exported types.
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
