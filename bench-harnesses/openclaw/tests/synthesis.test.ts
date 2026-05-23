import { describe, it, expect } from 'vitest';
import { assembleContext, synthesizeAnswer, SYNTHESIS_SYSTEM_PROMPT } from '../src/synthesis.js';
import type { MemorySearchResult } from "@openclaw/memory-core/runtime-api.js";
import type { SynthesisModel } from '../src/synthesis.js';

function hit(path: string, score: number, snippet: string): MemorySearchResult {
    return {
        path,
        startLine: 1,
        endLine: 1,
        score,
        snippet,
        source: 'memory',
    };
}

class RecordingModel implements SynthesisModel {
    public lastSystem: string | null = null;
    public lastUser: string | null = null;
    public lastOptions: { temperature?: number; maxTokens?: number } | undefined;
    constructor(private readonly response: string) {}
    async complete(
        systemPrompt: string,
        userMessage: string,
        options?: { temperature?: number; maxTokens?: number },
    ): Promise<{ text: string }> {
        this.lastSystem = systemPrompt;
        this.lastUser = userMessage;
        this.lastOptions = options;
        return { text: this.response };
    }
}

describe('assembleContext', () => {
    it('orders blocks by descending score and labels by date from path', () => {
        const ctx = assembleContext([
            hit('memory/2026-01-10.md', 0.5, 'lower'),
            hit('memory/2026-03-15.md', 0.9, 'higher'),
            hit('memory/2026-02-01.md', 0.7, 'middle'),
        ]);
        const lines = ctx.split('\n');
        expect(lines[0]).toBe('[2026-03-15] (score: 0.90)');
        expect(ctx.indexOf('higher')).toBeLessThan(ctx.indexOf('middle'));
        expect(ctx.indexOf('middle')).toBeLessThan(ctx.indexOf('lower'));
    });

    it('falls back gracefully when path has no date component', () => {
        const ctx = assembleContext([hit('memory/intro.md', 0.4, 'note')]);
        expect(ctx).toContain('[intro]');
    });

    it('truncates to fit under the context cap', () => {
        const big = 'x'.repeat(20_000);
        const ctx = assembleContext([
            hit('memory/2026-01-01.md', 0.9, big),
            hit('memory/2026-01-02.md', 0.8, big),
            hit('memory/2026-01-03.md', 0.7, big),
        ]);
        // Two 20k snippets ≈ 40k > 24k cap, so at most two should fit.
        // The third must be dropped.
        expect(ctx).not.toContain('[2026-01-03]');
        expect(ctx.length).toBeLessThanOrEqual(24_000 + 200);
    });
});

describe('synthesizeAnswer', () => {
    it('skips the LLM and returns the canned not-enough-info reply on empty results', async () => {
        const model = new RecordingModel('SHOULD NOT BE CALLED');
        const answer = await synthesizeAnswer(model, 'What did I do on Tuesday?', []);
        expect(answer).toMatch(/don't have enough information/i);
        expect(model.lastSystem).toBeNull();
    });

    it('calls the model with the standard system prompt and returns its text trimmed', async () => {
        const model = new RecordingModel('  The deposition was on March 15.  ');
        const answer = await synthesizeAnswer(model, 'When was the deposition?', [
            hit('memory/2026-03-15.md', 0.9, 'Deposition scheduled at 10am.'),
        ]);
        expect(answer).toBe('The deposition was on March 15.');
        expect(model.lastSystem).toBe(SYNTHESIS_SYSTEM_PROMPT);
        expect(model.lastUser).toContain('Question: When was the deposition?');
        expect(model.lastUser).toContain('[2026-03-15]');
        expect(model.lastUser).toContain('Deposition scheduled');
    });

    it('passes deterministic temperature and a sane max-tokens default', async () => {
        const model = new RecordingModel('answer');
        await synthesizeAnswer(model, 'q', [hit('memory/2026-01-01.md', 0.5, 's')]);
        expect(model.lastOptions?.temperature).toBe(0);
        expect(model.lastOptions?.maxTokens).toBe(600);
    });

    it('honors per-call temperature and maxTokens overrides', async () => {
        const model = new RecordingModel('answer');
        await synthesizeAnswer(model, 'q', [hit('memory/2026-01-01.md', 0.5, 's')], {
            temperature: 0.3,
            maxTokens: 1200,
        });
        expect(model.lastOptions?.temperature).toBe(0.3);
        expect(model.lastOptions?.maxTokens).toBe(1200);
    });
});
