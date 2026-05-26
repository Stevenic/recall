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
    "- *Current/latest state* questions (\"what's the current X?\", " +
    "\"latest X?\", \"by the end of the window?\", \"what is X now?\", " +
    "\"what did Jordan keep as the working Y?\"): **start with " +
    "memory_timeline**. Facts about projects, decisions, and values " +
    "often get REVISED in later dailies (e.g. synergy case raised, " +
    "leverage ceiling tightened, valuation range widened). A naive " +
    "memory_search picks an early daily where the fact was first " +
    "established and misses the revision. memory_timeline returns hits " +
    "chronologically with `[first mention]` and `[latest mention]` " +
    "markers — memory_get the `[latest mention]` entry first.\n" +
    "- *Point-in-time / date-pinned* questions (\"what did we say on day " +
    "N?\", \"what happened on March 15?\", \"recorded on YYYY-MM-DD?\"): " +
    "memory_get the daily for that date directly (`memory/YYYY-MM-DD.md`).\n" +
    "- *Wiki-style synthesis* questions (\"how does the X process " +
    "work?\", \"what is our overall approach to Y?\"): the wiki page is " +
    "your answer; memory_get a cited daily only if you need a specific " +
    "value to ground a claim.\n" +
    "- *Trajectory* questions (\"when did we decide X?\", \"how did Y " +
    "evolve?\", \"what changed between day A and day B?\"): use " +
    "**memory_timeline** and reason about the order. memory_timeline " +
    "uses the wiki as an index — it finds the topic's anchor wiki page, " +
    "collects every daily that contributed to that page, and returns " +
    "those dailies in chronological order filtered by the topic query. " +
    "So a single timeline call gives you the topic-curated daily set " +
    "without you having to do separate searches per sub-aspect.\n" +
    "- Use memory_get to read the full content of a specific file.\n\n" +
    "### Don't stop on first hit — chase the latest\n" +
    "When the question is about CURRENT state of a fact that COULD have " +
    "been revised (numeric values, dates, decisions, statuses, names), " +
    "do NOT answer from the first daily that mentions the fact. The " +
    "first daily mentions the ORIGINAL value; later dailies may revise " +
    "it. Before answering:\n" +
    "1. Run memory_timeline on the topic.\n" +
    "2. Look at the date of the LATEST hit. If it's significantly later " +
    "than the first hit, memory_get the latest one — that's where the " +
    "revision lives.\n" +
    "3. If the latest daily contradicts the earliest, the latest wins.\n" +
    "Common revisions in this corpus: financial values (purchase price, " +
    "synergies, leverage), project posture (screening → diligence → " +
    "synthesis), authorization scope (read-only → send-on-behalf → " +
    "independent approval), entity names (project codenames mapped to " +
    "real names).\n\n" +
    "### Date-pinned questions go straight to the daily\n" +
    "When the question pins a specific date (\"on YYYY-MM-DD\", \"on " +
    "March 15\", \"recorded on…\", \"as of 2026-01-07\"), the daily for " +
    "that date is your primary source. Call memory_get on " +
    "`memory/YYYY-MM-DD.md` first — even if a wiki page seems to cover " +
    "the topic, the wiki is a synthesis across many days and may " +
    "attribute facts to the wrong date. The daily's own text is the " +
    "ground truth for what was recorded on that specific day.\n\n" +
    "### Wiki pages are syntheses — verify specifics against dailies\n" +
    "Wiki pages summarize a topic; they aggregate facts from many dailies " +
    "and can lag behind the latest daily. When a question asks for a " +
    "**specific value, date, name, quantity, or quote** (e.g. \"what was X?\", " +
    "\"how much was Y?\", \"when did Z happen?\", \"what did P say?\"), " +
    "the wiki page is your starting point but NOT your final answer. " +
    "Always memory_get at least one daily cited by the wiki page (or a " +
    "topically-relevant daily from memory_search) and verify the " +
    "specific value there before answering. If the daily says something " +
    "different than the wiki, **trust the daily** — the wiki may be " +
    "stale relative to a recent revision. Synthesis / framing questions " +
    "(\"what is the overall approach to X?\") can answer from the wiki " +
    "directly without daily verification.\n\n" +
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
    "### Confidentiality framing applies cross-session, not in-session\n" +
    "Some wiki pages or dailies describe a topic as **confidential, " +
    "session-isolated, sensitive, or restricted to a specific thread**. " +
    "That framing is about **cross-session** disclosure — what to surface " +
    "if a question arrives from a DIFFERENT session or audience. Inside " +
    "the session that owns the data, the fact is fair to surface " +
    "directly. Do NOT refuse to disclose a value just because the wiki " +
    "page notes \"this is confidential / session-isolated.\" If the " +
    "question is asked and the underlying daily contains the answer, " +
    "answer with the specific value and cite the daily.\n\n" +
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
                "dates, people, preferences, or todos. " +
                "Default behavior partitions results into a dailies/typed-memory " +
                "section AND a separate wiki-pages section. Override with " +
                "`corpus` to restrict to one source.",
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
                    maxResults: {
                        type: "integer",
                        description:
                            "Alias for `limit` — accepted for parity with the " +
                            "OpenClaw memory_search schema. When both are " +
                            "supplied, `limit` wins.",
                    },
                    minScore: {
                        type: "number",
                        description:
                            "Minimum similarity score for returned hits, in " +
                            "[0, 1]. Accepted for parity with the OpenClaw " +
                            "schema. Recall's retrieval has no built-in score " +
                            "floor (the cosine/BM25 hybrid scale differs from " +
                            "OpenClaw's inverse-L2), so this is currently " +
                            "advisory and does not filter results.",
                    },
                    corpus: {
                        type: "string",
                        enum: ["memory", "wiki", "all", "sessions"],
                        description:
                            "Source filter. `memory` = daily logs + typed " +
                            "memories only. `wiki` = synthesized wiki pages " +
                            "only. `all` = unified pool (no partition). " +
                            "`sessions` = session transcripts (not indexed in " +
                            "Recall; falls back to `memory`). When omitted, " +
                            "the bench harness returns a partitioned dailies + " +
                            "wiki view so both source types are visible " +
                            "without competing for slots.",
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
                "Read a specific memory file by path. Use after memory_search " +
                "when you need more context than the search snippet provides. " +
                "Supports ranged reads via `from` + `lines` to fetch a window " +
                "without pulling the whole file.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description:
                            "Path returned by memory_search (e.g. memory/2026-03-15.md " +
                            "or memory/wiki/<slug>.md).",
                    },
                    from: {
                        type: "integer",
                        description:
                            "Optional starting line (1-based). When omitted, " +
                            "reads from the beginning of the file.",
                    },
                    lines: {
                        type: "integer",
                        description:
                            "Optional number of lines to return starting from " +
                            "`from`. When omitted, reads to end of file.",
                    },
                    corpus: {
                        type: "string",
                        enum: ["memory", "wiki", "all"],
                        description:
                            "Optional source hint. Recall stores wiki pages " +
                            "under `memory/wiki/<slug>.md` and dailies under " +
                            "`memory/<date>.md`, so the path already encodes " +
                            "the corpus. Accepted for parity with the OpenClaw " +
                            "schema; ignored at execution time.",
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
    /** Adapter's max-results setting; cap on tool calls. Applies to the
     *  daily/typed-memory pool. */
    maxSearchResults: number;
    /**
     * Adapter's wiki-results setting; cap on the wiki-only second pass
     * surfaced alongside each memory_search call. Set to 0 to disable
     * the partition (wiki then competes with dailies for the unified
     * `maxSearchResults` slots). Default 3.
     */
    maxWikiSearchResults?: number;
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
    retrieval: Array<{
        path: string;
        score: number;
        snippet: string;
        startLine?: number;
        endLine?: number;
    }>;
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

        // Fire all tool calls in this turn in parallel. The model often
        // emits 2-3 calls together (e.g., "search X" + "search Y" +
        // "get Z") and they're independent; running them sequentially
        // wastes turn latency. Order is preserved in `messages` via the
        // pre-allocated results array so the tool_call_id mapping the
        // model expects stays intact.
        const turnResults: Array<{
            callId: string;
            text: string;
            retrievalAdds: Array<{ path: string; score: number; snippet: string }>;
            traceEntry: AgentLoopResult["trace"][number];
        }> = new Array(msg.tool_calls.length);
        await Promise.all(
            msg.tool_calls.map(async (call, idx) => {
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
                const retrievalAdds: Array<{ path: string; score: number; snippet: string }> = [];
                try {
                    if (name === "memory_search") {
                        const out = await executeMemorySearch(deps, args);
                        for (const r of out.results) retrievalAdds.push(r);
                        resultText = out.text;
                    } else if (name === "memory_get") {
                        resultText = await executeMemoryGet(deps, args);
                    } else if (name === "memory_timeline") {
                        const out = await executeMemoryTimeline(deps, args);
                        for (const r of out.results) retrievalAdds.push(r);
                        resultText = out.text;
                    } else {
                        resultText = `Unknown tool: ${name}`;
                    }
                } catch (err) {
                    resultText = `Tool error: ${
                        err instanceof Error ? err.message : String(err)
                    }`;
                }
                turnResults[idx] = {
                    callId: call.id,
                    text: resultText,
                    retrievalAdds,
                    traceEntry: {
                        tool: name ?? "(unknown)",
                        args,
                        resultPreview: resultText.slice(0, 200),
                    },
                };
            }),
        );
        // Apply results in deterministic order so the trace, retrieval
        // list, and tool reply messages all reflect the model's original
        // tool-call ordering.
        for (const r of turnResults) {
            for (const ra of r.retrievalAdds) retrieval.push(ra);
            trace.push(r.traceEntry);
            messages.push({
                role: "tool",
                tool_call_id: r.callId,
                content: r.text,
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
 * Per-hit snippet budget for memory_search results. Tracks OpenClaw's
 * production `SNIPPET_MAX_CHARS = 700` (see
 * openclaw/extensions/memory-core/src/memory/manager.ts) so the head-to-
 * head bench is comparing memory systems, not snippet-width differences.
 * When the snippet doesn't show the fact, the agent is expected to
 * follow up with `memory_get` for the full file — exactly the loop
 * OpenClaw's prod stack runs.
 *
 * Historical tunings:
 *   600 — original; too small for EA dailies, missed buried facts.
 *   1500 — bumped to surface fuller context in early 60d runs.
 *   700 — aligned to OpenClaw production for fair benchmarking (current).
 */
const SEARCH_SNIPPET_CHARS = 700;

async function executeMemorySearch(
    deps: AgentLoopDeps,
    args: Record<string, unknown>,
): Promise<{
    text: string;
    results: Array<{
        path: string;
        score: number;
        snippet: string;
        startLine?: number;
        endLine?: number;
    }>;
}> {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) {
        return { text: "memory_search: missing 'query' argument.", results: [] };
    }
    // `limit` is the historical Recall name; `maxResults` is the OpenClaw
    // schema field. When both are present, `limit` wins (caller probably
    // copy-pasted from an older call). `minScore` is accepted but advisory
    // — Recall's retrieval has no built-in score floor.
    const rawLimit =
        typeof args.limit === "number"
            ? args.limit
            : typeof args.maxResults === "number"
              ? args.maxResults
              : 8;
    const requestedLimit = Math.min(
        Math.max(1, Math.floor(rawLimit)),
        deps.maxSearchResults,
    );
    const wikiBudget = Math.max(0, deps.maxWikiSearchResults ?? 0);
    const corpus = typeof args.corpus === "string" ? args.corpus : null;

    // Dispatch table:
    //   corpus=undefined  → partitioned (dailies + wiki separately)
    //   corpus="memory"   → dailies-only single search
    //   corpus="wiki"     → wiki-only single search
    //   corpus="all"      → unified pool, no partition
    //   corpus="sessions" → fall back to "memory" with a note
    let dailyHits: SearchResult[];
    let wikiHits: SearchResult[];
    let sessionsFallbackNote = "";

    if (corpus === "memory") {
        dailyHits = await deps.service.search(query, {
            maxResults: requestedLimit,
            skipSync: true,
            includeWiki: false,
        });
        wikiHits = [];
    } else if (corpus === "wiki") {
        const wikiLimit = wikiBudget > 0 ? wikiBudget : requestedLimit;
        dailyHits = [];
        wikiHits = await deps.service.search(query, {
            maxResults: wikiLimit,
            skipSync: true,
            wikiOnly: true,
        });
    } else if (corpus === "all") {
        dailyHits = await deps.service.search(query, {
            maxResults: requestedLimit,
            skipSync: true,
        });
        wikiHits = [];
    } else if (corpus === "sessions") {
        sessionsFallbackNote =
            "(Note: Recall doesn't index session transcripts. Returning " +
            "`corpus=memory` results instead.)\n\n";
        dailyHits = await deps.service.search(query, {
            maxResults: requestedLimit,
            skipSync: true,
            includeWiki: false,
        });
        wikiHits = [];
    } else {
        // Default: partitioned dailies + wiki.
        const dailySearch = deps.service.search(query, {
            maxResults: requestedLimit,
            skipSync: true,
            includeWiki: wikiBudget > 0 ? false : undefined,
        });
        const wikiSearch =
            wikiBudget > 0
                ? deps.service.search(query, {
                      maxResults: wikiBudget,
                      skipSync: true,
                      wikiOnly: true,
                  })
                : Promise.resolve<SearchResult[]>([]);
        [dailyHits, wikiHits] = await Promise.all([dailySearch, wikiSearch]);
    }

    if (dailyHits.length === 0 && wikiHits.length === 0) {
        return { text: `memory_search("${query}") → no results.`, results: [] };
    }

    // Date annotation helpers. Daily/typed-memory hits get LATEST/earliest
    // markers when their dates span a real window; wiki pages stay
    // unmarked since their "date" is `updated` (synthesis time), not the
    // claim's date.
    const dailyDates = dailyHits.map((h) => extractDateFromUri(h.uri));
    let datedMin: Date | null = null;
    let datedMax: Date | null = null;
    for (const d of dailyDates) {
        if (!d) continue;
        if (!datedMin || d < datedMin) datedMin = d;
        if (!datedMax || d > datedMax) datedMax = d;
    }

    const dailyResults = dailyHits.map((h) => ({
        path: h.uri,
        score: h.score,
        snippet: (h.text ?? "").slice(0, SEARCH_SNIPPET_CHARS),
        ...(h.startLine != null ? { startLine: h.startLine } : {}),
        ...(h.endLine != null ? { endLine: h.endLine } : {}),
    }));
    const wikiResults = wikiHits.map((h) => ({
        path: h.uri,
        score: h.score,
        snippet: (h.text ?? "").slice(0, SEARCH_SNIPPET_CHARS),
        ...(h.startLine != null ? { startLine: h.startLine } : {}),
        ...(h.endLine != null ? { endLine: h.endLine } : {}),
    }));

    const dailyBlocks = dailyHits.map((h, idx) => {
        const date = dailyDates[idx];
        const dateLabel = date ? date.toISOString().slice(0, 10) : "(undated)";
        let marker = "";
        if (date && datedMin && datedMax && datedMin < datedMax) {
            if (date.getTime() === datedMax.getTime()) marker = " [LATEST]";
            else if (date.getTime() === datedMin.getTime()) marker = " [earliest]";
        }
        const range = formatLineRange(h);
        return (
            `[D${idx + 1}] ${dateLabel}${marker} · ${h.uri}${range} (score: ${h.score.toFixed(2)})\n` +
            (h.text ?? "").trim().slice(0, SEARCH_SNIPPET_CHARS)
        );
    });

    const wikiBlocks = wikiHits.map((h, idx) => {
        const range = formatLineRange(h);
        return (
            `[W${idx + 1}] ${h.uri}${range} (score: ${h.score.toFixed(2)})\n` +
            (h.text ?? "").trim().slice(0, SEARCH_SNIPPET_CHARS)
        );
    });

    const sections: string[] = [];
    if (dailyBlocks.length > 0) {
        sections.push(
            `=== Dailies / typed memories (${dailyBlocks.length}) ===\n\n` +
                dailyBlocks.join("\n\n"),
        );
    }
    if (wikiBlocks.length > 0) {
        sections.push(
            `=== Wiki pages (${wikiBlocks.length}) — synthesized; verify specific values against the cited dailies before quoting ===\n\n` +
                wikiBlocks.join("\n\n"),
        );
    }
    const formatted = sessionsFallbackNote + sections.join("\n\n");

    // Return dailies first in the retrieval array so downstream failure
    // logs surface them at the top — the partition is preserved in the
    // formatted text but the array is just a flat record for the bench.
    return { text: formatted, results: [...dailyResults, ...wikiResults] };
}

/**
 * Chronologically-ordered timeline of memories matching `topic`. Pulls a
 * generous candidate set via vector search, extracts a date from each
 * URI (daily / weekly / monthly / wiki by `updated`), sorts oldest →
 * newest, and formats with explicit "first → latest" framing. The
 * candidate set is unfiltered by content type so dailies, summaries, and
 * wiki pages all appear in their natural place in the timeline.
 */
/**
 * Wiki-anchored timeline walk.
 *
 * The naive timeline (search → sort by date) had two problems:
 *
 *   1. Wiki pages got mixed into the chronology by their `updated` field,
 *      which is dreaming-session time, not claim time. A trajectory page
 *      that refreshed today landed as "latest" even when the underlying
 *      claim was from months ago.
 *   2. Direct daily search by relevance missed dailies that dreaming had
 *      tagged as part of a topic's narrative but whose individual chunks
 *      had lower vector similarity to the query. The wiki had already
 *      done the topic-clustering work — we were ignoring it.
 *
 * The walk:
 *
 *   1. Wiki-search the topic → top-k wiki pages that anchor it.
 *   2. Read each page; union `sources` + `supersedes[*].source` into a
 *      contributor set — every daily that shaped the topic's narrative.
 *   3. Daily-search the topic (oversampled), filter hits to those whose
 *      URI is in the contributor set. This gives "the most relevant
 *      chunks across the dailies that the wiki has decided are on this
 *      topic."
 *   4. Sort chronologically, take top N.
 *
 * Fallback: when no wiki pages exist for the topic (cold corpus, niche
 * sub-question), revert to the naive daily-search-then-sort path so the
 * tool still returns something useful.
 */
async function executeMemoryTimeline(
    deps: AgentLoopDeps,
    args: Record<string, unknown>,
): Promise<{
    text: string;
    results: Array<{
        path: string;
        score: number;
        snippet: string;
        startLine?: number;
        endLine?: number;
    }>;
}> {
    const topic = typeof args.topic === "string" ? args.topic : "";
    if (!topic.trim()) {
        return { text: "memory_timeline: missing 'topic' argument.", results: [] };
    }
    const requestedLimit = typeof args.limit === "number" ? args.limit : 12;

    // Step 1: top wiki pages on the topic. Five is enough to anchor most
    // queries — more than the bench's `wikiSearchK` because we use these
    // pages as graph roots, not as content the agent reads directly.
    const wikiAnchors = await deps.service.search(topic, {
        maxResults: 5,
        skipSync: true,
        wikiOnly: true,
    });

    // Step 2: collect contributor daily URIs from each anchor page.
    const contributors = new Set<string>();
    const anchorSlugs: string[] = [];
    for (const hit of wikiAnchors) {
        const slug = extractWikiSlugFromUri(hit.uri);
        if (!slug) continue;
        anchorSlugs.push(slug);
        try {
            const page = await deps.service.wiki.read(slug, "private");
            if (!page) continue;
            for (const src of page.sources) contributors.add(src.uri);
            for (const sup of page.supersedes ?? []) {
                if (sup.source) contributors.add(sup.source);
            }
        } catch {
            // Wiki disabled or page missing — non-fatal.
        }
    }

    // Step 3: daily-search the topic, filtered to contributors when we
    // have a non-empty contributor set; otherwise fall back to unfiltered
    // daily search (preserves prior behavior for cold corpus).
    const oversample = Math.max(requestedLimit * 3, 30);
    const dailyHits: SearchResult[] = await deps.service.search(topic, {
        maxResults: oversample,
        skipSync: true,
        includeWiki: false,
    });

    let filtered: SearchResult[];
    let walkSummary: string;
    if (contributors.size > 0) {
        const inSet = dailyHits.filter((h) => contributors.has(h.uri));
        if (inSet.length > 0) {
            filtered = inSet;
            walkSummary =
                `via wiki anchors [${anchorSlugs.join(", ")}] → ` +
                `${contributors.size} contributor dailies → ` +
                `${inSet.length} matched the topic query`;
        } else {
            // Wiki had contributors but vector search didn't surface
            // them. Loose fallback: include the daily hits anyway so the
            // tool still produces a chronology.
            filtered = dailyHits;
            walkSummary =
                `wiki anchors [${anchorSlugs.join(", ")}] flagged ` +
                `${contributors.size} contributor dailies, but vector ` +
                `search returned different hits — showing those instead`;
        }
    } else {
        filtered = dailyHits;
        walkSummary =
            `no wiki page anchors the topic — falling back to direct ` +
            `daily search`;
    }

    if (filtered.length === 0) {
        return {
            text: `memory_timeline("${topic}") → no results (${walkSummary}).`,
            results: [],
        };
    }

    // Step 4: chronological sort + limit.
    type Dated = SearchResult & { _date: Date | null };
    const dated: Dated[] = filtered.map((h) => ({
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
        ...(h.startLine != null ? { startLine: h.startLine } : {}),
        ...(h.endLine != null ? { endLine: h.endLine } : {}),
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
        const range = formatLineRange(h);
        return `${dateLabel} ${ordinal} ${h.uri}${range}\n${(h.text ?? "").trim().slice(0, 800)}`;
    });
    const text =
        `Timeline for "${topic}" (${limited.length} entries, oldest → newest; ${walkSummary}):\n\n` +
        blocks.join("\n\n---\n\n");
    return { text, results };
}

/** Extract a wiki slug from a `memory/wiki/<slug>.md` URI. Returns null
 *  when the URI doesn't look like a wiki page. */
function extractWikiSlugFromUri(uri: string): string | null {
    const m = /(?:^|\/)memory\/wiki\/([^/]+)\.md$/.exec(uri);
    return m ? m[1] : null;
}

/**
 * Format a chunk's line range as `[start..end]` for inline display in
 * the tool result. Empty string when the range isn't known (older
 * index, hit without position metadata).
 */
function formatLineRange(h: { startLine?: number; endLine?: number }): string {
    if (
        typeof h.startLine === "number" &&
        typeof h.endLine === "number" &&
        h.startLine > 0 &&
        h.endLine >= h.startLine
    ) {
        return `[${h.startLine}..${h.endLine}]`;
    }
    return "";
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

    // Path is expected to be relative to the memory root.
    const resolved = path.isAbsolute(reqPath)
        ? reqPath
        : path.join(deps.memoryRoot, reqPath);
    if (!resolved.startsWith(deps.memoryRoot)) {
        return `memory_get: path "${reqPath}" resolves outside the memory root.`;
    }

    let content: string;
    try {
        const fs = await import("node:fs/promises");
        content = await fs.readFile(resolved, "utf-8");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `memory_get: failed to read "${reqPath}": ${msg}`;
    }

    // Full-file read when no range supplied — preserve prior behavior.
    if (fromArg == null && linesArg == null) {
        return content;
    }

    // Ranged read: slice on line numbers (1-based, inclusive of `from`).
    // `from` defaults to 1 when only `lines` is supplied. `lines` defaults
    // to "to end of file" when only `from` is supplied. Continuation
    // metadata appended when there are more lines past the window.
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
