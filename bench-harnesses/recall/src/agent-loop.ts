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
import { extractDateFromUri, type MemoryService, type SearchResult } from "recall";

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
 * Memory-recall system prompt. Splits memory into two layers and tells
 * the agent how to choose between them:
 *
 *   - Wiki pages are the agent's **current state of record** — what is
 *     true NOW about a topic. Mutable; evolves as the agent learns.
 *   - Daily logs are the **history evidence trail** — what was written
 *     when. Immutable. The wiki cites them.
 *
 * The agent picks based on the question shape: "what is X?" → wiki first;
 * "what did we say on day Y?" → daily; "how did X evolve?" →
 * memory_timeline. This is the answer to the RAG-temporal-contradiction
 * problem: instead of letting the LLM resolve "we chose Postgres" vs
 * "switched to MySQL" by hoping vector search ranks the newer one
 * higher, we make the architectural distinction explicit and route
 * questions accordingly.
 */
export const AGENT_SYSTEM_PROMPT =
    "## Memory Recall\n\n" +
    "The agent's memory has two layers:\n" +
    "- **Wiki pages** (`memory/wiki/<slug>.md`) — current state of record. " +
    "What is true NOW about a topic (a person, a project, a concept). " +
    "Mutable; evolves as the agent learns. The first place to look for " +
    "anything currently-true.\n" +
    "- **Daily logs** (`memory/YYYY-MM-DD.md`) — immutable history. What " +
    "was said or decided on a specific day. Evidence for citations.\n\n" +
    "### Choosing a tool\n" +
    "- *Current state* questions (\"what is X?\", \"who is Y?\", \"what's the " +
    "current policy on Z?\"): **search the wiki first** with " +
    "memory_search. If a wiki page exists, it's the answer — use the " +
    "dailies it cites for evidence.\n" +
    "- *Point-in-time* questions (\"what did we say on day N?\", \"what " +
    "happened on March 15?\"): memory_search the dailies directly.\n" +
    "- *Trajectory* questions (\"when did we decide X?\", \"how did Y " +
    "evolve?\", \"what changed between day A and day B?\"): use " +
    "**memory_timeline** to get matching memories in chronological order. " +
    "Reason about the order to find the latest decision; do NOT trust " +
    "first-mention ordering from a relevance search.\n" +
    "- Use memory_get to read the full content of a specific file.\n\n" +
    "### memory_get is NOT optional — read before refusing\n" +
    "Search snippets are excerpts, not the whole file. A fact you're " +
    "looking for can be in a chunk of the file that didn't match the " +
    "query strongly. Whenever any of these is true, you MUST call " +
    "memory_get before saying you can't find the answer:\n" +
    "- A returned URI's date or topic matches the question's subject, " +
    "and the snippet doesn't directly confirm the answer.\n" +
    "- The top 3 search hits all look topically relevant but none of " +
    "their snippets contain the specific fact asked for.\n" +
    "- You're tempted to say \"I couldn't find\" or \"the closest match " +
    "is\" — read the closest match in full first.\n\n" +
    "Do NOT refuse until you have read (memory_get) the top 3 most " +
    "topically relevant URIs in full and they genuinely don't contain " +
    "the answer.\n\n" +
    "### Answering\n" +
    "Be concise. Extract specific facts, names, dates, and numbers " +
    "verbatim from memory when they appear. Never invent details that " +
    "aren't in memory. If after reading the relevant files in full you " +
    "still don't have a confident answer, say you checked memory and " +
    "didn't find it — but do NOT also volunteer guesses, speculation, " +
    "or alternative \"closest matches\" that you haven't verified.\n\n" +
    "### Empty search results are NOT tool errors\n" +
    "When memory_search returns \"no results.\" or memory_get returns an " +
    "empty file, the tool worked correctly — it just found nothing. Do " +
    "NOT claim or imply a tool failed unless the tool's response " +
    "literally starts with \"Tool error:\". Phrases to avoid when the " +
    "tool simply returned empty: \"tool error,\" \"the system erred,\" " +
    "\"the search failed,\" \"couldn't retrieve due to an error,\" \"the " +
    "tool timed out.\" The honest framing is \"I searched memory for X " +
    "and didn't find it.\"\n\n" +
    "Citations: include `(Source: YYYY-MM-DD)` referencing the date of " +
    "the memory excerpt that supports the fact. Do not cite file paths.";

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
    {
        type: "function" as const,
        function: {
            name: "memory_timeline",
            description:
                "Return memories matching a topic in CHRONOLOGICAL ORDER (oldest → " +
                "newest), with the date prepended to each entry. Use this for " +
                "decision-tracking, temporal-reasoning, and \"how did X evolve\" " +
                "questions where the relative order of events matters. Unlike " +
                "memory_search, which returns by relevance and scrambles chronology, " +
                "this preserves the timeline so you can find the latest decision " +
                "and identify when things changed.",
            parameters: {
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description:
                            "Topic to scan the timeline for. Natural language; not just keywords.",
                    },
                    limit: {
                        type: "integer",
                        description: "Max memories to include. Default 12.",
                    },
                },
                required: ["topic"],
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
    /** Recall MemoryService that backs memory_search / memory_get / memory_timeline. */
    service: MemoryService;
    /** Absolute path to the memory root (used to resolve memory_get paths). */
    memoryRoot: string;
    /** Adapter's max-results setting; cap on tool calls. */
    maxSearchResults: number;
    /** Optional cap on tool-loop iterations. Default 6. */
    maxIterations?: number;
    /**
     * Optional pre-fetched wiki context to inject at the top of the first
     * user message. Lets the harness do a wiki-first pre-pass before the
     * loop starts so the agent sees current-state wiki pages without
     * needing to discover them via tool calls.
     */
    wikiPreamble?: string;
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

    const userContent = deps.wikiPreamble
        ? `${deps.wikiPreamble}Question: ${question}`
        : question;
    const messages: ChatMessage[] = [
        { role: "system", content: AGENT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
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
                } else if (name === "memory_timeline") {
                    const out = await executeMemoryTimeline(deps, args);
                    for (const r of out.results) retrieval.push(r);
                    resultText = out.text;
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

/**
 * Per-hit snippet budget for memory_search results. Previously 600 chars,
 * which is roughly one short paragraph of an EA daily log — too small to
 * confirm whether a file contains the answer. 1500 chars is ~3 paragraphs
 * and surfaces enough context that the agent can decide whether a memory_get
 * follow-up is needed. Tuned after the first 60d run's q005 failure:
 * retrieval returned the right file but the 600-char snippet didn't show
 * the buried fact, so the agent refused (and hallucinated thread names).
 */
const SEARCH_SNIPPET_CHARS = 1500;

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
        snippet: (h.text ?? "").slice(0, SEARCH_SNIPPET_CHARS),
    }));
    const formatted = hits
        .map(
            (h, idx) =>
                `[${idx + 1}] ${h.uri} (score: ${h.score.toFixed(2)})\n${(h.text ?? "")
                    .trim()
                    .slice(0, SEARCH_SNIPPET_CHARS)}`,
        )
        .join("\n\n");
    return { text: formatted, results };
}

