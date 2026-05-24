/**
 * Query-time answer synthesis.
 *
 * MemPalace returns verbatim memory chunks from `mempalace_search`. The bench
 * judge scores prose answers, not raw retrieval, so we run a small LLM
 * synthesis step here — mirroring the recall and openclaw harnesses. Both
 * OpenAI and Azure are supported via the same `openai` SDK.
 */

import type { MempalaceSearchResult, RetrievalEntry } from './types.js';

export interface SynthesisModel {
    complete(systemPrompt: string, userMessage: string, options?: { temperature?: number; maxTokens?: number }): Promise<{ text: string }>;
}

export interface SynthesisOptions {
    /** Display name used in the synthesis system prompt. Default: 'the assistant'. */
    identityName?: string;
    /** Identity body threaded into the synthesis system prompt. */
    identity?: string;
    /** Max characters of memory excerpts assembled into the prompt. Default: 8000. */
    contextBudget?: number;
}

const SYSTEM_PROMPT_PREFIX = [
    'You are an assistant answering questions strictly from the memory excerpts provided.',
    'Be concise and direct. Quote names, dates, and specific values exactly when they appear in the excerpts.',
    'If the excerpts do not contain enough information to answer, say so plainly rather than guessing.',
].join(' ');

const DEFAULT_CONTEXT_BUDGET = 8000;

export function toRetrievalEntries(results: MempalaceSearchResult[]): RetrievalEntry[] {
    return results.map((r) => ({
        // `room` is the ISO date — surfaces the source day in failures.jsonl.
        path: `${r.wing}/${r.room}${r.source_file ? `:${r.source_file}` : ''}`,
        score: typeof r.similarity === 'number' ? r.similarity : 0,
        snippet: (r.text ?? '').slice(0, 600),
    }));
}

export async function synthesizeAnswer(
    model: SynthesisModel,
    question: string,
    results: MempalaceSearchResult[],
    options: SynthesisOptions = {},
): Promise<string> {
    const budget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    let used = 0;
    const chunks: string[] = [];
    for (const r of results) {
        const piece = `--- ${r.wing}/${r.room} (similarity: ${(r.similarity ?? 0).toFixed(2)})\n${r.text ?? ''}\n`;
        if (used + piece.length > budget && chunks.length > 0) break;
        chunks.push(piece);
        used += piece.length;
    }
    const excerpts = chunks.join('\n').trim();

    const identityBlock =
        options.identity && options.identity.trim()
            ? `You are ${options.identityName ?? 'the assistant'}. ${options.identity.trim()}\n\n`
            : '';
    const systemPrompt = identityBlock + SYSTEM_PROMPT_PREFIX;
    const userPrompt =
        `Question: ${question}\n\nMemory excerpts:\n${excerpts || '(no relevant memories found)'}\n\nAnswer:`;

    const result = await model.complete(systemPrompt, userPrompt, {
        temperature: 0,
        maxTokens: 600,
    });
    return result.text.trim();
}

/**
 * Lazy-built OpenAI-compatible synthesis model. Imports the `openai` SDK on
 * first call so tests that inject `synthesisModelImpl` never load it.
 */
export function buildOpenAiSynthesisModel(opts: {
    provider: 'openai' | 'azure';
    model: string;
    openAiApiKey?: string;
    azureEndpoint?: string;
    azureApiVersion?: string;
    azureApiKey?: string;
}): SynthesisModel {
    let cached: SynthesisModel | null = null;
    return {
        async complete(systemPrompt, userMessage, options) {
            if (!cached) {
                const mod = (await import('openai')) as typeof import('openai');
                let client: { chat: { completions: { create: (p: unknown) => Promise<unknown> } } };

                if (opts.provider === 'azure') {
                    const apiKey = opts.azureApiKey ?? process.env['AZURE_OPENAI_API_KEY'];
                    const endpoint = opts.azureEndpoint ?? process.env['AZURE_OPENAI_ENDPOINT'];
                    const apiVersion = opts.azureApiVersion ?? process.env['AZURE_OPENAI_API_VERSION'];
                    if (!apiKey) throw new Error('Azure synthesis requires AZURE_OPENAI_API_KEY (env or azureApiKey).');
                    if (!endpoint) throw new Error('Azure synthesis requires AZURE_OPENAI_ENDPOINT (env or azureEndpoint).');
                    if (!apiVersion) throw new Error('Azure synthesis requires AZURE_OPENAI_API_VERSION (env or azureApiVersion).');
                    client = new mod.AzureOpenAI({
                        apiKey,
                        endpoint,
                        apiVersion,
                        deployment: opts.model,
                        maxRetries: 10,
                    }) as unknown as typeof client;
                } else {
                    const apiKey = opts.openAiApiKey ?? process.env['OPENAI_API_KEY'];
                    if (!apiKey) throw new Error('OpenAI synthesis requires OPENAI_API_KEY (env or openAiApiKey).');
                    client = new mod.default({ apiKey }) as unknown as typeof client;
                }

                cached = {
                    async complete(sys, usr, callOpts) {
                        const params: Record<string, unknown> = {
                            model: opts.model,
                            messages: [
                                { role: 'system', content: sys },
                                { role: 'user', content: usr },
                            ],
                        };
                        if (callOpts?.temperature !== undefined) params['temperature'] = callOpts.temperature;
                        if (callOpts?.maxTokens !== undefined) params['max_completion_tokens'] = callOpts.maxTokens;
                        const response = (await client.chat.completions.create(params)) as {
                            choices: Array<{ message?: { content?: string | null } }>;
                        };
                        const text = response.choices?.[0]?.message?.content ?? '';
                        return { text };
                    },
                };
            }
            return cached.complete(systemPrompt, userMessage, options);
        },
    };
}
