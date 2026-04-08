/**
 * Conversation Generator — Pass 2 of the generation pipeline.
 *
 * Takes generated daily memory logs and produces synthetic conversations
 * that would have resulted in those logs. Each conversation is a multi-turn
 * dialogue between the persona and an AI assistant.
 *
 * This pass is fully parallel — every day's conversation can be generated
 * independently since the daily log is the constraint.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
    ConversationGeneratorConfig,
    ConversationGenerationResult,
    ConversationTurn,
    GeneratedConversation,
    GeneratorModel,
    PersonaDefinition,
} from './generator-types.js';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONVERSATION_SYSTEM_PROMPT = `You are a conversation generator for a synthetic benchmark dataset. Given a daily memory log written by a persona, you produce a realistic multi-turn conversation between the persona and an AI assistant that would have resulted in the memory log being created.

Rules:
1. The conversation must be consistent with the daily log — all facts, decisions, and events in the log should be naturally discussed or referenced.
2. The persona speaks in their natural voice and communication style.
3. The AI assistant is helpful, knowledgeable, and contextually appropriate.
4. Include 4-12 conversation turns (a turn = one user message + one assistant response).
5. Not everything in the log needs to come from the conversation — some entries are the persona's own observations.
6. The conversation should feel natural, not like a forced extraction of log content.

Output format — a JSON array of turns:
[
  {"role": "user", "content": "..."},
  {"role": "assistant", "content": "..."},
  ...
]

Output ONLY the JSON array. No markdown fences, no explanation.`;

function buildConversationPrompt(persona: PersonaDefinition, dayNumber: number, calendarDate: string, dayLog: string): string {
    return `Generate a conversation for this persona's day.

Persona: ${persona.name}
Role: ${persona.role}
Domain: ${persona.domain}
Company: ${persona.company}
Communication style: ${persona.communication_style.trim()}

Day ${dayNumber} (${calendarDate})

Daily memory log:
---
${dayLog.trim()}
---

Generate a realistic conversation between ${persona.name} and an AI assistant that is consistent with this daily log. The conversation should feel natural and cover the key topics/events from the log.

Output ONLY a JSON array of turns: [{"role":"user","content":"..."},{"role":"assistant","content":"..."},...].`;
}

// ---------------------------------------------------------------------------
// ConversationGenerator
// ---------------------------------------------------------------------------

export class ConversationGenerator {
    private persona: PersonaDefinition;
    private model: GeneratorModel;
    private config: Required<Omit<ConversationGeneratorConfig, 'onConversation'>> & Pick<ConversationGeneratorConfig, 'onConversation'>;

    constructor(
        persona: PersonaDefinition,
        model: GeneratorModel,
        config: ConversationGeneratorConfig = {},
    ) {
        this.persona = persona;
        this.model = model;
        this.config = {
            temperature: config.temperature ?? 0.7,
            maxTokens: config.maxTokens ?? 4000,
            startDay: config.startDay ?? 1,
            endDay: config.endDay ?? 1000,
            onConversation: config.onConversation,
        };
    }

    /**
     * Generate conversations for all days from a directory of day log files.
     * Reads day-NNNN.md files from the input directory.
     */
    async generateAll(dayLogsDir: string): Promise<ConversationGenerationResult> {
        const conversations: GeneratedConversation[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        for (let dayNumber = this.config.startDay; dayNumber <= this.config.endDay; dayNumber++) {
            const padded = String(dayNumber).padStart(4, '0');
            const filePath = join(dayLogsDir, `day-${padded}.md`);

            let dayLog: string;
            try {
                dayLog = await readFile(filePath, 'utf-8');
            } catch {
                // Skip days that don't have log files
                continue;
            }

            const result = await this.generateConversation(dayNumber, dayLog);
            conversations.push(result);
            totalInputTokens += result.inputTokens ?? 0;
            totalOutputTokens += result.outputTokens ?? 0;

            if (this.config.onConversation) {
                const content = serializeConversation(result.turns);
                await this.config.onConversation(dayNumber, content);
            }
        }

        return {
            personaId: this.persona.id,
            conversations,
            totalInputTokens,
            totalOutputTokens,
        };
    }

    /**
     * Generate a conversation for a single day given its log content.
     */
    async generateConversation(dayNumber: number, dayLog: string): Promise<GeneratedConversation> {
        const calendarDate = extractDateFromLog(dayLog) ?? `day-${dayNumber}`;

        const result = await this.model.complete(
            CONVERSATION_SYSTEM_PROMPT,
            buildConversationPrompt(this.persona, dayNumber, calendarDate, dayLog),
            { maxTokens: this.config.maxTokens, temperature: this.config.temperature },
        );

        const turns = parseConversationJson(result.text);

        return {
            dayNumber,
            calendarDate,
            turns,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
        };
    }
}

// ---------------------------------------------------------------------------
// Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the date from a day log's YAML frontmatter.
 */
function extractDateFromLog(log: string): string | undefined {
    const match = log.match(/^date:\s*"?(\d{4}-\d{2}-\d{2})"?\s*$/m);
    return match?.[1];
}

/**
 * Parse LLM output as an array of conversation turns.
 * Handles markdown fences and minor formatting issues.
 */
export function parseConversationJson(text: string): ConversationTurn[] {
    // Strip markdown fences if present
    let cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Find the JSON array boundaries
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) {
        return [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello! How can I help you today?' }];
    }
    cleaned = cleaned.slice(start, end + 1);

    try {
        const parsed = JSON.parse(cleaned) as Array<{ role: string; content: string }>;
        return parsed
            .filter(t => t.role === 'user' || t.role === 'assistant')
            .map(t => ({ role: t.role as 'user' | 'assistant', content: String(t.content) }));
    } catch {
        return [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello! How can I help you today?' }];
    }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize conversation turns to a markdown-formatted string.
 */
export function serializeConversation(turns: ConversationTurn[]): string {
    const lines: string[] = [];
    for (const turn of turns) {
        const label = turn.role === 'user' ? '**User**' : '**Assistant**';
        lines.push(`${label}:`);
        lines.push('');
        lines.push(turn.content);
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * Serialize conversation turns to a JSON string.
 */
export function serializeConversationJson(turns: ConversationTurn[]): string {
    return JSON.stringify(turns, null, 2);
}
