/**
 * Synthesis: turn a list of OpenClaw search hits into a prose answer with an LLM.
 *
 * OpenClaw's memory system returns ranked document chunks; the bench's judge
 * scores answers in natural language. This module bridges the two.
 */

import type { MemorySearchResult } from "@openclaw/memory-core/runtime-api.js";

/**
 * Anything that can take (system, user) prompts and return text.
 *
 * Compatible with `@recall/bench`'s `GeneratorModel` interface — pass an
 * `OpenAiGeneratorModel` directly.
 */
export interface SynthesisModel {
    complete(
        systemPrompt: string,
        userMessage: string,
        options?: { temperature?: number; maxTokens?: number },
    ): Promise<{ text: string }>;
}

/**
 * Synthesis system prompt aligned with OpenClaw's recommended memory-recall
 * guidance (see `extensions/memory-core/src/prompt-section.ts`). Differs from
 * the earlier draft in three ways that meaningfully shifted behavior in
 * bench failure analysis:
 *
 *   1. Default disposition is "answer from the matching results" rather than
 *      "answer only if the excerpts contain enough." Discourages reflexive
 *      hedging when content IS present (the dominant failure mode observed:
 *      ~84% of factual-recall failures were synthesis refusing or
 *      mis-extracting despite the right chunk being retrieved).
 *   2. Soft hedge: "if low confidence say you checked" instead of a hard
 *      refusal phrase. Mirrors OpenClaw's wording.
 *   3. Citation: ask the model to indicate the source date so the failure
 *      log can detect when the model cited a chunk that doesn't support a
 *      claim.
 */
export const SYNTHESIS_SYSTEM_PROMPT =
    'You are an assistant answering from the agent\'s memory. Each MEMORY ' +
    'excerpt below is tagged with the date it was recorded.\n\n' +
    'Read through the excerpts and answer the question from them. Extract ' +
    'specific facts, names, dates, and numbers verbatim from the excerpts ' +
    'when they appear. Be concise.\n\n' +
    'If the excerpts contain a confident answer, give it directly and cite ' +
    'the source date in the form `(Source: YYYY-MM-DD)`. Do not cite file ' +
    'paths. If the excerpts do not contain a confident answer, say plainly ' +
    'that you checked the memory and did not find it — never invent details ' +
    'or fabricate names, dates, or numbers that aren\'t in the excerpts.';

const MAX_CONTEXT_CHARS = 24_000;

/**
 * Format search hits as a labeled context block, descending by score.
 *
 * Header derives a date label from the `path` (e.g., `memory/2026-03-15.md` →
 * `2026-03-15`). Truncates so the total stays under `MAX_CONTEXT_CHARS`.
 */
export function assembleContext(results: MemorySearchResult[]): string {
    const sorted = [...results].sort((a, b) => b.score - a.score);
    const blocks: string[] = [];
    let total = 0;

    for (const r of sorted) {
        const label = deriveDateLabel(r.path);
        const header = `[${label}] (score: ${r.score.toFixed(2)})`;
        const block = `${header}\n${r.snippet.trim()}`;
        if (total + block.length + 2 > MAX_CONTEXT_CHARS) break;
        blocks.push(block);
        total += block.length + 2;
    }

    return blocks.join('\n\n');
}

/**
 * Derive a human-readable label from an OpenClaw memory path. The expected
 * shape is `memory/YYYY-MM-DD.md` but we degrade gracefully for anything else.
 */
function deriveDateLabel(path: string): string {
    const match = /(\d{4}-\d{2}-\d{2})/.exec(path);
    if (match) return match[1] ?? path;
    return path.replace(/^memory\//, '').replace(/\.md$/, '');
}

/**
 * Synthesize a prose answer from search hits using `model`.
 *
 * Returns the model's text verbatim. If `results` is empty, skips the LLM and
 * returns the standard "not enough information" reply.
 */
export async function synthesizeAnswer(
    model: SynthesisModel,
    question: string,
    results: MemorySearchResult[],
    opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
    if (results.length === 0) {
        return "I don't have enough information in my memory to answer this.";
    }
    const context = assembleContext(results);
    const userMessage = `Question: ${question}\n\nMemory excerpts:\n${context}`;
    const result = await model.complete(SYNTHESIS_SYSTEM_PROMPT, userMessage, {
        temperature: opts?.temperature ?? 0,
        maxTokens: opts?.maxTokens ?? 600,
    });
    return result.text.trim();
}
