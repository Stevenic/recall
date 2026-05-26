/**
 * Tool-calling agent loop for `answerMode: 'agent'`.
 *
 * Replaces the single-shot `mempalace_search → synthesize` pass with a small
 * agent that:
 *   1. Sees a memory-recall-oriented system prompt
 *   2. Has `memory_search` exposed as an OpenAI tool that proxies into mempalace
 *   3. Decides for itself how many searches to run and how to phrase them
 *
 * This mirrors OpenClaw's `+agent` mode and is what closes the 12-15pp
 * synthesis / cross-reference gap on the EA-180d bench: single-shot retrieval
 * fixes the *embedding* of the question once, while an agent gets to retry
 * with the question's actual answer-shape after seeing the first round of hits.
 *
 * `memory_get` is intentionally not exposed: mempalace's `list_drawers` only
 * returns 200-char previews, so there is no clean "fetch the whole day"
 * endpoint. The agent gets the same effect by re-issuing `memory_search` with
 * `room=<date>` and a larger `limit`, which pulls every relevant chunk in that
 * day at full content.
 */

import type { McpClient } from './mcp-client.js';
import { toRetrievalEntries } from './synthesis.js';
import type { MempalaceSearchResponse, QueryDetail, RetrievalEntry } from './types.js';

/** A function that performs a chat-completion (with optional tools). */
export type ChatCompleter = (params: ChatCompletionParams) => Promise<ChatCompletionResult>;

export interface ChatCompletionParams {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: 'auto' | 'none';
    temperature?: number;
    maxTokens?: number;
}

export interface ChatCompletionResult {
    /** Plain assistant text (when present). */
    content: string | null;
    /** Tool calls the model wants to make. Empty when the model is done. */
    toolCalls: ChatToolCall[];
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    /** Present when role === 'assistant' and the model requested tool calls. */
    toolCalls?: ChatToolCall[];
    /** Present when role === 'tool'. */
    toolCallId?: string;
}

export interface ChatToolCall {
    id: string;
    name: string;
    /** Raw JSON-string arguments from the model (we parse). */
    argumentsJson: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parametersJsonSchema: Record<string, unknown>;
}

export interface RunAgentLoopArgs {
    question: string;
    client: McpClient;
    /** Mempalace MCP tool name for search. Almost always `'mempalace_search'`. */
    searchTool: string;
    /** Iteration cap. The final iteration forces a no-tools answer. Default 6. */
    maxIterations: number;
    /** Default `limit` for `memory_search` tool calls when the model omits one. */
    searchK: number;
    /** Mempalace `max_distance` forwarded on every search. */
    maxDistance: number;
    /** Function that performs the chat completion. Lets tests stub the LLM. */
    chatComplete: ChatCompleter;
    /** Identity hint threaded into the system prompt. */
    identityName?: string | undefined;
    identity?: string | undefined;
    /** When true, append the same anti-elaboration clause synthesis mode uses. */
    tightenSynthesis: boolean;
}

const AGENT_BASE_PROMPT =
    'You are an assistant answering questions strictly from a long-term memory store. ' +
    'You have a `memory_search` tool that takes a natural-language query and optionally ' +
    'scopes the search to a specific calendar date (room) or persona wing.\n\n' +
    'Procedure for every question:\n' +
    '  1. Run memory_search first. Use the question itself as your initial query.\n' +
    '  2. Inspect the returned chunks. If the chunks show that the answer lives on a ' +
    'specific date, run memory_search again with `room` set to that date (YYYY-MM-DD) and ' +
    'a larger `limit` to pull every chunk from that day. Bullet-list chunks holding ' +
    'literal values often only surface under a room-scoped search.\n' +
    '  3. Repeat as needed (up to a few rounds). When you have grounding, stop calling ' +
    'tools and answer.\n\n' +
    'Quote names, dates, dollar figures, and other specific values verbatim from the ' +
    'memory chunks. If the chunks do not contain the answer, say so plainly — do not ' +
    'guess and do not invent details.';

const ANTI_ELABORATION_TAIL =
    '\n\nCritical: stop the moment you have answered. If the answer is a literal value ' +
    '(a name, a number, a date, a yes/no), respond with that value plus at most one short ' +
    'sentence of grounding. Do not add adjacent facts or extrapolations.';

const MEMORY_SEARCH_TOOL: ToolDefinition = {
    name: 'memory_search',
    description:
        'Search long-term memory. Always run this before answering. Use `room` (YYYY-MM-DD) ' +
        'to pull every chunk from a specific day after the first round of hits identifies ' +
        'the right day; use `wing` to scope to a persona.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Natural-language search query.',
            },
            limit: {
                type: 'integer',
                description: 'Max results. Use a larger value (e.g. 25-50) on room-scoped follow-ups.',
                minimum: 1,
                maximum: 100,
            },
            room: {
                type: 'string',
                description: 'Optional. ISO date (YYYY-MM-DD) to scope the search to one day.',
            },
            wing: {
                type: 'string',
                description: 'Optional. Persona id to scope the search to.',
            },
        },
        required: ['query'],
        additionalProperties: false,
    },
};

