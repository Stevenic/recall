import { describe, expect, it } from 'vitest';
import {
    OpenAiGeneratorModel,
    isOpenAiSpec,
    parseOpenAiSpec,
    OPENAI_DEFAULT_MODEL,
    OPENAI_PREFIX,
    type OpenAiClientLike,
} from '../src/openai-generator-model.js';

describe('isOpenAiSpec', () => {
    it('matches the bare openai shorthand', () => {
        expect(isOpenAiSpec('openai')).toBe(true);
    });
    it('matches openai:<model-id> specifiers', () => {
        expect(isOpenAiSpec('openai:gpt-4o')).toBe(true);
        expect(isOpenAiSpec('openai:gpt-4o-mini')).toBe(true);
        expect(isOpenAiSpec('openai:o3-mini')).toBe(true);
    });
    it('does not match other names', () => {
        expect(isOpenAiSpec('claude')).toBe(false);
        expect(isOpenAiSpec('codex')).toBe(false);
        expect(isOpenAiSpec('./model.js')).toBe(false);
        expect(isOpenAiSpec('openai-something')).toBe(false); // no colon
        expect(isOpenAiSpec('')).toBe(false);
    });
});

describe('parseOpenAiSpec', () => {
    it('returns the default model for the bare openai shorthand', () => {
        expect(parseOpenAiSpec('openai')).toEqual({ model: OPENAI_DEFAULT_MODEL });
        expect(OPENAI_PREFIX).toBe('openai');
    });
    it('extracts the model id after the colon', () => {
        expect(parseOpenAiSpec('openai:gpt-4o')).toEqual({ model: 'gpt-4o' });
        expect(parseOpenAiSpec('openai:gpt-5')).toEqual({ model: 'gpt-5' });
        expect(parseOpenAiSpec('openai:o3-mini')).toEqual({ model: 'o3-mini' });
    });
    it('throws on an empty model id after the colon', () => {
        expect(() => parseOpenAiSpec('openai:')).toThrow(/missing model id/);
        expect(() => parseOpenAiSpec('openai:   ')).toThrow(/missing model id/);
    });
    it('throws on non-openai specs', () => {
        expect(() => parseOpenAiSpec('claude')).toThrow(/Not an OpenAI spec/);
    });
});

describe('OpenAiGeneratorModel.complete', () => {
    function makeMockClient(captured: { params?: unknown }) {
        const client: OpenAiClientLike = {
            chat: {
                // The SDK's create() type is heavy; cast through unknown.
                completions: {
                    create: (async (params: unknown) => {
                        captured.params = params;
                        return {
                            choices: [
                                { message: { content: '  hello world  ' } },
                            ],
                            usage: { prompt_tokens: 17, completion_tokens: 4 },
                        };
                    }) as unknown,
                } as unknown,
            } as unknown,
        } as OpenAiClientLike;
        return client;
    }

    it('passes system+user messages with the configured model id', async () => {
        const captured: { params?: unknown } = {};
        const model = new OpenAiGeneratorModel({ model: 'gpt-4o', client: makeMockClient(captured) });

        const result = await model.complete('SYS', 'USER', { temperature: 0.4, maxTokens: 256 });

        const params = captured.params as {
            model: string;
            messages: Array<{ role: string; content: string }>;
            temperature?: number;
            max_completion_tokens?: number;
        };
        expect(params.model).toBe('gpt-4o');
        expect(params.messages).toEqual([
            { role: 'system', content: 'SYS' },
            { role: 'user', content: 'USER' },
        ]);
        expect(params.temperature).toBe(0.4);
        expect(params.max_completion_tokens).toBe(256);
        expect(result.text).toBe('hello world');  // trimmed
        expect(result.inputTokens).toBe(17);
        expect(result.outputTokens).toBe(4);
    });

    it('uses the default model when none is specified', async () => {
        const captured: { params?: unknown } = {};
        const model = new OpenAiGeneratorModel({ client: makeMockClient(captured) });
        await model.complete('SYS', 'USER');
        const params = captured.params as { model: string };
        expect(params.model).toBe(OPENAI_DEFAULT_MODEL);
        expect(model.model).toBe(OPENAI_DEFAULT_MODEL);
    });

    it('omits temperature/max_completion_tokens when not supplied', async () => {
        const captured: { params?: unknown } = {};
        const model = new OpenAiGeneratorModel({ client: makeMockClient(captured) });
        await model.complete('SYS', 'USER');
        const params = captured.params as Record<string, unknown>;
        expect(params).not.toHaveProperty('temperature');
        expect(params).not.toHaveProperty('max_tokens');
        expect(params).not.toHaveProperty('max_completion_tokens');
    });

    it('throws when no API key is available and no client is supplied', () => {
        const original = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;
        try {
            expect(() => new OpenAiGeneratorModel({})).toThrow(/OpenAI API key not found/);
        } finally {
            if (original !== undefined) process.env.OPENAI_API_KEY = original;
        }
    });
});
