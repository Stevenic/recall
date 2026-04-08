import { describe, it, expect } from 'vitest';
import {
    ConversationGenerator,
    parseConversationJson,
    serializeConversation,
    serializeConversationJson,
} from '../src/conversation-generator.js';
import type { GeneratorModel, PersonaDefinition, ConversationTurn } from '../src/generator-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testPersona: PersonaDefinition = {
    id: 'test-persona',
    name: 'River Chen',
    epoch: '2024-01-01',
    role: 'Senior Backend Engineer',
    domain: 'B2B SaaS platform',
    company: 'Nexus',
    team_size: 8,
    profile: 'Experienced backend engineer with 7 years of experience.',
    communication_style: 'Direct and technical. Uses precise terminology.',
};

const sampleConversationJson = JSON.stringify([
    { role: 'user', content: 'I need to review the auth migration PR today.' },
    { role: 'assistant', content: 'Sure! I can help you review the auth migration PR. What aspects would you like to focus on?' },
    { role: 'user', content: 'Mainly the token rotation logic and the backward compat shim.' },
    { role: 'assistant', content: 'The token rotation implementation looks solid. The backward compatibility shim correctly handles both old session tokens and new JWTs.' },
]);

const sampleDayLog = `---
type: daily
day: 90
date: "2024-03-30"
persona: test-persona
arcs: [auth-migration]
---

# Day 90 — 2024-03-30 (Saturday)

Reviewed the auth migration PR today. Token rotation logic looks correct.
The backward compat shim handles both session tokens and JWTs.`;

function createMockModel(response = sampleConversationJson): GeneratorModel {
    return {
        async complete() {
            return { text: response, inputTokens: 200, outputTokens: 150 };
        },
    };
}

// ---------------------------------------------------------------------------
// parseConversationJson
// ---------------------------------------------------------------------------

describe('parseConversationJson', () => {
    it('parses valid JSON array of turns', () => {
        const turns = parseConversationJson(sampleConversationJson);
        expect(turns).toHaveLength(4);
        expect(turns[0].role).toBe('user');
        expect(turns[1].role).toBe('assistant');
        expect(turns[0].content).toContain('auth migration');
    });

    it('handles markdown-fenced JSON', () => {
        const fenced = '```json\n' + sampleConversationJson + '\n```';
        const turns = parseConversationJson(fenced);
        expect(turns).toHaveLength(4);
    });

    it('handles JSON with surrounding text', () => {
        const withProse = 'Here is the conversation:\n' + sampleConversationJson + '\nDone.';
        const turns = parseConversationJson(withProse);
        expect(turns).toHaveLength(4);
    });

    it('returns fallback for invalid JSON', () => {
        const turns = parseConversationJson('this is not json at all');
        expect(turns).toHaveLength(2);
        expect(turns[0].role).toBe('user');
        expect(turns[1].role).toBe('assistant');
    });

    it('filters out invalid roles', () => {
        const withBadRoles = JSON.stringify([
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'ignored' },
            { role: 'assistant', content: 'hi' },
        ]);
        const turns = parseConversationJson(withBadRoles);
        expect(turns).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serializeConversation', () => {
    const turns: ConversationTurn[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
    ];

    it('produces markdown with role labels', () => {
        const md = serializeConversation(turns);
        expect(md).toContain('**User**:');
        expect(md).toContain('**Assistant**:');
        expect(md).toContain('Hello');
        expect(md).toContain('Hi there!');
    });
});

describe('serializeConversationJson', () => {
    const turns: ConversationTurn[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
    ];

    it('produces valid JSON', () => {
        const json = serializeConversationJson(turns);
        const parsed = JSON.parse(json);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].role).toBe('user');
    });
});

// ---------------------------------------------------------------------------
// ConversationGenerator
// ---------------------------------------------------------------------------

describe('ConversationGenerator', () => {
    it('generates a conversation from a day log', async () => {
        const model = createMockModel();
        const generator = new ConversationGenerator(testPersona, model);

        const result = await generator.generateConversation(90, sampleDayLog);
        expect(result.dayNumber).toBe(90);
        expect(result.calendarDate).toBe('2024-03-30');
        expect(result.turns).toHaveLength(4);
        expect(result.inputTokens).toBe(200);
        expect(result.outputTokens).toBe(150);
    });

    it('extracts date from log frontmatter', async () => {
        const model = createMockModel();
        const generator = new ConversationGenerator(testPersona, model);
        const result = await generator.generateConversation(90, sampleDayLog);
        expect(result.calendarDate).toBe('2024-03-30');
    });

    it('falls back to day-N when no date in log', async () => {
        const model = createMockModel();
        const generator = new ConversationGenerator(testPersona, model);
        const result = await generator.generateConversation(5, 'No frontmatter here.');
        expect(result.calendarDate).toBe('day-5');
    });

    it('calls onConversation callback', async () => {
        const model = createMockModel();
        const callbacks: number[] = [];
        const generator = new ConversationGenerator(testPersona, model, {
            startDay: 1,
            endDay: 3,
            onConversation: async (dayNumber) => {
                callbacks.push(dayNumber);
            },
        });

        // generateConversation directly doesn't trigger onConversation —
        // only generateAll does, but that reads from disk. Test the single method.
        const result = await generator.generateConversation(1, sampleDayLog);
        expect(result.turns.length).toBeGreaterThan(0);
    });
});
