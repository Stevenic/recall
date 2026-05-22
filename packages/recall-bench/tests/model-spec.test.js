import { describe, it, expect } from 'vitest';
import { parseModelSpec, isModelSpec, createModelFromSpec } from '../src/model-spec.js';
describe('parseModelSpec', () => {
    it('parses a bare provider:model spec', () => {
        expect(parseModelSpec('openai:gpt-4o-mini')).toEqual({
            provider: 'openai',
            model: 'gpt-4o-mini',
        });
    });
    it('parses an anthropic spec', () => {
        expect(parseModelSpec('anthropic:claude-sonnet-4-6')).toEqual({
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
        });
    });
    it('parses a spec with an endpoint after the semicolon', () => {
        expect(parseModelSpec('azure:gpt-4o;https://my-resource.openai.azure.com')).toEqual({
            provider: 'azure',
            model: 'gpt-4o',
            endpoint: 'https://my-resource.openai.azure.com',
        });
    });
    it('preserves colons inside endpoint URLs', () => {
        expect(parseModelSpec('openai:gpt-4o-mini;https://api.openai.com:8443/v1')).toEqual({
            provider: 'openai',
            model: 'gpt-4o-mini',
            endpoint: 'https://api.openai.com:8443/v1',
        });
    });
    it('treats an empty endpoint after the semicolon as undefined', () => {
        expect(parseModelSpec('openai:gpt-4o;')).toEqual({
            provider: 'openai',
            model: 'gpt-4o',
        });
    });
    it('lowercases the provider', () => {
        expect(parseModelSpec('OpenAI:gpt-4o').provider).toBe('openai');
    });
    it('throws on unknown provider', () => {
        expect(() => parseModelSpec('cohere:command-r')).toThrow(/Unknown model provider/);
    });
    it('throws on missing colon', () => {
        expect(() => parseModelSpec('gpt-4o-mini')).toThrow(/Expected/);
    });
    it('throws on empty model', () => {
        expect(() => parseModelSpec('openai:')).toThrow(/Expected/);
    });
    it('throws on empty input', () => {
        expect(() => parseModelSpec('')).toThrow(/empty/i);
        expect(() => parseModelSpec('   ')).toThrow(/empty/i);
    });
    it('trims whitespace around the spec, model, and endpoint', () => {
        expect(parseModelSpec('  openai : gpt-4o ; https://x  ')).toEqual({
            provider: 'openai',
            model: 'gpt-4o',
            endpoint: 'https://x',
        });
    });
});
describe('isModelSpec', () => {
    it.each([
        ['openai:gpt-4o-mini', true],
        ['anthropic:claude-opus-4-7', true],
        ['azure:my-deploy;https://x.openai.azure.com', true],
        ['./path/to/module.js', false],
        ['claude', false],
        ['', false],
        ['gpt-4o-mini', false],
        ['cohere:command-r', false],
    ])('isModelSpec(%s) = %s', (spec, expected) => {
        expect(isModelSpec(spec)).toBe(expected);
    });
});
describe('createModelFromSpec', () => {
    it('creates an OpenAI model with apiKey from env', () => {
        const model = createModelFromSpec('openai:gpt-4o-mini', {
            env: { OPENAI_API_KEY: 'sk-test' },
        });
        expect(model).toBeDefined();
        // Model id is exposed on the OpenAI implementation via a getter.
        expect(model.model).toBe('gpt-4o-mini');
    });
    it('creates an Anthropic model with apiKey from env', () => {
        const model = createModelFromSpec('anthropic:claude-sonnet-4-6', {
            env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        });
        expect(model.model).toBe('claude-sonnet-4-6');
    });
    it('creates an Azure model with endpoint from spec', () => {
        const model = createModelFromSpec('azure:my-deploy;https://r.openai.azure.com', {
            env: { AZURE_OPENAI_API_KEY: 'k' },
        });
        expect(model.deployment).toBe('my-deploy');
    });
    it('throws on missing API key', () => {
        expect(() => createModelFromSpec('openai:gpt-4o-mini', { env: {} })).toThrow(/OpenAI API key/);
    });
    it('throws on Azure without endpoint', () => {
        expect(() => createModelFromSpec('azure:my-deploy', { env: { AZURE_OPENAI_API_KEY: 'k' } })).toThrow(/endpoint/i);
    });
});
//# sourceMappingURL=model-spec.test.js.map