/**
 * Detect Azure OpenAI content-filter rejections. The SDK throws these as
 * BadRequestError instances; we surface a sentinel so the judge can score
 * the question as a refusal rather than crashing the run.
 */
function isContentFilterError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as {
        status?: number;
        code?: string;
        error?: { code?: string; innererror?: { code?: string } };
    };
    if (e.code === 'content_filter') return true;
    if (e.status === 400 && e.error?.code === 'content_filter') return true;
    if (e.error?.innererror?.code === 'ResponsibleAIPolicyViolation') return true;
    return false;
}

export async function runAgentLoop(args: RunAgentLoopArgs): Promise<QueryDetail> {
    const identityBlock =
        args.identity && args.identity.trim()
            ? `You are ${args.identityName ?? 'the assistant'}. ${args.identity.trim()}\n\n`
            : '';
    const systemPrompt =
        identityBlock + AGENT_BASE_PROMPT + (args.tightenSynthesis ? ANTI_ELABORATION_TAIL : '');

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: args.question },
    ];

    const retrieval: RetrievalEntry[] = [];
    const seenChunks = new Set<string>();

    for (let i = 0; i < args.maxIterations; i++) {
        let response: ChatCompletionResult;
        try {
            response = await args.chatComplete({
                messages,
                tools: [MEMORY_SEARCH_TOOL],
                toolChoice: 'auto',
                temperature: 0,
                maxTokens: 800,
            });
        } catch (err) {
            if (isContentFilterError(err)) {
                return {
                    answer: '(refused: Azure content filter triggered on this question)',
                    retrieval,
                };
            }
            throw err;
        }

        // Push the assistant turn so the next iteration's `tool` messages are valid.
        messages.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
        });

        if (!response.toolCalls || response.toolCalls.length === 0) {
            return {
                answer: (response.content ?? '').trim(),
                retrieval,
            };
        }

        // Execute every tool call the model made this turn.
        for (const call of response.toolCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
                parsedArgs = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
            } catch {
                parsedArgs = { _parseError: call.argumentsJson };
            }

            let toolResult: string;
            if (call.name === 'memory_search') {
                toolResult = await invokeMemorySearch(args, parsedArgs, retrieval, seenChunks);
            } else {
                toolResult = `Unknown tool: ${call.name}`;
            }

            messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: toolResult,
            });
        }
    }

    // Iteration cap reached — force a no-tools answer so we always return
    // something the judge can score.
    let final: ChatCompletionResult;
    try {
        final = await args.chatComplete({
            messages: [
                ...messages,
                {
                    role: 'user',
                    content:
                        'Based on the memory excerpts above, give your final answer now. Do not call any more tools.',
                },
            ],
            toolChoice: 'none',
            temperature: 0,
            maxTokens: 800,
        });
    } catch (err) {
        if (isContentFilterError(err)) {
            return {
                answer: '(refused: Azure content filter triggered on this question)',
                retrieval,
            };
        }
        throw err;
    }

    return {
        answer: (final.content ?? '').trim() || '(agent hit iteration cap with no answer)',
        retrieval,
    };
}

async function invokeMemorySearch(
    args: RunAgentLoopArgs,
    parsedArgs: Record<string, unknown>,
    retrieval: RetrievalEntry[],
    seenChunks: Set<string>,
): Promise<string> {
    const query = typeof parsedArgs['query'] === 'string' ? (parsedArgs['query'] as string) : '';
    if (!query) return 'memory_search error: missing "query" argument.';

    const callArgs: Record<string, unknown> = {
        query,
        limit: clampInt(parsedArgs['limit'], args.searchK, 1, 100),
        max_distance: args.maxDistance,
    };
    if (typeof parsedArgs['room'] === 'string' && parsedArgs['room']) {
        callArgs['room'] = parsedArgs['room'];
    }
    if (typeof parsedArgs['wing'] === 'string' && parsedArgs['wing']) {
        callArgs['wing'] = parsedArgs['wing'];
    }

    let raw: MempalaceSearchResponse;
    try {
        raw = (await args.client.callTool(args.searchTool, callArgs)) as MempalaceSearchResponse;
    } catch (err) {
        return `memory_search error: ${(err as Error).message}`;
    }
    if (raw?.error) return `memory_search error: ${raw.error}`;

    const results = Array.isArray(raw?.results) ? raw.results : [];
    // Track every unique chunk the agent has seen so failures.jsonl reflects
    // the full search trajectory, not just the last call.
    for (const r of results) {
        const key = `${r.wing}::${r.room}::${(r.text ?? '').slice(0, 120)}`;
        if (seenChunks.has(key)) continue;
        seenChunks.add(key);
        retrieval.push(toRetrievalEntries([r])[0]!);
    }

    if (results.length === 0) {
        return 'memory_search returned 0 results.';
    }
    // Format for the model: header + verbatim chunk text. Limit chunk text
    // to 1500 chars each so a wide search doesn't blow the model's context.
    const lines: string[] = [`memory_search returned ${results.length} chunk(s):`];
    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const text = (r.text ?? '').slice(0, 1500);
        lines.push(
            `\n[${i + 1}] room=${r.room} similarity=${(r.similarity ?? 0).toFixed(2)}\n${text}`,
        );
    }
    return lines.join('\n');
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
