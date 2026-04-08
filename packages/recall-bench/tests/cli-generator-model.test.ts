import { describe, it, expect } from 'vitest';
import { CliGeneratorModel, isCliAgentName, CLI_AGENT_NAMES } from '../src/cli-generator-model.js';

describe('isCliAgentName', () => {
    it('returns true for known agents', () => {
        expect(isCliAgentName('claude')).toBe(true);
        expect(isCliAgentName('codex')).toBe(true);
        expect(isCliAgentName('copilot')).toBe(true);
    });

    it('returns false for unknown names', () => {
        expect(isCliAgentName('gpt')).toBe(false);
        expect(isCliAgentName('./my-model.js')).toBe(false);
        expect(isCliAgentName('')).toBe(false);
    });
});

describe('CLI_AGENT_NAMES', () => {
    it('contains all three agents', () => {
        expect(CLI_AGENT_NAMES).toContain('claude');
        expect(CLI_AGENT_NAMES).toContain('codex');
        expect(CLI_AGENT_NAMES).toContain('copilot');
        expect(CLI_AGENT_NAMES).toHaveLength(3);
    });
});

describe('CliGeneratorModel', () => {
    it('constructs with a known agent name', () => {
        const model = new CliGeneratorModel({ agent: 'claude' });
        expect(model).toBeDefined();
    });

    it('constructs with a custom command', () => {
        const model = new CliGeneratorModel({ agent: 'my-llm-cli', args: ['--flag'] });
        expect(model).toBeDefined();
    });

    it('implements the GeneratorModel interface (complete method exists)', () => {
        const model = new CliGeneratorModel({ agent: 'claude' });
        expect(typeof model.complete).toBe('function');
    });

    it('spawns a process and captures stdout', async () => {
        // Use echo as a trivial "agent" that just prints the stdin back
        const model = new CliGeneratorModel({
            agent: process.platform === 'win32' ? 'cmd' : 'cat',
            args: process.platform === 'win32' ? ['/c', 'findstr', '.*'] : [],
            stdinPrompt: true,
            timeout: 5000,
        });

        const result = await model.complete('system prompt', 'hello world');
        expect(result.text).toContain('hello world');
    });

    it('returns error for non-existent command', async () => {
        const model = new CliGeneratorModel({
            agent: 'this-command-does-not-exist-xyz-12345',
            stdinPrompt: true,
            timeout: 5000,
        });

        await expect(model.complete('sys', 'msg')).rejects.toThrow();
    });
});