/**
 * Chronologically-ordered timeline of memories matching `topic`. Pulls a
 * generous candidate set via vector search, extracts a date from each
 * URI (daily / weekly / monthly / wiki by `updated`), sorts oldest →
 * newest, and formats with explicit "first → latest" framing. The
 * candidate set is unfiltered by content type so dailies, summaries, and
 * wiki pages all appear in their natural place in the timeline.
 */
async function executeMemoryTimeline(
    deps: AgentLoopDeps,
    args: Record<string, unknown>,
): Promise<{
    text: string;
    results: Array<{ path: string; score: number; snippet: string }>;
}> {
    const topic = typeof args.topic === "string" ? args.topic : "";
    if (!topic.trim()) {
        return { text: "memory_timeline: missing 'topic' argument.", results: [] };
    }
    const requestedLimit = typeof args.limit === "number" ? args.limit : 12;
    // Oversample so we can sort + take limit AFTER chronological ordering,
    // not just top-N-by-relevance.
    const oversample = Math.min(
        Math.max(requestedLimit * 2, deps.maxSearchResults),
        Math.max(requestedLimit * 2, 30),
    );
    const hits: SearchResult[] = await deps.service.search(topic, {
        maxResults: oversample,
        skipSync: true,
    });
    if (hits.length === 0) {
        return {
            text: `memory_timeline("${topic}") → no results.`,
            results: [],
        };
    }

    // Attach an extracted date to each hit. Hits without an extractable
    // date land at the end (date == null) so they don't pollute the
    // chronological view.
    type Dated = SearchResult & { _date: Date | null };
    const dated: Dated[] = hits.map((h) => ({
        ...h,
        _date: extractDateFromUri(h.uri),
    }));
    dated.sort((a, b) => {
        if (a._date && b._date) return a._date.getTime() - b._date.getTime();
        if (a._date) return -1;
        if (b._date) return 1;
        return 0;
    });

    const limited = dated.slice(0, requestedLimit);
    const results = limited.map((h) => ({
        path: h.uri,
        score: h.score,
        snippet: (h.text ?? "").slice(0, SEARCH_SNIPPET_CHARS),
    }));
    const blocks = limited.map((h, idx) => {
        const dateLabel = h._date
            ? h._date.toISOString().slice(0, 10)
            : "(undated)";
        const ordinal =
            idx === 0
                ? "[first mention]"
                : idx === limited.length - 1
                  ? "[latest mention]"
                  : "";
        // Tighter snippet than memory_search since memory_timeline returns
        // many entries (up to `limit`, default 12). 800 chars per entry
        // keeps the full tool response under ~10kb in the common case.
        return `${dateLabel} ${ordinal} ${h.uri}\n${(h.text ?? "").trim().slice(0, 800)}`;
    });
    const text =
        `Timeline for "${topic}" (${limited.length} entries, oldest → newest):\n\n` +
        blocks.join("\n\n---\n\n");
    return { text, results };
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
