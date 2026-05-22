import { describe, expect, it } from 'vitest';
import { LlmJudge, formatJudgeInputs, parseJudgeOutput, LLM_JUDGE_SYSTEM_PROMPT, LLM_JUDGE_GROUNDED_SYSTEM_PROMPT, LLM_JUDGE_BOUNDARY_SYSTEM_PROMPT, } from '../src/llm-judge.js';
class StubModel {
    response;
    captured = {};
    constructor(response) {
        this.response = response;
    }
    async complete(systemPrompt, userMessage, options) {
        this.captured = { systemPrompt, userMessage, options };
        return { text: this.response };
    }
}
describe('formatJudgeInputs', () => {
    it('includes question, reference, and system answer with labels', () => {
        const out = formatJudgeInputs('Q?', 'REF', 'SYS');
        expect(out).toContain('QUESTION:\nQ?');
        expect(out).toContain('REFERENCE ANSWER:\nREF');
        expect(out).toContain('SYSTEM ANSWER:\nSYS');
        expect(out).not.toContain('MEMORY CONTEXT');
    });
    it('prepends MEMORY CONTEXT when context is provided', () => {
        const out = formatJudgeInputs('Q?', 'REF', 'SYS', {
            memoryExcerpts: '--- DAY 5 ---\nfoo bar',
        });
        expect(out.indexOf('MEMORY CONTEXT')).toBeLessThan(out.indexOf('QUESTION:'));
        expect(out).toContain('--- DAY 5 ---\nfoo bar');
    });
    it('treats empty/whitespace memoryExcerpts as no context', () => {
        const out = formatJudgeInputs('Q?', 'REF', 'SYS', { memoryExcerpts: '   ' });
        expect(out).not.toContain('MEMORY CONTEXT');
    });
});
describe('LlmJudge prompt selection', () => {
    it('uses reference-only prompt when no context is supplied', async () => {
        const stub = new StubModel('{"correctness":3,"completeness":2,"hallucination":1}');
        const judge = new LlmJudge(stub);
        await judge.score('Q?', 'REF', 'SYS');
        expect(stub.captured.systemPrompt).toBe(LLM_JUDGE_SYSTEM_PROMPT);
        expect(stub.captured.userMessage).not.toContain('MEMORY CONTEXT');
    });
    it('uses grounded prompt and threads context when memoryExcerpts are present', async () => {
        const stub = new StubModel('{"correctness":3,"completeness":2,"hallucination":1}');
        const judge = new LlmJudge(stub);
        await judge.score('Q?', 'REF', 'SYS', { memoryExcerpts: '--- DAY 7 ---\nthe content' });
        expect(stub.captured.systemPrompt).toBe(LLM_JUDGE_GROUNDED_SYSTEM_PROMPT);
        expect(stub.captured.userMessage).toContain('MEMORY CONTEXT');
        expect(stub.captured.userMessage).toContain('--- DAY 7 ---');
    });
    it('uses boundary prompt when expectedDisclosure is present and surfaces ACL fields', async () => {
        const stub = new StubModel('{"correctness":3,"completeness":2,"hallucination":1}');
        const judge = new LlmJudge(stub);
        await judge.score('Q?', 'REF', 'SYS', {
            memoryExcerpts: '--- DAY 5 ---\nsensitive content',
            expectedDisclosure: 'refuse',
            querySession: 'principal',
            forbiddenSessions: ['legal-deposition'],
        });
        expect(stub.captured.systemPrompt).toBe(LLM_JUDGE_BOUNDARY_SYSTEM_PROMPT);
        expect(stub.captured.userMessage).toContain('EXPECTED DISCLOSURE: refuse');
        expect(stub.captured.userMessage).toContain('QUERY SESSION: principal');
        expect(stub.captured.userMessage).toContain('FORBIDDEN SESSIONS: legal-deposition');
        // Grounding context still flows through.
        expect(stub.captured.userMessage).toContain('MEMORY CONTEXT');
    });
});
describe('parseJudgeOutput', () => {
    it('parses a clean JSON object', () => {
        const score = parseJudgeOutput('{"correctness": 3, "completeness": 2, "hallucination": 1, "reasoning": "matches reference exactly"}');
        expect(score).toEqual({
            correctness: 3,
            completeness: 2,
            hallucination: 1,
            reasoning: 'matches reference exactly',
        });
    });
    it('strips ```json fences', () => {
        const score = parseJudgeOutput('```json\n{"correctness": 1, "completeness": 0, "hallucination": 0}\n```');
        expect(score.correctness).toBe(1);
        expect(score.completeness).toBe(0);
        expect(score.hallucination).toBe(0);
        expect(score.reasoning).toBeUndefined();
    });
    it('finds embedded JSON when surrounded by prose', () => {
        const text = 'Here is my evaluation: {"correctness": 2, "completeness": 1, "hallucination": 1, "reasoning": "minor gap"} Done.';
        const score = parseJudgeOutput(text);
        expect(score.correctness).toBe(2);
        expect(score.completeness).toBe(1);
        expect(score.reasoning).toBe('minor gap');
    });
    it('rounds non-integer numeric scores to nearest int', () => {
        const score = parseJudgeOutput('{"correctness": 2.4, "completeness": 1.6, "hallucination": 1}');
        expect(score.correctness).toBe(2);
        expect(score.completeness).toBe(2);
        expect(score.hallucination).toBe(1);
    });
    it('throws on out-of-range scores', () => {
        expect(() => parseJudgeOutput('{"correctness": 4, "completeness": 2, "hallucination": 1}'))
            .toThrow(/correctness.*out of range/);
        expect(() => parseJudgeOutput('{"correctness": -1, "completeness": 0, "hallucination": 0}'))
            .toThrow(/correctness.*out of range/);
    });
    it('throws when no JSON object is present', () => {
        expect(() => parseJudgeOutput('I cannot evaluate this.')).toThrow(/did not contain a JSON object/);
    });
    it('throws on missing or non-numeric required fields', () => {
        expect(() => parseJudgeOutput('{"correctness": "high", "completeness": 1, "hallucination": 1}'))
            .toThrow(/correctness.*not a number/);
    });
});
describe('LlmJudge', () => {
    it('drives the underlying model with the judge system prompt at temperature 0', async () => {
        const model = new StubModel('{"correctness": 3, "completeness": 2, "hallucination": 1, "reasoning": "ok"}');
        const judge = new LlmJudge(model);
        const score = await judge.score('Q?', 'REF', 'SYS');
        expect(model.captured.systemPrompt).toBe(LLM_JUDGE_SYSTEM_PROMPT);
        expect(model.captured.userMessage).toContain('Q?');
        expect(model.captured.userMessage).toContain('REF');
        expect(model.captured.userMessage).toContain('SYS');
        expect(model.captured.options?.temperature).toBe(0);
        expect(model.captured.options?.maxTokens).toBe(400);
        expect(score).toEqual({ correctness: 3, completeness: 2, hallucination: 1, reasoning: 'ok' });
    });
    it('honors a custom system prompt + temperature override', async () => {
        const model = new StubModel('{"correctness": 0, "completeness": 0, "hallucination": 0}');
        const judge = new LlmJudge(model, { systemPrompt: 'CUSTOM', temperature: 0.2, maxTokens: 100 });
        await judge.score('Q', 'R', 'S');
        expect(model.captured.systemPrompt).toBe('CUSTOM');
        expect(model.captured.options?.temperature).toBe(0.2);
        expect(model.captured.options?.maxTokens).toBe(100);
    });
    it('propagates parse errors from malformed model output', async () => {
        const model = new StubModel('I refuse to score this answer.');
        const judge = new LlmJudge(model);
        await expect(judge.score('Q', 'R', 'S')).rejects.toThrow(/did not contain a JSON object/);
    });
});
//# sourceMappingURL=llm-judge.test.js.map