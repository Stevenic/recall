/**
 * JudgeModel implementation backed by any GeneratorModel.
 *
 * Asks an LLM to score a system answer against a reference answer along
 * the three dimensions defined in `specs/recall-bench.md` §5.3:
 *
 *   - correctness   (0-3)
 *   - completeness  (0-2)
 *   - hallucination (0-1)
 *
 * Used by the bench harness when --judge is a model selector (claude,
 * openai, openai:gpt-4o, etc.) rather than a path to a custom JudgeModel
 * module. Lets the same model adapters that drive generation also drive
 * judging — particularly useful for OpenAI which can serve both roles.
 */

import type { GeneratorModel } from './generator-types.js';
import type { JudgeModel, JudgeScore } from './types.js';

/**
 * The system prompt the judge model receives. Instructs it to output
 * strict JSON with the three required score fields plus a one-line
 * reasoning summary. Temperature is fixed at 0 by the wrapper for
 * scoring stability.
 */
export const LLM_JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for an agent memory benchmark. Your job is to score one system answer against a reference answer along three dimensions and return a strict JSON object.

Scoring rubric:
- correctness (integer 0-3):
    3 = fully correct (matches the reference's factual content)
    2 = mostly correct (minor inaccuracies, or one detail off)
    1 = partially correct (right direction but significant gaps)
    0 = wrong (contradicts the reference, or no relevant information)
- completeness (integer 0-2):
    2 = complete (all key details from the reference are present)
    1 = partial (some key details from the reference are missing)
    0 = missing the bulk of the key information
- hallucination (integer 0-1):
    1 = grounded (no fabricated content; every claim either matches the reference or correctly admits no evidence)
    0 = hallucinated (introduces facts, names, dates, or numbers not present in the reference)

Output ONLY a single JSON object with this exact shape, nothing else (no prose, no code fences):
{"correctness": <0-3>, "completeness": <0-2>, "hallucination": <0-1>, "reasoning": "<one-line justification, ≤200 chars>"}`;

export interface LlmJudgeConfig {
    /** Override the system prompt. Default: LLM_JUDGE_SYSTEM_PROMPT. */
    systemPrompt?: string;
    /** Temperature for scoring. Default: 0 (deterministic). */
    temperature?: number;
    /** Max tokens for the judge response. Default: 400. */
    maxTokens?: number;
}

/**
 * Wrap any GeneratorModel into a JudgeModel.
 *
 * Usage:
 * ```ts
 * const judge = new LlmJudge(new OpenAiGeneratorModel({ model: 'gpt-4o' }));
 * const score = await judge.score(question, referenceAnswer, systemAnswer);
 * ```
 */
export class LlmJudge implements JudgeModel {
    private readonly _systemPrompt: string;
    private readonly _temperature: number;
    private readonly _maxTokens: number;

    constructor(
        private readonly model: GeneratorModel,
        config: LlmJudgeConfig = {},
    ) {
        this._systemPrompt = config.systemPrompt ?? LLM_JUDGE_SYSTEM_PROMPT;
        this._temperature = config.temperature ?? 0;
        this._maxTokens = config.maxTokens ?? 400;
    }

    async score(
        question: string,
        referenceAnswer: string,
        systemAnswer: string,
    ): Promise<JudgeScore> {
        const userMessage = formatJudgeInputs(question, referenceAnswer, systemAnswer);
        const result = await this.model.complete(this._systemPrompt, userMessage, {
            temperature: this._temperature,
            maxTokens: this._maxTokens,
        });
        return parseJudgeOutput(result.text);
    }
}

/**
 * Format the question, reference answer, and system answer for the judge
 * model. Exposed for testing.
 */
export function formatJudgeInputs(
    question: string,
    referenceAnswer: string,
    systemAnswer: string,
): string {
    const lines: string[] = [];
    lines.push('QUESTION:');
    lines.push(question);
    lines.push('');
    lines.push('REFERENCE ANSWER:');
    lines.push(referenceAnswer);
    lines.push('');
    lines.push('SYSTEM ANSWER:');
    lines.push(systemAnswer);
    lines.push('');
    lines.push('Output the JSON score object now.');
    return lines.join('\n');
}

/**
 * Parse a JudgeScore from the model's textual output. Tolerant of:
 *   - leading/trailing whitespace and prose
 *   - ```json ... ``` code fences
 *   - missing `reasoning` field
 *
 * Throws on:
 *   - no JSON object found
 *   - score values outside the documented ranges
 *
 * Exposed for testing.
 */
export function parseJudgeOutput(text: string): JudgeScore {
    const obj = extractJsonObject(text);
    if (obj === null) {
        throw new Error(`Judge output did not contain a JSON object: ${truncate(text, 200)}`);
    }
    const correctness = clampInt(obj.correctness, 0, 3, 'correctness');
    const completeness = clampInt(obj.completeness, 0, 2, 'completeness');
    const hallucination = clampInt(obj.hallucination, 0, 1, 'hallucination');
    const score: JudgeScore = { correctness, completeness, hallucination };
    if (typeof obj.reasoning === 'string' && obj.reasoning.length > 0) {
        score.reasoning = obj.reasoning;
    }
    return score;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): Record<string, unknown> | null {
    // Strip ```json ... ``` fences if present
    let body = text.trim();
    const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenceMatch && fenceMatch[1]) body = fenceMatch[1].trim();

    // Try direct parse
    try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // fall through
    }

    // Fall back: locate the first {...} block in the text and try to parse it
    const start = body.indexOf('{');
    if (start === -1) return null;
    // Find the matching closing brace by scanning depth (ignores braces inside strings)
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const candidate = body.substring(start, i + 1);
                try {
                    const parsed = JSON.parse(candidate);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function clampInt(value: unknown, min: number, max: number, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Judge output field '${field}' is not a number: ${JSON.stringify(value)}`);
    }
    const n = Math.round(value);
    if (n < min || n > max) {
        throw new Error(`Judge output field '${field}' out of range [${min}, ${max}]: ${n}`);
    }
    return n;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.substring(0, max) + '…';
}
